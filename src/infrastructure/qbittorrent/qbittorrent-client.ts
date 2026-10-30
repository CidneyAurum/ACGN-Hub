import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { DownloadEngine } from "@/application/ports";
import type { DownloadOptions, DownloadStatus, DownloadTarget } from "@/domain/download";
import type { QbittorrentCredentials } from "@/shared/settings";
import { isTauriRuntime } from "@/shared/runtime";
import { assertLocalEndpoint } from "@/shared/validation";

export interface QbittorrentRequest { endpoint: string; path: string; method: "GET" | "POST"; body?: string; username?: string; password?: string }
export interface QbittorrentResponse { status: number; body: unknown }
export interface QbittorrentTransport { request(input: QbittorrentRequest): Promise<QbittorrentResponse> }

export class TauriQbittorrentTransport implements QbittorrentTransport {
  request(input: QbittorrentRequest): Promise<QbittorrentResponse> {
    if (!isTauriRuntime()) throw new Error("qBittorrent 连接需要使用桌面版，请在桌面设置中启用 Web UI。");
    return invoke("qbittorrent_request", { ...input });
  }
}

const torrentSchema = z.object({
  hash: z.string().min(1), name: z.string().default(""), state: z.string(),
  total_size: z.number().nonnegative().optional(), size: z.number().nonnegative().optional(),
  completed: z.number().nonnegative().optional(), progress: z.number().min(0).max(1).default(0),
  dlspeed: z.number().nonnegative().default(0), num_seeds: z.number().nonnegative().default(0),
  num_leechs: z.number().nonnegative().default(0), save_path: z.string().optional(),
  content_path: z.string().optional(), amount_left: z.number().nonnegative().optional(),
}).passthrough();

export class QbittorrentClient implements DownloadEngine {
  readonly id = "qbittorrent";
  private readonly endpoint: string;
  constructor(private readonly transport: QbittorrentTransport, endpoint: string, private readonly credentials: QbittorrentCredentials = { username: "", password: "" }) {
    this.endpoint = assertLocalEndpoint(endpoint, "qBittorrent");
  }

  async probe(): Promise<string> {
    const result = await this.call("/api/v2/app/version");
    if (typeof result !== "string" || !/^v?\d+\.\d+/.test(result.trim())) throw new Error("该地址未返回有效的 qBittorrent 版本，请检查 Web UI 端口。");
    return result.trim();
  }

  async add(target: DownloadTarget, options: DownloadOptions): Promise<string> {
    if (target.protocol === "http") throw new Error("qBittorrent 负责磁力和 Torrent 下载，普通文件直链使用 aria2。");
    const tag = options.clientTag ?? "acgn-" + crypto.randomUUID();
    // A persisted tag is a stable handle even while qBittorrent fetches torrent metadata.
    // Retry/restart first reconciles the tag to avoid submitting the torrent twice.
    if ((await this.list("tag=" + encodeURIComponent(tag))).length) return "tag:" + tag;
    const body = new URLSearchParams({ urls: target.url, savepath: options.directory, tags: tag, autoTMM: "false", paused: "false", stopped: "false" });
    if (options.speedLimitBytesPerSecond) body.set("dlLimit", String(options.speedLimitBytesPerSecond));
    const result = await this.call("/api/v2/torrents/add", "POST", body);
    if (typeof result !== "string" || !/^Ok\.?$/i.test(result.trim())) throw new Error("qBittorrent 没有接受该下载，请检查链接和下载目录。");
    return "tag:" + tag + "#" + Date.now();
  }

  async pause(id: string): Promise<void> { await this.action(id, "stop", "pause"); }
  async resume(id: string): Promise<void> { await this.action(id, "start", "resume"); }
  async cancel(id: string): Promise<void> {
    const torrent = await this.find(id);
    if (!torrent) {
      if (this.isPending(id)) throw new Error("qBittorrent 仍在接收种子，请稍后再次取消，或在其客户端检查该任务。");
      return;
    }
    await this.call("/api/v2/torrents/delete", "POST", new URLSearchParams({ hashes: torrent.hash, deleteFiles: "false" }));
  }

