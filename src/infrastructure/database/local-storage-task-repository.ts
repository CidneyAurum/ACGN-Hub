import type { TaskRepository } from "@/application/ports";
import type { DownloadTask } from "@/domain/download";
import { DOWNLOAD_STATES } from "@/domain/download";
import { initializeStoredArray, readStoredArray, updateStoredArray, assertRecord } from "./stored-array";

const STORAGE_KEY = "acgn-hub.download-tasks.v1";

export class LocalStorageTaskRepository implements TaskRepository {
  async initialize(): Promise<void> {
    initializeStoredArray(localStorage, STORAGE_KEY);
  }

  async list(): Promise<DownloadTask[]> {
    return readStoredArray(localStorage, STORAGE_KEY, isDownloadTask);
  }

  async insert(task: DownloadTask): Promise<void> {
    assertRecord(task, isDownloadTask, "下载任务");
    await updateStoredArray(localStorage, STORAGE_KEY, isDownloadTask, (tasks) => {
      if (tasks.some((item) => item.dedupeKey === task.dedupeKey || item.id === task.id)) {
        throw new Error("相同链接或 ID 已经存在下载任务");
      }
      return [task, ...tasks];
    });
  }

  async update(task: DownloadTask): Promise<void> {
    assertRecord(task, isDownloadTask, "下载任务");
    await updateStoredArray(localStorage, STORAGE_KEY, isDownloadTask, (tasks) => {
      if (!tasks.some((item) => item.id === task.id)) throw new Error("需要更新的下载任务不存在");
      if (tasks.some((item) => item.id !== task.id && item.dedupeKey === task.dedupeKey)) throw new Error("相同链接已经存在下载任务");
      return tasks.map((item) => item.id === task.id ? task : item);
    });
  }

  async remove(id: string): Promise<void> {
    await updateStoredArray(localStorage, STORAGE_KEY, isDownloadTask, (tasks) => tasks.filter((task) => task.id !== id));
  }

  async findById(id: string): Promise<DownloadTask | undefined> {
    return (await this.list()).find((task) => task.id === id);
  }
}

export function isDownloadTask(value: unknown): value is DownloadTask {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DownloadTask>;
  return [item.id, item.engineId, item.sourceUrl, item.directory, item.dedupeKey, item.createdAt, item.updatedAt].every((part) => typeof part === "string" && part.trim().length > 0) &&
    ["http", "magnet", "torrent"].includes(item.protocol ?? "") && DOWNLOAD_STATES.includes(item.state as DownloadTask["state"]) &&
    [item.totalBytes, item.completedBytes, item.speedBytesPerSecond].every((size) => typeof size === "number" && Number.isFinite(size) && size >= 0) &&
    [item.connections, item.seeders].every((count) => count === undefined || (typeof count === "number" && Number.isFinite(count) && count >= 0)) &&
    [item.peers, item.verifiedBytes].every((count) => count === undefined || (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) &&
    (item.stage === undefined || ["queued_engine", "fetching_torrent", "fetching_metadata", "connecting", "downloading", "checking", "completed"].includes(item.stage)) &&
    (item.infoHash === undefined || (typeof item.infoHash === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(item.infoHash))) &&
    (item.verifyIntegrityPending === undefined || typeof item.verifyIntegrityPending === "boolean") &&
    (item.naming === undefined || (item.naming !== null && typeof item.naming === "object" && !Array.isArray(item.naming) &&
      ["renamed", "failed", "skipped"].includes(item.naming.status) &&
      [item.naming.originalFileName, item.naming.originalPath, item.naming.currentFileName, item.naming.renamedAt, item.naming.message]
        .every((part) => part === undefined || typeof part === "string"))) &&
    [item.engineEndpoint, item.engineTaskId, item.mediaId, item.resourceId, item.sourceName, item.filename, item.errorCode, item.tempPath, item.finalPath, item.error]
      .every((part) => part === undefined || typeof part === "string") &&
    Array.isArray(item.files) && item.files.every((file) => typeof file === "string");
}
