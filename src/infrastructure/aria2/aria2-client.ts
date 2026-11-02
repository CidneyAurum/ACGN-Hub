import { timeoutSignal } from "@/shared/abort-signals";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type {
  DownloadOptions,
  DownloadStatus,
  DownloadTarget,
  DownloadState,
  DownloadEngineSettings,
  DownloadStage,
} from "@/domain/download";
import type { DownloadEngine } from "@/application/ports";
import { isTauriRuntime } from "@/shared/runtime";
import { assertLocalEndpoint } from "@/shared/validation";

export interface Aria2RpcRequest {
  endpoint: string;
  secret?: string;
  method: string;
  params: unknown[];
  /** A bounded native hint, honored only for the app-owned endpoint and secret. */
  managed?: boolean;
}

export interface Aria2RpcTransport {
  request(request: Aria2RpcRequest): Promise<unknown>;
}

export class TauriAria2Transport implements Aria2RpcTransport {
  async request(request: Aria2RpcRequest): Promise<unknown> {
    return invoke("aria2_rpc", { ...request });
  }
}

export class FetchAria2Transport implements Aria2RpcTransport {
  async request(request: Aria2RpcRequest): Promise<unknown> {
    const params = request.secret
      ? [`token:${request.secret}`, ...request.params]
      : request.params;
    const response = await fetch(request.endpoint, {
      method: "POST",
      signal: timeoutSignal(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: request.method,
        params,
      }),
    });

    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error(response.ok ? "aria2 RPC 返回了无效的 JSON" : `aria2 RPC HTTP ${response.status}`); }
    const parsed = z.object({ result: z.unknown().optional(), error: z.object({ message: z.string().optional() }).optional() }).safeParse(body);
    if (!parsed.success) throw new Error("aria2 RPC 响应格式无效");
    if (parsed.data.error) throw new Error(parsed.data.error.message ?? "aria2 RPC 返回错误");
    if (!response.ok) throw new Error(`aria2 RPC HTTP ${response.status}`);
    if (!("result" in parsed.data)) throw new Error("aria2 RPC 响应缺少 result");
    return parsed.data.result;
  }
}

const numericString = z.string().regex(/^\d+$/).refine((value) => Number.isSafeInteger(Number(value)), "下载计数超出安全范围");
const statusSchema = z.object({
  gid: z.string().optional(), status: z.enum(["active", "waiting", "paused", "complete", "error", "removed"]),
  totalLength: numericString.optional(), completedLength: numericString.optional(),
  downloadSpeed: numericString.optional(), errorCode: z.string().optional(),
  connections: numericString.optional(), numSeeders: numericString.optional(),
  infoHash: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i).optional(),
  verifiedLength: numericString.optional(),
  verifyIntegrityPending: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  bittorrent: z.object({
    info: z.object({ name: z.string().max(4096).optional() }).passthrough().optional(),
    mode: z.enum(["single", "multi"]).optional(),
  }).passthrough().optional(),
  files: z.array(z.object({ path: z.string().optional(), selected: z.union([z.string(), z.boolean()]).optional() }).passthrough()).optional(),
  followedBy: z.array(z.string().regex(/^[a-f0-9]{16}$/i)).optional(),
  errorMessage: z.string().optional(),
}).passthrough();
type Aria2StatusResponse = z.infer<typeof statusSchema>;

const statusMap: Record<string, DownloadState> = {
  active: "downloading",
  // aria2's `waiting` means the task is owned by aria2 but waiting for a
  // slot; mapping it back to the pre-submit queue made the store re-add
  // the same task repeatedly.
  waiting: "downloading",
  paused: "paused",
  complete: "completed",
  error: "failed",
  removed: "cancelled",
};

export class Aria2Client implements DownloadEngine {
  readonly id = "aria2";

  constructor(
    private readonly transport: Aria2RpcTransport,
    private readonly endpoint: string,
    private readonly secret?: string,
    private readonly managed = false,
  ) { assertLocalEndpoint(endpoint, "aria2 RPC"); }

  async probe(): Promise<string> {
    const parsed = z.object({ version: z.string().min(1) }).safeParse(await this.call("aria2.getVersion", []));
    if (!parsed.success) throw new Error("该地址没有返回有效的 aria2 版本，请检查 RPC 地址。");
    return parsed.data.version;
  }

