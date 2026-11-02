import type { DownloadEngine, TaskRepository } from "./ports";
import type { DownloadEngineSettings, DownloadOptions, DownloadTask, DownloadState, DownloadStatus, DownloadNaming } from "@/domain/download";
import { canTransition } from "@/domain/state-machine";
import { sanitizeFileName, sanitizeMobileFileName } from "@/domain/organization";
import { assertDownloadDirectory, normalizeDedupeKey, parseDownloadTarget } from "@/shared/validation";
import { newId, nowIso } from "@/shared/runtime";

export interface DownloadManagerDependencies {
  repository: TaskRepository;
  engine(id: string, endpoint?: string): DownloadEngine;
  settings(): { maxConcurrentDownloads: number; speedLimitBytesPerSecond: number; aria2Endpoint?: string; qbittorrentEndpoint?: string; btDownloadEngine?: "aria2" | "qbittorrent"; httpDownloadEngine?: "aria2" | "mobile_http" };
  onChange(tasks: DownloadTask[]): void;
  onComplete?(task: DownloadTask): void;
}
export interface DownloadAssociation { mediaId?: string; resourceId?: string; sourceName?: string; filename?: string }

/** Owns all task transitions; UI and timer updates share the same per-task locks. */
export class DownloadManager {
  private tasks: DownloadTask[] = [];
  private initialized?: Promise<void>;
  private locks = new Map<string, Promise<unknown>>();
  private additions: Promise<unknown> = Promise.resolve();
  private scheduling?: Promise<void>;
  private refreshing?: Promise<void>;
  private readonly appliedSettings = new Map<string, { signature: string; handles: Set<string> }>();
  constructor(private readonly deps: DownloadManagerDependencies) {}

  initialize(): Promise<void> {
    this.initialized ??= this.deps.repository.list().then(async (tasks) => {
      this.tasks = tasks;
      const cancelledRecovery = this.cancelledRecovery();
      // Restore the correct owner of legacy BT rows; configuration changes never move active jobs.
      for (const task of tasks) {
        if (cancelledRecovery.has(task.id)) {
          await this.save({ ...task, state: "cancelled", stage: undefined, engineTaskId: undefined, speedBytesPerSecond: 0, errorCode: "USER_CANCELLED", error: undefined, updatedAt: nowIso() });
          this.clearCancelledRecovery(task.id);
          continue;
        }
        if (task.engineId === "aria2" && task.state === "failed" && task.errorCode === "ENGINE_TASK_NOT_FOUND") {
          await this.save({ ...task, state: "queued", engineTaskId: undefined,
            engineEndpoint: task.engineEndpoint ?? this.endpointFor("aria2"), stage: undefined,
            errorCode: undefined, error: "引擎会话已更新，正在恢复原始链接。", speedBytesPerSecond: 0, updatedAt: nowIso() });
          continue;
        }
        const expected = task.protocol === "http" ? this.deps.settings().httpDownloadEngine ?? "aria2" : ["aria2", "qbittorrent"].includes(task.engineId) ? task.engineId : this.deps.settings().btDownloadEngine ?? "aria2";
        if (task.engineId !== expected && ["http", "magnet", "torrent"].includes(task.protocol)) {
          await this.save({ ...task, engineId: expected, engineEndpoint: this.endpointFor(expected), engineTaskId: undefined, state: ["completed", "cancelled"].includes(task.state) ? task.state : "paused", error: "下载引擎已更新，点击继续恢复任务。", updatedAt: nowIso() });
        } else if (!task.engineEndpoint && this.endpointFor(task.engineId)) {
          await this.save({ ...task, engineEndpoint: this.endpointFor(task.engineId) });
        }
      }
      this.emit();
    }).catch((cause) => { this.initialized = undefined; throw cause; });
    return this.initialized;
  }

