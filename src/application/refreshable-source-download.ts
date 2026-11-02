import type { DownloadTask, DownloadTarget } from "@/domain/download";
import type { ResourceItem } from "@/domain/resource";
import { createResourceRepository } from "@/infrastructure/database/create-resource-repository";
import { ItchFreewareSourceProvider } from "@/infrastructure/sources/itch-freeware-source-provider";
import { parseDownloadTarget } from "@/shared/validation";

export function requiresFreshSourceTarget(task: DownloadTask): boolean {
  return task.resourceId?.startsWith("itch_freeware:") === true;
}

/** A stable source file identity is persisted; short-lived file signatures stay in the engine. */
export async function resolveSourceDownloadTarget(task: DownloadTask, dependencies?: {
  findResource(id: string): Promise<ResourceItem | undefined>;
  resolve(resourceId: string): Promise<DownloadTarget>;
}): Promise<DownloadTarget> {
  if (!requiresFreshSourceTarget(task)) return parseDownloadTarget(task.sourceUrl);
  const resource = dependencies ? await dependencies.findResource(task.resourceId!)
    : await (await createResourceRepository()).findById(task.resourceId!);
  if (!resource || resource.mediaId !== task.mediaId || resource.targetUrl !== task.sourceUrl
    || resource.metadata.needsFreshDownloadTarget !== true || resource.sourceId !== "itch_freeware:https://itch.io") {
    throw new Error("该官方文件的来源记录不可用，请回到作品页重新选择；未把网页交给下载器。");
  }
  const target = dependencies ? await dependencies.resolve(resource.id) : await new ItchFreewareSourceProvider().resolve(resource.id);
  if (target.protocol !== "http" || new URL(target.url).protocol !== "https:") throw new Error("官方来源未返回有效的 HTTPS 文件链接。");
  return target;
}