  async add(target: DownloadTarget, options: DownloadOptions): Promise<string> {
    if (target.protocol === "magnet" && !new URL(target.url).searchParams.getAll("xt").some((value) => /^urn:btih:/i.test(value))) {
      throw new Error("此磁力只有 BitTorrent v2 哈希，内置引擎暂不支持。请在设置中选择支持 v2 的 qBittorrent。");
    }
    const addOptions: Record<string, string> = {
      dir: options.directory,
      "check-certificate": "true",
      "user-agent": "ACGN-Hub/0.2",
      "continue": "true",
      "auto-file-renaming": "false",
      "allow-overwrite": "false",
      "max-tries": "5",
      "retry-wait": "3",
      timeout: "60",
      "connect-timeout": "15",
      ...(target.protocol !== "http" ? { "follow-torrent": "mem", "seed-time": "0", "bt-save-metadata": "false", "bt-stop-timeout": "0" } : {}),
      "max-download-limit": String(options.speedLimitBytesPerSecond ?? 0),
    };
    if (options.filename && target.protocol === "http") addOptions.out = options.filename;
    const result = await this.call("aria2.addUri", [[target.url], addOptions]);
    if (typeof result !== "string" || !/^[a-f0-9]{16}$/i.test(result)) throw new Error("aria2 没有返回有效的任务编号，请测试引擎连接。");
    return result;
  }

  async pause(engineTaskId: string): Promise<void> {
    const targets = await this.controlTargets(engineTaskId);
    this.requireUnfinishedTargets(targets);
    for (const item of targets) {
      if (item.status.status === "active" || item.status.status === "waiting") await this.call("aria2.pause", [item.id]);
    }
  }

  async resume(engineTaskId: string): Promise<void> {
    for (const item of await this.controlTargets(engineTaskId)) {
      if (item.status.status === "paused") await this.call("aria2.unpause", [item.id]);
    }
  }

  async cancel(engineTaskId: string): Promise<void> {
    // The followedBy graph is the scope of this task. Never select downloads
    // by directory: unrelated tasks can legitimately write beside this one.
    let targets: Array<{ id: string; status: Aria2StatusResponse }>;
    try { targets = await this.controlTargets(engineTaskId); }
    catch (cause) { if (isTaskNotFoundError(cause)) return; throw cause; }
    this.requireUnfinishedTargets(targets);
    for (const item of targets) {
      if (["active", "waiting", "paused"].includes(item.status.status)) {
        try { await this.call("aria2.forceRemove", [item.id]); }
        catch (cause) { if (!isTaskNotFoundError(cause)) throw cause; }
      }
    }
  }

  private requireUnfinishedTargets(targets: Array<{ id: string; status: Aria2StatusResponse }>): void {
    const leaves = targets.filter((item) => !item.status.followedBy?.length);
    if (leaves.length && leaves.every((item) => item.status.status === "complete")) {
      throw new Error("文件已完成下载，请刷新后查看成品");
    }
  }

  async status(engineTaskId: string, context?: Pick<DownloadTarget, "protocol">): Promise<DownloadStatus> {
    try {
      let currentId = engineTaskId;
      let status = await this.tellStatus(currentId);
      const visited = new Set([currentId]);
      for (let depth = 0; status.followedBy?.length; depth += 1) {
        if (depth >= 16 || visited.has(status.followedBy[0])) throw new Error("aria2 派生任务链异常，已停止解析状态");
        currentId = status.followedBy[0];
        visited.add(currentId);
        status = await this.tellStatus(currentId);
      }
      const result = this.toDownloadStatus(status, context?.protocol, currentId !== engineTaskId);
      return currentId === engineTaskId ? result : { ...result, engineTaskId: currentId, ...(result.files.length === 1 ? { filename: result.files[0].split(/[\\/]/).pop() } : {}) };
    } catch (cause) {
      // Switching from an external aria2 instance to the app-owned one makes
      // persisted GIDs disappear. Report a recoverable state so the store can
      // re-submit the original URL instead of leaving a dead task.
      if (isTaskNotFoundError(cause)) {
        return {
          state: "failed",
          totalBytes: 0,
          completedBytes: 0,
          speedBytesPerSecond: 0,
          files: [],
          errorCode: "ENGINE_TASK_NOT_FOUND",
          error: "aria2 会话中找不到此任务，正在恢复原始链接。",
        };
      }
      throw cause;
    }
  }

