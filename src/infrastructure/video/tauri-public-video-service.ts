import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@/shared/runtime";

export interface PublicVideoProgress {
  id: string;
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  stage: "preparing" | "downloading" | "merging" | "completed";
  detail?: string;
}
export interface PublicVideoDownloadInput {
  url: string; outputRoot: string; outputPath: string; operationId: string;
  isCancelled?: () => boolean;
  onProgress?: (progress: PublicVideoProgress) => void;
}

/** Uses the installed download tools through the native host; no CDN signatures persist. */
export async function downloadPublicVideo(input: PublicVideoDownloadInput): Promise<{ outputPath: string; sizeBytes: number }> {
  if (!isTauriRuntime()) throw new Error("公开视频下载需要桌面端和已安装的 yt-dlp / FFmpeg");
  if (input.isCancelled?.()) throw new Error("视频下载已取消");
  let sentCancellation = false;
  const unlisten = await listen<PublicVideoProgress>("public-video-progress", ({ payload }) => {
    if (payload.id !== input.operationId || !Number.isFinite(payload.percent) || payload.percent < 0 || payload.percent > 100) return;
    input.onProgress?.(payload);
  });
  const cancellation = setInterval(() => {
    if (!sentCancellation && input.isCancelled?.()) {
      sentCancellation = true;
      void invoke("cancel_public_video", { id: input.operationId }).catch(() => undefined);
    }
  }, 250);
  try {
    return await invoke("download_public_video", { url: input.url, outputRoot: input.outputRoot, outputPath: input.outputPath, operationId: input.operationId });
  } finally { clearInterval(cancellation); unlisten(); }
}