  async add(rawUrl: string, directory: string, association: DownloadAssociation = {}): Promise<void> {
    await this.initialize();
    let createdId = "";
    const operation = this.additions.catch(() => undefined).then(async () => {
      const target = parseDownloadTarget(rawUrl);
      if (this.deps.settings().httpDownloadEngine === "mobile_http" && target.protocol !== "http") throw new Error("安卓版本暂不支持磁力或种子，请选择 HTTP/HTTPS 文件链接");
      const dedupeKey = normalizeDedupeKey(target.url);
      if (this.tasks.some((task) => {
        try { return normalizeDedupeKey(task.sourceUrl) === dedupeKey; } catch { return task.dedupeKey === dedupeKey; }
      })) throw new Error("相同链接已有下载任务，可在下载中心继续或重试。");
      const timestamp = nowIso();
      const filename = association.filename ?? target.filename;
      const engineId = target.protocol === "http" ? this.deps.settings().httpDownloadEngine ?? "aria2" : this.deps.settings().btDownloadEngine ?? "aria2";
      const task: DownloadTask = {
        id: newId(), engineId,
        engineEndpoint: this.endpointFor(engineId),
        ...association, sourceUrl: target.url, protocol: target.protocol,
        directory: assertDownloadDirectory(directory), ...(filename ? { filename: engineId === "mobile_http" ? sanitizeMobileFileName(filename) : sanitizeFileName(filename) } : {}),
        state: "queued", totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0,
        files: [], dedupeKey, createdAt: timestamp, updatedAt: timestamp,
      };
      await this.deps.repository.insert(task);
      this.tasks = [task, ...this.tasks];
      createdId = task.id;
      this.emit();
    });
    this.additions = operation;
    await operation;
    await this.schedule();
    const created = this.current(createdId);
    if (created.state === "failed") throw new Error(created.error ?? "任务启动失败，请检查引擎连接。");
  }

