import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MangaChapterService } from "@/application/manga-ports";
import type { MangaChapterInput, MangaChapterResult } from "@/domain/manga";
import { isTauriRuntime } from "@/shared/runtime";

interface DownloadImagesResponse {
  imagePaths: string[];
  tempDirectory: string;
}

export class TauriMangaChapterService implements MangaChapterService {
  async downloadAndPackage(input: MangaChapterInput): Promise<MangaChapterResult> {
    if (!isTauriRuntime()) throw new Error("漫画章节下载只在桌面端可用");
    if (!input.imageUrls.length) throw new Error("章节至少需要一个图片地址");
    if (input.isCancelled?.()) throw new Error("漫画任务已取消");
    input.onProgress?.({ stage: "downloading", completed: 0, total: input.imageUrls.length, detail: "正在下载漫画图片" });
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    unlisten = await listen<{ tempDirectory: string; completed: number; total: number }>("manga-download-progress", ({ payload }) => {
      if (payload.tempDirectory !== input.tempDirectory || !Number.isInteger(payload.completed) || payload.completed < 0 || payload.completed > input.imageUrls.length) return;
      input.onProgress?.({ stage: "downloading", completed: payload.completed, total: input.imageUrls.length, detail: `已下载 ${payload.completed} / ${input.imageUrls.length} 页` });
    });
    const cancellation = setInterval(() => {
      if (!cancelled && input.isCancelled?.()) {
        cancelled = true;
        void invoke("cancel_manga_download", { tempDirectory: input.tempDirectory }).catch(() => undefined);
      }
    }, 200);
    let downloaded: DownloadImagesResponse;
    try {
      downloaded = await invoke<DownloadImagesResponse>("download_manga_images", {
        imageUrls: input.imageUrls, incomingRoot: input.incomingRoot,
        tempDirectory: input.tempDirectory, referer: input.referer || null, cookie: input.cookie || null,
      });
    } finally { clearInterval(cancellation); unlisten?.(); }
    if (input.isCancelled?.()) {
      await invoke("cleanup_manga_temp", { tempDirectory: downloaded.tempDirectory, incomingRoot: input.incomingRoot }).catch(() => undefined);
      throw new Error("漫画任务已取消");
    }
    try {
      input.onProgress?.({ stage: "packaging", completed: input.imageUrls.length, total: input.imageUrls.length, detail: "正在生成 CBZ" });
      if (input.isCancelled?.()) throw new Error("漫画任务已取消");
      await invoke("create_cbz", {
        imagePaths: downloaded.imagePaths,
        outputPath: input.outputPath,
        sourceRoot: downloaded.tempDirectory,
        incomingRoot: input.incomingRoot,
        outputRoot: input.outputRoot,
      });
    } catch (cause) {
      await invoke("cleanup_manga_temp", { tempDirectory: downloaded.tempDirectory, incomingRoot: input.incomingRoot }).catch(() => undefined);
      throw cause;
    }
    return { outputPath: input.outputPath, imagePaths: downloaded.imagePaths, pageCount: downloaded.imagePaths.length };
  }
}

export function createMangaChapterService(): MangaChapterService {
  return new TauriMangaChapterService();
}
