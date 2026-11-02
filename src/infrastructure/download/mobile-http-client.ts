import { invoke } from "@tauri-apps/api/core";
import type { DownloadEngine } from "@/application/ports";
import type { DownloadOptions, DownloadStatus, DownloadTarget } from "@/domain/download";
import { sanitizeMobileFileName } from "@/domain/organization";

type NativeStatus = Omit<DownloadStatus, "error"> & { error?: string | null };
function normalizeStatus(result: NativeStatus): DownloadStatus {
  const { error, ...status } = result;
  return { ...status, ...(typeof error === "string" && error ? { error } : {}) };
}

/** Native foreground HTTP transfers; Android can pause the app process in the background. */
export class MobileHttpClient implements DownloadEngine {
  readonly id = "mobile_http";
  async add(target: DownloadTarget, options: DownloadOptions): Promise<string> {
    if (target.protocol !== "http") throw new Error("安卓版本暂不支持磁力或种子，请选择 HTTP/HTTPS 文件链接");
    const filename = options.filename ?? target.filename;
    const result = await invoke<DownloadStatus>("mobile_http_start", {
      url: target.url, directory: options.directory, filename: filename ? sanitizeMobileFileName(filename) : null,
      headers: null, speedLimitBytesPerSecond: options.speedLimitBytesPerSecond ?? 0,
    });
    if (!result.engineTaskId) throw new Error("原生下载服务没有返回任务标识");
    return result.engineTaskId;
  }
  async pause(taskId: string): Promise<void> {
    const status = await invoke<NativeStatus>("mobile_http_pause", { taskId });
    if (status?.state === "completed") throw new Error("文件已完成下载，请刷新后查看成品");
  }
  async resume(taskId: string): Promise<void> { await invoke("mobile_http_resume", { taskId }); }
  async cancel(taskId: string): Promise<void> {
    const status = await invoke<NativeStatus>("mobile_http_cancel", { taskId });
    if (status?.state === "completed") throw new Error("文件已完成下载，请刷新后查看成品");
  }
  async status(taskId: string): Promise<DownloadStatus> {
    try { return normalizeStatus(await invoke<NativeStatus>("mobile_http_status", { taskId })); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : cause;
      // Only the native missing-record result permits re-submitting a URL.
      // Corrupt records, permissions and network failures must stay visible.
      if (message !== "没有找到安卓下载记录；请从资源页重新添加") throw cause;
      return { state: "failed", totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0, files: [],
        errorCode: "ENGINE_TASK_NOT_FOUND", error: message };
    }
  }
}