  async applySettings(settings: DownloadEngineSettings, engineTaskIds: string[]): Promise<void> {
    if (!Number.isInteger(settings.maxConcurrentDownloads) || settings.maxConcurrentDownloads < 1 || settings.maxConcurrentDownloads > 20 ||
      !Number.isSafeInteger(settings.speedLimitBytesPerSecond) || settings.speedLimitBytesPerSecond < 0 || settings.speedLimitBytesPerSecond > 1024 ** 3 ||
      engineTaskIds.some((id) => !/^[a-f\d]{16}$/i.test(id))) throw new Error("aria2 调度或限速设置无效");
    await this.call("aria2.changeGlobalOption", [{ "max-concurrent-downloads": String(settings.maxConcurrentDownloads) }]);
    const updated = new Set<string>();
    const change = async (item: { id: string; status: Aria2StatusResponse }, resolveTransition = true): Promise<void> => {
      if (updated.has(item.id) || !["active", "waiting", "paused"].includes(item.status.status)) return;
      try { await this.call("aria2.changeOption", [item.id, { "max-download-limit": String(settings.speedLimitBytesPerSecond), "bt-stop-timeout": "0" }]); }
      catch (cause) {
        if (isTaskNotFoundError(cause)) { updated.add(item.id); return; }
        if (resolveTransition && cannotChangeOptionsFor(cause, item.id)) {
          // Metadata may finish between tellStatus and changeOption. Re-read
          // that same task's graph once; genuine active-task option failures
          // must still surface instead of being mistaken for this transition.
          let current: Array<{ id: string; status: Aria2StatusResponse }>;
          try { current = await this.controlTargets(item.id); }
          catch (readCause) { if (isTaskNotFoundError(readCause)) { updated.add(item.id); return; } throw readCause; }
          const successors = current.filter((target) => target.id !== item.id && ["active", "waiting", "paused"].includes(target.status.status));
          const original = current.find((target) => target.id === item.id);
          if (successors.length) {
            for (const successor of successors) await change(successor, false);
            updated.add(item.id); return;
          }
          if (!original || !["active", "waiting", "paused"].includes(original.status.status)) { updated.add(item.id); return; }
        }
        throw cause;
      }
      updated.add(item.id);
    };
    for (const id of engineTaskIds) {
      let targets: Array<{ id: string; status: Aria2StatusResponse }>;
      try { targets = await this.controlTargets(id); }
      catch (cause) { if (isTaskNotFoundError(cause)) continue; throw cause; }
      for (const item of targets) await change(item);
    }
  }

  private async controlTargets(engineTaskId: string): Promise<Array<{ id: string; status: Aria2StatusResponse }>> {
    const targets: Array<{ id: string; status: Aria2StatusResponse }> = [];
    const visited = new Set<string>();
    const visit = async (id: string, depth: number): Promise<void> => {
      if (depth > 16 || visited.size >= 64 || visited.has(id)) throw new Error("aria2 派生任务链异常，无法安全控制任务");
      visited.add(id);
      let status: Aria2StatusResponse;
      try { status = await this.tellStatus(id); }
      catch (cause) { if (depth > 0 && isTaskNotFoundError(cause)) return; throw cause; }
      for (const child of status.followedBy ?? []) await visit(child, depth + 1);
      targets.push({ id, status });
    };
    await visit(engineTaskId, 0);
    return targets;
  }

  private async tellStatus(engineTaskId: string): Promise<Aria2StatusResponse> {
    const result = await this.call("aria2.tellStatus", [
      engineTaskId,
      [
        "gid",
        "status",
        "totalLength",
        "completedLength",
        "downloadSpeed",
        "errorCode",
        "files",
        "errorMessage",
        "followedBy",
        "connections",
        "numSeeders",
        "bittorrent",
        "infoHash",
        "verifiedLength",
        "verifyIntegrityPending",
      ],
    ]);
    const parsed = statusSchema.safeParse(result);
    if (!parsed.success) throw new Error("aria2 返回了无效的下载状态，请检查 RPC 服务。");
    return parsed.data;
  }