  refreshAll(): Promise<void> {
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(): Promise<void> {
    await this.initialize();
    await this.schedule();
    // Reapply changed limits (including zero) to jobs already owned by the
    // engine. A settings fault must not stop ordinary progress polling.
    let settingsFailure: unknown;
    try { await this.syncEngineSettings(); } catch (cause) { settingsFailure = cause; }
    const active = this.tasks.filter((task) => task.engineTaskId && ["downloading", "paused", "queued"].includes(task.state));
    for (let offset = 0; offset < active.length; offset += 6) {
      await Promise.all(active.slice(offset, offset + 6).map((task) => this.lock(task.id, () => this.refreshTask(task.id))));
    }
    await this.schedule();
    if (settingsFailure) throw settingsFailure;
  }
  private async refreshTask(id: string): Promise<void> {
    const task = this.current(id);
    if (!task.engineTaskId || !["downloading", "paused", "queued"].includes(task.state)) return;
    let status: DownloadStatus;
    try { status = await this.engine(task).status(task.engineTaskId, { protocol: task.protocol }); }
    catch (cause) {
      await this.save({ ...task, speedBytesPerSecond: 0, errorCode: statusFailureCode(cause), error: errorMessage(cause), updatedAt: nowIso() });
      return;
    }
    if (status.errorCode === "ENGINE_TASK_NOT_FOUND") {
      const paused = task.state === "paused";
      // Missing qBittorrent tasks may have been deliberately removed outside this app.
      const recover = task.engineId === "aria2" || task.engineId === "mobile_http";
      await this.save({ ...task, engineTaskId: undefined, state: paused ? "paused" : recover ? "queued" : "failed", speedBytesPerSecond: 0,
        stage: undefined, peers: undefined, connections: undefined, seeders: undefined,
        errorCode: recover ? undefined : status.errorCode,
        error: paused ? "引擎会话已更新，点击继续恢复下载。" : recover ? "引擎会话已更新，正在恢复下载。" : status.error,
        updatedAt: nowIso() });
      return;
    }
    if (!canTransition(task.state, status.state)) return;
    const metadataStage = status.stage === "fetching_torrent" || status.stage === "fetching_metadata";
    const knownPayload = task.protocol !== "http" && task.totalBytes > 0 && task.files.some((path) => {
      const filename = path.split(/[\\/]/).pop() ?? "";
      return Boolean(filename) && !/\.torrent$|^\[METADATA\]/i.test(filename);
    });
    if (metadataStage && knownPayload) {
      // Reacquiring a 9 KB torrent is not a new measurement of the existing
      // video on disk. Retain its last known payload counters and paths until
      // the content GID reports actual checked/resumed progress.
      status = { ...status, totalBytes: task.totalBytes, completedBytes: task.completedBytes,
        files: task.files, filename: task.filename, speedBytesPerSecond: 0, infoHash: status.infoHash ?? task.infoHash };
    }
    if (task.state === "paused" && status.state === "downloading") {
      // A metadata parent can create its content GID just after the user's
      // pause. Reapply that intent to the discovered child instead of silently
      // switching the UI (and download) back to active.
      const handle = status.engineTaskId ?? task.engineTaskId;
      try { await this.engine(task).pause(handle); }
      catch (cause) {
        if (task.engineId === "aria2" && isMissingRemoteTask(cause)) {
          await this.save({ ...task, engineTaskId: undefined, stage: undefined, speedBytesPerSecond: 0, updatedAt: nowIso() });
          return;
        }
        await this.save({ ...task, engineTaskId: handle, speedBytesPerSecond: 0, errorCode: statusFailureCode(cause), error: errorMessage(cause), updatedAt: nowIso() });
        return;
      }
      status = { ...status, engineTaskId: handle, state: "paused", stage: undefined, speedBytesPerSecond: 0 };
    }
    const next: DownloadTask = {
      ...task, ...status, error: status.error, errorCode: status.errorCode, updatedAt: nowIso(),
      stage: status.stage, peers: status.peers, connections: status.connections, seeders: status.seeders,
      infoHash: status.infoHash, verifiedBytes: status.verifiedBytes, verifyIntegrityPending: status.verifyIntegrityPending,
      ...(status.state === "completed" && status.files.length === 1 ? { tempPath: status.files[0] } : {}),
    };
    await this.save(next);
    if (task.state !== "completed" && next.state === "completed") this.deps.onComplete?.(next);
  }

  async pause(id: string): Promise<void> {
    await this.initialize();
    await this.lock(id, async () => {
      const task = this.current(id);
      this.requireState(task, ["queued", "downloading"], "暂停");
      let engineTaskId = task.engineTaskId;
      if (engineTaskId) {
        try { await this.engine(task).pause(engineTaskId); }
        catch (cause) { if (task.engineId !== "aria2" || !isMissingRemoteTask(cause)) throw cause; engineTaskId = undefined; }
      }
      await this.save({ ...task, engineTaskId, state: "paused", stage: undefined, speedBytesPerSecond: 0, error: undefined, errorCode: undefined, updatedAt: nowIso() });
    });
    await this.schedule();
  }
  async resume(id: string): Promise<void> {
    await this.initialize();
    await this.lock(id, async () => {
      const task = this.current(id);
      this.requireState(task, ["paused"], "继续");
      await this.save({ ...task, state: "queued", stage: undefined, error: undefined, errorCode: undefined, updatedAt: nowIso() });
    });
    await this.schedule();
  }
  async cancel(id: string): Promise<void> {
    await this.initialize();
    await this.lock(id, async () => {
      const task = this.current(id);
      this.requireState(task, ["queued", "downloading", "paused", "failed"], "取消");
      if (task.engineTaskId) await this.engine(task).cancel(task.engineTaskId);
      const cancelled: DownloadTask = { ...task, state: "cancelled", stage: undefined, engineTaskId: undefined, speedBytesPerSecond: 0, error: undefined, errorCode: "USER_CANCELLED", updatedAt: nowIso() };
      try { await this.save(cancelled); }
      catch (cause) {
        // Keep the user's cancellation authoritative even if disk storage fails.
        // A recovery marker is written separately so restart cannot re-add it.
        this.rememberCancelled(task.id);
        this.tasks = this.tasks.map((entry) => entry.id === task.id ? cancelled : entry);
        this.emit();
        throw cause;
      }
    });
    await this.schedule();
  }
  async retry(id: string): Promise<void> {
    await this.initialize();
    await this.lock(id, async () => {
      const task = this.current(id);
      this.requireState(task, ["failed", "cancelled"], "重试");
      const keepRemote = ["qbittorrent", "mobile_http"].includes(task.engineId) && task.state === "failed" && task.errorCode !== "ENGINE_TASK_NOT_FOUND";
      await this.save({ ...task, engineTaskId: keepRemote ? task.engineTaskId : undefined, state: "queued", stage: undefined, error: undefined, errorCode: undefined, speedBytesPerSecond: 0, updatedAt: nowIso() });
      this.clearCancelledRecovery(id);
    });
    await this.schedule();
    if (this.current(id).state === "failed") throw new Error(this.current(id).error ?? "重试失败");
  }
  async markOrganized(id: string, finalPath: string): Promise<void> {
    await this.initialize();
    await this.lock(id, async () => { await this.save({ ...this.current(id), finalPath, updatedAt: nowIso() }); });
  }

  /** Serialize a native file+database change with task deletion and other UI actions. */
  async mutateCompletedTask(id: string, action: (task: DownloadTask) => Promise<void>): Promise<void> {
    await this.initialize();
    await this.lock(id, async () => {
      const task = this.current(id);
      this.requireState(task, ["completed"], "命名成品");
      try { await action(task); }
      finally {
        const stored = await this.deps.repository.findById(id);
        if (stored) {
          this.tasks = this.tasks.map((item) => item.id === id ? stored : item);
          this.emit();
        }
      }
    });
  }

  async recordNamingResult(id: string, naming: DownloadNaming): Promise<void> {
    await this.initialize();
    await this.lock(id, async () => {
      const task = this.current(id);
      this.requireState(task, ["completed"], "保存命名记录");
      await this.save({ ...task, naming, updatedAt: nowIso() });
    });
  }
  async remove(id: string, beforeRemove?: (task: DownloadTask) => Promise<void>): Promise<void> {
    await this.initialize();
    await this.lock(id, async () => {
      const task = this.current(id);
      this.requireState(task, ["completed", "failed", "cancelled"], "删除记录");
      await beforeRemove?.(task);
      await this.deps.repository.remove(id);
      this.tasks = this.tasks.filter((entry) => entry.id !== id);
      this.emit();
    });
  }

  private schedule(): Promise<void> {
    this.scheduling ??= this.startQueued().finally(() => { this.scheduling = undefined; });
    return this.scheduling;
  }
  private async startQueued(): Promise<void> {
    const max = this.deps.settings().maxConcurrentDownloads;
    while (this.tasks.filter((task) => task.state === "downloading").length < max) {
      const queued = this.tasks.find((task) => task.state === "queued");
      if (!queued) return;
      await this.lock(queued.id, async () => {
        const task = this.current(queued.id);
        if (task.state !== "queued") return;
        let engine: DownloadEngine;
        let remoteId: string;
        try {
          engine = this.engine(task);
          const options: DownloadOptions = { directory: task.directory, filename: task.filename, clientTag: "acgn-" + task.id, speedLimitBytesPerSecond: this.deps.settings().speedLimitBytesPerSecond };
          remoteId = task.engineTaskId ?? await engine.add(parseDownloadTarget(task.sourceUrl), options);
          if (task.engineTaskId) {
            try { await engine.resume(remoteId); }
            catch (cause) {
              if (task.engineId !== "aria2" || !isMissingRemoteTask(cause)) throw cause;
              remoteId = await engine.add(parseDownloadTarget(task.sourceUrl), options);
            }
          }
        } catch (cause) {
          await this.save({ ...task, state: "failed", stage: undefined, speedBytesPerSecond: 0, error: errorMessage(cause), updatedAt: nowIso() });
          return;
        }
        const started: DownloadTask = { ...task, engineTaskId: remoteId, state: "downloading",
          stage: task.protocol === "torrent" ? "fetching_torrent" : task.protocol === "magnet" ? "fetching_metadata" : "connecting",
          error: undefined, errorCode: undefined, updatedAt: nowIso() };
        try { await this.save(started); }
        catch (cause) {
          let stopped = false;
          try {
            if (task.engineTaskId) await engine.pause(remoteId);
            else await engine.cancel(remoteId);
            stopped = true;
          } catch { /* Keep the remote handle visible so the user can stop it. */ }
          const recovered: DownloadTask = { ...started, state: stopped ? task.engineTaskId ? "paused" : "failed" : "downloading", engineTaskId: stopped && !task.engineTaskId ? undefined : remoteId,
            error: stopped ? "本地记录保存失败，已停止远端任务。请检查磁盘后重试。" : "引擎已启动但记录保存失败，请在下载引擎中检查并停止任务。" };
          this.tasks = this.tasks.map((entry) => entry.id === task.id ? recovered : entry);
          this.emit();
          try { await this.deps.repository.update(recovered); } catch { /* Preserve in-memory recovery and surface the storage fault. */ }
          throw new Error(recovered.error, { cause });
        }
      });
    }
  }

  private async syncEngineSettings(): Promise<void> {
    const groups = new Map<string, DownloadTask[]>();
    for (const task of this.tasks) {
      if (!task.engineTaskId || !["downloading", "queued", "paused"].includes(task.state)) continue;
      const key = JSON.stringify([task.engineId, task.engineEndpoint ?? this.endpointFor(task.engineId) ?? ""]);
      const group = groups.get(key) ?? []; group.push(task); groups.set(key, group);
    }
    const settings: DownloadEngineSettings = { maxConcurrentDownloads: this.deps.settings().maxConcurrentDownloads,
      speedLimitBytesPerSecond: this.deps.settings().speedLimitBytesPerSecond };
    const signature = JSON.stringify(settings);
    const failures: string[] = [];
    for (const [key, group] of groups) {
      try {
        const engine = this.engine(group[0]);
        if (!engine.applySettings) continue;
        const handles = new Set(group.map((task) => task.engineTaskId!));
        const previous = this.appliedSettings.get(key);
        if (previous?.signature === signature && [...handles].every((id) => previous.handles.has(id))) continue;
        await engine.applySettings(settings, [...handles]);
        this.appliedSettings.set(key, { signature, handles });
      } catch (cause) { failures.push(errorMessage(cause)); }
    }
    if (failures.length) throw new Error("运行中的下载设置未能同步：" + [...new Set(failures)].join("；"));
  }
  private current(id: string): DownloadTask {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error("该下载任务已被移除，请刷新列表。");
    return task;
  }
  private endpointFor(id: string): string | undefined { const settings = this.deps.settings(); return id === "aria2" ? settings.aria2Endpoint : id === "qbittorrent" ? settings.qbittorrentEndpoint : undefined; }
  private engine(task: DownloadTask): DownloadEngine { return this.deps.engine(task.engineId, task.engineEndpoint); }
  private rememberCancelled(id: string): void {
    try {
      if (typeof localStorage !== "undefined") {
        const key = "acgn-hub.cancelled-recovery.v1";
        const ids = JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
        localStorage.setItem(key, JSON.stringify([...new Set([...ids, id])]));
      }
    } catch { /* Disk storage may itself be unavailable; the visible state still remains cancelled. */ }
  }
  private cancelledRecovery(): Set<string> {
    try {
      if (typeof localStorage === "undefined") return new Set();
      const value: unknown = JSON.parse(localStorage.getItem("acgn-hub.cancelled-recovery.v1") ?? "[]");
      return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
    } catch { return new Set(); }
  }
  private clearCancelledRecovery(id: string): void {
    try {
      const ids = this.cancelledRecovery(); ids.delete(id);
      if (typeof localStorage !== "undefined") localStorage.setItem("acgn-hub.cancelled-recovery.v1", JSON.stringify([...ids]));
    } catch { /* An already persisted cancellation is authoritative even if marker cleanup fails. */ }
  }
  private requireState(task: DownloadTask, states: DownloadState[], action: string): void {
    if (!states.includes(task.state)) throw new Error("当前任务状态无法" + action + "，请刷新后重试。");
  }
  private async save(task: DownloadTask): Promise<void> {
    await this.deps.repository.update(task);
    this.tasks = this.tasks.map((entry) => entry.id === task.id ? task : entry);
    this.emit();
  }
  private emit(): void { this.deps.onChange([...this.tasks]); }
  private lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.locks.set(id, pending);
    void pending.finally(() => { if (this.locks.get(id) === pending) this.locks.delete(id); }).catch(() => undefined);
    return pending;
  }
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "操作未完成，请重试。";
}

function isMissingRemoteTask(cause: unknown): boolean {
  return /(?:GID|download task|任务).*(?:not found|不存在)/i.test(errorMessage(cause));
}
function statusFailureCode(cause: unknown): string {
  return /connect|network|fetch|timed?\s*out|timeout|socket|无法连接|连接失败|连接.*拒绝|RPC.*(?:unavailable|不可用|失联|离线)/i.test(errorMessage(cause))
    ? "ENGINE_UNREACHABLE" : "ENGINE_STATUS_UNAVAILABLE";
}
