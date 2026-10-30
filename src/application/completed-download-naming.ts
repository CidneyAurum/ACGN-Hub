import type { Media } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import type { DownloadTask } from "@/domain/download";
import { buildCompletedDownloadName } from "@/domain/download-naming";

export interface CompletedNamePreview { filePath: string; newFileName?: string; reason?: string }
export interface CompletedNamingSources {
  findMedia(id: string): Promise<Media | undefined>;
  findResource(id: string): Promise<ResourceItem | undefined>;
}

/** Use only the task's saved identity. Never guess a Chinese title from a search result. */
export async function previewCompletedName(task: DownloadTask, sources: CompletedNamingSources, filePath?: string): Promise<CompletedNamePreview> {
  if (task.state !== "completed") return { filePath: filePath ?? task.files[0] ?? "", reason: "下载完成后才能修改成品文件名。" };
  if (task.engineId !== "aria2") return { filePath: filePath ?? task.files[0] ?? "", reason: "请在 qBittorrent 中重命名，以保留做种与文件路径关联。" };
  const media = task.mediaId ? await sources.findMedia(task.mediaId) : undefined;
  const resource = task.resourceId ? await sources.findResource(task.resourceId) : undefined;
  return buildCompletedDownloadName({ task, media, resource, ...(filePath ? { filePath } : {}) });
}

export function automaticNameEligible(task: DownloadTask, enabled: boolean): boolean {
  return enabled && task.state === "completed" && task.engineId === "aria2" && !task.naming &&
    task.files.length === 1 && !task.finalPath;
}