  private toDownloadStatus(result: Aria2StatusResponse, protocol?: DownloadTarget["protocol"], followed = false): DownloadStatus {
    const files = (result.files ?? []).flatMap((file) => (
      file.path && file.selected !== "false" && file.selected !== false ? [file.path] : []
    ));
    const totalBytes = Number(result.totalLength ?? 0);
    const completedBytes = Number(result.completedLength ?? 0);
    const isBt = protocol === "magnet" || protocol === "torrent" || Boolean(result.bittorrent || result.infoHash);
    const hasContent = Boolean(result.bittorrent?.info?.name?.trim()) || followed || (totalBytes > 0 && files.some((path) => !/(?:\.torrent|\[METADATA\][^\\/]*)$/i.test(path)) && Boolean(result.bittorrent));
    const fetchingTorrent = protocol === "torrent" && !hasContent;
    const fetchingMetadata = protocol === "magnet" && !hasContent;
    const verifyIntegrityPending = result.verifyIntegrityPending === undefined ? undefined : result.verifyIntegrityPending === true || result.verifyIntegrityPending === "true";
    const verifiedBytes = result.verifiedLength === undefined ? undefined : Number(result.verifiedLength);
    const errorCode = result.errorCode && result.errorCode !== "0" ? result.errorCode : undefined;
    const error = result.errorMessage?.trim() || (errorCode === "7"
      ? "下载未完成（aria2 错误码 7）；请检查节点、连接与引擎状态后重试。"
      : errorCode ? `aria2 下载失败（错误码 ${errorCode}），请检查来源链接与引擎状态。` : undefined);
    let state = statusMap[result.status];
    // A completed metadata HTTP request is not a completed episode. Keep
    // following its parent until aria2 publishes the generated content GID.
    if (state === "completed" && (fetchingTorrent || fetchingMetadata)) state = "downloading";
    let stage: DownloadStage | undefined;
    if (state === "completed") stage = "completed";
    else if (state === "downloading") {
      stage = result.status === "waiting" ? "queued_engine"
        : fetchingTorrent ? "fetching_torrent"
        : fetchingMetadata ? "fetching_metadata"
        : verifyIntegrityPending || (verifiedBytes !== undefined && totalBytes > 0 && verifiedBytes < totalBytes && Number(result.downloadSpeed ?? 0) === 0) ? "checking"
        : Number(result.downloadSpeed ?? 0) > 0 ? "downloading" : "connecting";
    }
    return {
      state,
      ...(stage ? { stage } : {}),
      totalBytes,
      completedBytes,
      speedBytesPerSecond: Number(result.downloadSpeed ?? 0),
      files,
      ...(result.connections === undefined ? {} : { connections: Number(result.connections), ...(isBt ? { peers: Number(result.connections) } : {}) }),
      ...(result.numSeeders === undefined ? {} : { seeders: Number(result.numSeeders) }),
      ...(result.infoHash ? { infoHash: result.infoHash.toLowerCase() } : {}),
      ...(verifiedBytes === undefined ? {} : { verifiedBytes }),
      ...(verifyIntegrityPending === undefined ? {} : { verifyIntegrityPending }),
      ...(error ? { error } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.transport.request({
      endpoint: this.endpoint,
      secret: this.secret,
      method,
      params,
      ...(this.managed ? { managed: true } : {}),
    })) as T;
  }
}

function isTaskNotFoundError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /(?:GID|download task|任务).*(?:not found|不存在)/i.test(message);
}

function cannotChangeOptionsFor(cause: unknown, gid: string): boolean {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const match = message.match(/Cannot\s+change\s+option\s+for\s+GID#([a-f\d]{16})\b/i);
  return match?.[1].toLowerCase() === gid.toLowerCase();
}

export function createAria2Client(endpoint: string, secret?: string): Aria2Client {
  const transport = isTauriRuntime() ? new TauriAria2Transport() : new FetchAria2Transport();
  const managed = endpoint === "http://127.0.0.1:16800/jsonrpc" && Boolean(secret?.trim());
  return new Aria2Client(transport, endpoint, secret, managed);
}
