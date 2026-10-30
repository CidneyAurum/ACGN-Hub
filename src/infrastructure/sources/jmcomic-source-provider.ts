import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MangaChapterInput, MangaChapterResult } from "@/domain/manga";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { isTauriRuntime } from "@/shared/runtime";
import { parseDownloadTarget } from "@/shared/validation";

const searchResponseSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), tags: z.array(z.string()).default([]) })).default([]),
});
const chaptersResponseSchema = z.object({
  title: z.string().default(""),
  chapters: z.array(z.object({ id: z.string().min(1), index: z.string(), title: z.string().min(1) })).default([]),
});
const downloadResponseSchema = z.object({
  imagePaths: z.array(z.string().min(1)).min(1),
  tempDirectory: z.string().min(1).optional(),
});
const healthResponseSchema = z.object({ ok: z.boolean(), version: z.string().optional() });

interface JmComicSourceOptions {
  invokeBridge?: (args: Record<string, unknown>) => Promise<unknown>;
}

interface JmChapterEntry {
  resource: ResourceItem;
  photoId: string;
}

export class JmComicSourceProvider implements SourceProvider {
  readonly id = "jmcomic:local";
  readonly name = "JMComic 漫画";
  readonly supportedTypes: MediaType[] = ["manga"];
  private readonly invokeBridge: (args: Record<string, unknown>) => Promise<unknown>;
  private readonly albums = new Map<string, string>();
  private readonly chapters = new Map<string, JmChapterEntry>();

  constructor(options: JmComicSourceOptions = {}) {
    this.invokeBridge = options.invokeBridge ?? ((args) => invoke("jmcomic_bridge", args));
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (!this.supportedTypes.includes(query.mediaType)) return [];
    const keywords = [...new Set([query.keyword, ...query.aliases].map((value) => value.trim()).filter(Boolean))].slice(0, 6);
    if (!keywords.length) return [];
    const responses = await Promise.allSettled(keywords.map((value) => this.invokeBridge({ action: "search", value })));
    const successful = responses.flatMap((result) => result.status === "fulfilled" ? [searchResponseSchema.parse(result.value).items] : []);
    if (!successful.length) {
      const failure = responses.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      throw failure instanceof Error ? failure : new Error("JMComic 搜索失败");
    }
    const terms = [...new Set(keywords.map(normalize).filter(Boolean))];
    const merged = new Map<string, z.infer<typeof searchResponseSchema>["items"][number]>();
    for (const items of successful) {
      for (const item of items) {
        const haystack = normalize(`${item.title} ${item.tags.join(" ")}`);
        // 搜索接口已经按关键词筛选；这里只做宽松兜底，避免中文名/日文名经过翻译后被误删。
        if (!terms.some((term) => haystack.includes(term) || term.includes(haystack)) && keywords.length === 1) continue;
        merged.set(item.id, item);
      }
    }
    const items = [...merged.values()].slice(0, 12);
    this.albums.clear();
    this.chapters.clear();
    return items.map((item) => {
      this.albums.set(item.id, item.title);
      return { sourceId: this.id, sourceItemId: item.id, title: item.title, raw: item as unknown as Record<string, unknown> };
    });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const albumTitle = this.albums.get(sourceItemId) ?? `JM${sourceItemId}`;
    const response = chaptersResponseSchema.parse(await this.invokeBridge({ action: "chapters", value: sourceItemId }));
    const title = response.title.trim() || albumTitle;
    const result: ResourceItem[] = [];
    for (const chapter of response.chapters) {
      const targetUrl = `https://jmcomic.local/photo/${encodeURIComponent(chapter.id)}`;
      const resource: ResourceItem = {
        id: `${this.id}:${sourceItemId}:${chapter.id}`,
        sourceId: this.id,
        sourceItemId,
        title: `${title} · ${chapter.title}`,
        protocol: "http",
        targetUrl,
        format: "CBZ",
        metadata: {
          provider: "JMComic",
          downloadMode: "jmcomic_cbz",
          albumId: sourceItemId,
          photoId: chapter.id,
          chapterName: chapter.title,
          seriesTitle: title,
          index: chapter.index,
        },
        createdAt: new Date().toISOString(),
      };
      this.chapters.set(resource.id, { resource, photoId: chapter.id });
      result.push(resource);
    }
    return result;
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const entry = this.chapters.get(resourceId);
    if (!entry) throw new Error("JMComic 章节已过期，请重新刷新来源");
    return parseDownloadTarget(entry.resource.targetUrl);
  }

  restoreResource(resource: ResourceItem): void {
    if (resource.sourceId !== this.id || resource.metadata.provider !== "JMComic") return;
    const photoId = resource.metadata.photoId;
    if (typeof photoId !== "string" || !photoId) throw new Error("已保存的 JMComic 章节缺少标识，请重新搜索资源");
    this.chapters.set(resource.id, { resource, photoId });
  }

  async downloadMangaChapter(resourceId: string, input: MangaChapterInput): Promise<MangaChapterResult> {
    if (!isTauriRuntime()) throw new Error("JMComic 下载只在桌面端可用");
    const entry = this.chapters.get(resourceId);
    if (!entry) throw new Error("JMComic 章节已过期，请重新刷新来源");
    let response: z.infer<typeof downloadResponseSchema>;
    try {
      if (input.isCancelled?.()) throw new Error("漫画任务已取消");
      input.onProgress?.({ stage: "downloading", completed: 0, total: 0, detail: "正在读取 JMComic 图片" });
      response = downloadResponseSchema.parse(await this.invokeBridge({
        action: "download",
        value: entry.photoId,
        outputDir: input.tempDirectory,
        incomingRoot: input.incomingRoot,
      }));
      const tempDirectory = response.tempDirectory ?? input.tempDirectory;
      if (input.isCancelled?.()) throw new Error("漫画任务已取消");
      input.onProgress?.({ stage: "packaging", completed: response.imagePaths.length, total: response.imagePaths.length, detail: "正在生成 CBZ" });
      await invoke("create_cbz", {
        imagePaths: response.imagePaths,
        outputPath: input.outputPath,
        sourceRoot: tempDirectory,
        incomingRoot: input.incomingRoot,
        outputRoot: input.outputRoot,
      });
    } catch (cause) {
      await invoke("cleanup_manga_temp", { tempDirectory: input.tempDirectory, incomingRoot: input.incomingRoot }).catch(() => undefined);
      throw cause;
    }
    return { outputPath: input.outputPath, imagePaths: response.imagePaths, pageCount: response.imagePaths.length };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    if (!isTauriRuntime()) return { ok: false, checkedAt, message: "JMComic 需要桌面端 Python 3 和 jmcomic 包" };
    try {
      const response = healthResponseSchema.parse(await this.invokeBridge({ action: "health" }));
      return { ok: response.ok, checkedAt, message: response.ok
        ? `本地桥接可用${response.version ? ` · jmcomic ${response.version}` : ""}；尚未验证远端章节`
        : "本地 JMComic 桥接不可用，请检查 Python 和 jmcomic 安装" };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "未检测到 jmcomic" };
    }
  }
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}
