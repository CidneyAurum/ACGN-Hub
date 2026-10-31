import type { DownloadTask } from "./download";
import { getCompletedDownloadOutputs } from "./download-output";
import type { LocalDownloadTask } from "./local-download";

export type LocalViewerKind = "comic" | "video" | "text";

export interface LocalViewerTarget {
  path: string;
  allowedRoot: string;
  title: string;
  kind: LocalViewerKind;
}

export interface LocalViewerSession {
  sessionId: string;
  kind: LocalViewerKind;
  title: string;
  pageCount?: number;
  sizeBytes: number;
  modifiedAt: string;
  text?: string;
}

export function getLocalViewerKind(path: string): LocalViewerKind | undefined {
  if (/\.cbz$/i.test(path)) return "comic";
  if (/\.txt$/i.test(path)) return "text";
  if (/\.(?:mp4|mkv|webm|m4v|mov|avi|ts)$/i.test(path)) return "video";
  return undefined;
}

/** Routes identify a task; only its current, registered output can grant a path. */
export function resolveLocalViewerTarget(input: {
  collection: unknown;
  id: unknown;
  file?: unknown;
  localTasks: readonly LocalDownloadTask[];
  engineTasks: readonly DownloadTask[];
  ownedLocalOutput: (id: string) => string | undefined;
  configuredRoots: readonly string[];
}): LocalViewerTarget {
  if (typeof input.id !== "string" || !input.id || !["local", "engine"].includes(String(input.collection))) {
    throw new Error("观看入口无效，请从已完成的下载记录打开。");
  }
  let path: string;
  let allowedRoot: string;
  let title: string;
  if (input.collection === "local") {
    if (input.file !== undefined && input.file !== null) throw new Error("本地生成任务不接受额外的文件路径，请重新从下载记录打开。");
    const task = input.localTasks.find((item) => item.id === input.id);
    if (!task || task.stage !== "completed") throw new Error("该任务尚未完成，或下载记录已被移除。");
    const owned = input.ownedLocalOutput(task.id);
    if (!owned || owned !== task.outputPath) throw new Error("此任务已不再拥有该成品，请从当前下载记录打开。");
    path = owned; allowedRoot = task.directory; title = task.title;
  } else if (input.collection === "engine") {
    const task = input.engineTasks.find((item) => item.id === input.id);
    if (!task || task.state !== "completed") throw new Error("该任务尚未完成，或下载记录已被移除。");
    const choices = getCompletedDownloadOutputs(task, input.configuredRoots);
    if (input.file !== undefined && input.file !== null && typeof input.file !== "string") throw new Error("文件选择无效，请重新从下载记录打开。");
    const selected = typeof input.file === "string" ? choices.find((item) => item.path === input.file)
      : choices.length === 1 ? choices[0] : undefined;
    if (!selected) throw new Error(choices.length > 1 ? "请在下载中心选择一个已完成的文件后打开。" : "此文件不在该任务当前登记的成品中，请重新从下载记录打开。");
    path = selected.path; allowedRoot = selected.allowedRoot; title = selected.label;
  } else {
    throw new Error("观看入口无效，请从已完成的下载记录打开。");
  }
  const kind = getLocalViewerKind(path);
  if (!kind) throw new Error("此格式暂不支持应用内观看，请使用系统默认程序打开。");
  return { path, allowedRoot, title, kind };
}

export interface ViewerProgressStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** A replaced file must never inherit another file's reading position. */
export function localViewerProgressKey(path: string, session: Pick<LocalViewerSession, "sizeBytes" | "modifiedAt" | "kind">): string {
  return "acgn-hub.viewer-progress.v1:" + JSON.stringify([path, session.kind, session.sizeBytes, session.modifiedAt]);
}

export function readLocalViewerProgress(storage: ViewerProgressStorage, key: string): number | undefined {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch { return undefined; }
}

export function writeLocalViewerProgress(storage: ViewerProgressStorage, key: string, value: number): boolean {
  if (!key || !Number.isFinite(value) || value < 0) return false;
  try { storage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function clampComicPage(value: number, pageCount: number): number {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return 0;
  return Math.min(pageCount - 1, Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0));
}

/** Bound decoded images to the current page and its two neighbours. */
export function comicPageWindow(center: number, pageCount: number): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return [];
  const current = clampComicPage(center, pageCount);
  return [current - 1, current, current + 1].filter((index) => index >= 0 && index < pageCount);
}

export function clampVideoPosition(value: number | undefined, duration: number): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0 || !Number.isFinite(duration) || duration <= 0) return undefined;
  return Math.min(value, Math.max(0, duration - 0.1));
}