  async status(id: string): Promise<DownloadStatus> {
    const torrent = await this.find(id);
    if (!torrent && this.isPending(id)) return { state: "downloading", totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0, files: [] };
    if (!torrent) return { state: "failed", totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0, files: [], errorCode: "ENGINE_TASK_NOT_FOUND", error: "qBittorrent 中找不到此任务，请确认外部任务是否已被移除。" };
    const total = torrent.total_size ?? torrent.size ?? 0;
    const completed = torrent.completed ?? Math.round(total * torrent.progress);
    const complete = torrent.progress >= 1 && (torrent.amount_left === undefined || torrent.amount_left === 0) && !/checking|moving|allocating/i.test(torrent.state);
    const failed = ["error", "missingFiles", "unknown"].includes(torrent.state);
    const paused = /^(?:paused|stopped)/i.test(torrent.state);
    const state = failed ? "failed" : complete ? "completed" : paused ? "paused" : "downloading";
    // A content path may be a directory. Organizer expands it inside Incoming.
    const content = torrent.content_path || (torrent.save_path && torrent.name ? torrent.save_path.replace(/[\\/]+$/, "") + "\\" + torrent.name : undefined);
    return {
      state, totalBytes: total, completedBytes: completed, speedBytesPerSecond: torrent.dlspeed,
      connections: torrent.num_leechs + torrent.num_seeds, seeders: torrent.num_seeds,
      files: content ? [content] : [],
      ...(failed ? { errorCode: torrent.state, error: torrent.state === "missingFiles" ? "qBittorrent 找不到下载文件，请检查磁盘和目录后重试。" : "qBittorrent 任务异常，请在其客户端检查详细原因。" } : {}),
    };
  }

  private async action(id: string, modern: string, legacy: string): Promise<void> {
    const torrent = await this.find(id);
    if (!torrent) throw new Error("qBittorrent 中找不到此任务，请重试下载。");
    const body = new URLSearchParams({ hashes: torrent.hash });
    const result = await this.request("/api/v2/torrents/" + modern, "POST", body);
    if (result.status === 404) await this.call("/api/v2/torrents/" + legacy, "POST", body);
    else this.check(result);
  }
  private async find(id: string): Promise<z.infer<typeof torrentSchema> | undefined> {
    const query = id.startsWith("tag:") ? "tag=" + encodeURIComponent(id.slice(4).replace(/#\d+$/, "")) : "hashes=" + encodeURIComponent(id);
    return (await this.list(query))[0];
  }
  private isPending(id: string): boolean {
    const timestamp = id.startsWith("tag:") ? Number(id.match(/#(\d+)$/)?.[1]) : NaN;
    return Number.isFinite(timestamp) && Date.now() - timestamp < 120_000;
  }
  private async list(query: string): Promise<Array<z.infer<typeof torrentSchema>>> {
    const result = await this.call("/api/v2/torrents/info?" + query);
    const parsed = z.array(torrentSchema).safeParse(result);
    if (!parsed.success) throw new Error("qBittorrent 返回了无效的任务状态，请检查 Web UI 版本和地址。");
    return parsed.data;
  }
  private request(path: string, method: "GET" | "POST" = "GET", body?: URLSearchParams): Promise<QbittorrentResponse> {
    return this.transport.request({ endpoint: this.endpoint, path, method, ...(body ? { body: body.toString() } : {}), ...this.credentials });
  }
  private async call(path: string, method: "GET" | "POST" = "GET", body?: URLSearchParams): Promise<unknown> { return this.check(await this.request(path, method, body)); }
  private check(result: QbittorrentResponse): unknown {
    if (result.status === 401 || result.status === 403) throw new Error("qBittorrent 登录失败，请在设置中填写 Web UI 用户名和密码并测试连接。");
    if (result.status < 200 || result.status >= 300) throw new Error("qBittorrent 请求失败（HTTP " + result.status + "），请检查 Web UI 配置。");
    return result.body;
  }
}
