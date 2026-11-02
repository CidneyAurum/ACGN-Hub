import { timeoutSignal } from "@/shared/abort-signals";
import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MangaChapterDescriptor } from "@/domain/manga";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { parseDownloadTarget } from "@/shared/validation";
import { sourceSearchTerms, sourceTitleMatch } from "./source-matching";

const mangaSchema = z.object({
  id: z.string().min(1),
  attributes: z.object({
    title: z.record(z.string(), z.string()).default({}),
    altTitles: z.array(z.record(z.string(), z.string())).default([]),
    year: z.number().int().optional().nullable(),
  }).passthrough(),
  relationships: z.array(z.object({
    type: z.string(),
    attributes: z.object({ fileName: z.string().optional() }).passthrough().optional(),
  }).passthrough()).default([]),
}).passthrough();

const mangaSearchResponseSchema = z.object({
  result: z.string(),
  data: z.array(mangaSchema).default([]),
}).passthrough();

const chapterSchema = z.object({
  id: z.string().min(1),
  attributes: z.object({
    title: z.string().nullable().optional(),
    chapter: z.string().nullable().optional(),
    volume: z.string().nullable().optional(),
    translatedLanguage: z.string().default(""),
    pages: z.number().int().nonnegative().default(0),
  }).passthrough(),
}).passthrough();

const chapterFeedResponseSchema = z.object({
  result: z.string(),
  data: z.array(chapterSchema).default([]),
  total: z.number().nonnegative().optional(),
}).passthrough();

const atHomeResponseSchema = z.object({
  result: z.string(),
  baseUrl: z.string().url(),
  chapter: z.object({
    hash: z.string().min(1),
    data: z.array(z.string().min(1)).default([]),
  }).passthrough(),
}).passthrough();

type Manga = z.infer<typeof mangaSchema>;
type Chapter = z.infer<typeof chapterSchema>;

interface MangaDexSourceProviderOptions {
  fetcher?: JsonFetcher;
  timeoutMs?: number;
}

interface ChapterEntry {
  resource: ResourceItem;
  chapterId: string;
}

/**
 * MangaDex adapter. It follows the public API flow used by open-source
 * MangaDex downloaders: title search -> chapter feed -> @Home page images.
 */
export class MangaDexSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "MangaDex 漫画";
  readonly supportedTypes: MediaType[] = ["manga"];
  private readonly baseUrl: string;
  private readonly fetcher: JsonFetcher;
  private readonly timeoutMs: number;
  private readonly manga = new Map<string, Manga>();
  private readonly chapters = new Map<string, ChapterEntry>();

  constructor(baseUrl = "https://api.mangadex.org", options: MangaDexSourceProviderOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("MangaDex API 地址必须是不带认证信息的 HTTP/HTTPS 地址");
    }
    this.baseUrl = parsed.origin;
    this.id = "mangadex:" + this.baseUrl;
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "manga") return [];
    const queries = sourceSearchTerms(query.keyword, query.aliases, 3);
    if (!queries.length) return [];
    const result = new Map<string, Manga>();
    let succeeded = false;
    let failure: unknown;
    for (const keyword of queries) {
      let items: Manga[];
      try { items = await this.searchManga(keyword); succeeded = true; } catch (cause) { failure = cause; continue; }
      for (const item of items) {
        if (sourceTitleMatch(preferredTitle(item), queries, titleAliases(item)).score <= 0) continue;
        result.set(item.id, item);
      }
      if ([...result.values()].some((item) => sourceTitleMatch(preferredTitle(item), queries, titleAliases(item)).score >= 100)) break;
    }
    if (!succeeded && failure) throw failure;
    this.manga.clear();
    this.chapters.clear();
    return [...result.values()].sort((left, right) => sourceTitleMatch(preferredTitle(right), queries, titleAliases(right)).score - sourceTitleMatch(preferredTitle(left), queries, titleAliases(left)).score).slice(0, 12).map((item) => {
      this.manga.set(item.id, item);
      const coverFile = item.relationships.find((relationship) => relationship.type === "cover_art")?.attributes?.fileName;
      return {
        sourceId: this.id,
        sourceItemId: item.id,
        title: preferredTitle(item),
        ...(coverFile ? { coverUrl: "https://uploads.mangadex.org/covers/" + item.id + "/" + encodeURIComponent(coverFile) + ".256.jpg" } : {}),
        ...(typeof item.attributes.year === "number" ? { releaseYear: item.attributes.year } : {}),
        raw: item as unknown as Record<string, unknown>,
      };
    });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    let item = this.manga.get(sourceItemId);
    if (!item) {
      const response = z.object({ result: z.literal("ok"), data: mangaSchema }).safeParse(await this.fetchJson(this.baseUrl + "/manga/" + encodeURIComponent(sourceItemId) + "?includes[]=cover_art"));
      if (!response.success) throw new Error("MangaDex 作品详情不可用，请检查来源作品 ID");
      item = response.data.data;
      this.manga.set(sourceItemId, item);
    }
    const chapters = await this.loadChapters(sourceItemId);
    const result: ResourceItem[] = [];
    for (const chapter of chapters) {
      if (!chapter.attributes.pages) continue;
      const language = chapter.attributes.translatedLanguage || "";
      const chapterName = formatChapter(chapter);
      const chapterNumber = parseNumber(chapter.attributes.chapter);
      const volumeNumber = parseNumber(chapter.attributes.volume);
      const resource: ResourceItem = {
        id: "mangadex:" + sourceItemId + ":" + chapter.id,
        sourceId: this.id,
        sourceItemId,
        title: preferredTitle(item) + " · " + chapterName,
        protocol: "http",
        targetUrl: "https://mangadex.org/chapter/" + chapter.id,
        ...(chapterNumber !== undefined ? { chapter: chapterNumber } : {}),
        ...(volumeNumber !== undefined ? { volume: volumeNumber } : {}),
        language,
        format: "CBZ",
        metadata: {
          provider: "MangaDex",
          downloadMode: "manga_cbz",
          mangaId: sourceItemId,
          chapterId: chapter.id,
          chapterName,
          seriesTitle: preferredTitle(item),
          translatedLanguage: language,
          pages: chapter.attributes.pages,
        },
        createdAt: new Date().toISOString(),
      };
      this.chapters.set(resource.id, { resource, chapterId: chapter.id });
      result.push(resource);
    }
    // Resolve @Home only when the user downloads a chapter. Probing every
    // chapter here adds many requests and hides valid entries on outages.
    if (!result.length) throw new Error("MangaDex 找到了作品，但当前中/日/英语言没有可下载图片章节；站外阅读或零页章节无法生成 CBZ，请选择其它来源。");
    return result
      .sort((left, right) => mangaLanguageScore(right.language) - mangaLanguageScore(left.language) || (left.chapter ?? 0) - (right.chapter ?? 0));
  }

  restoreResource(resource: ResourceItem): void {
    if (resource.sourceId !== this.id || resource.metadata.provider !== "MangaDex") return;
    const chapterId = metadataString(resource, "chapterId");
    if (!chapterId) throw new Error("已保存的 MangaDex 章节缺少标识，请重新搜索资源");
    this.chapters.set(resource.id, { resource, chapterId });
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const entry = this.chapters.get(resourceId);
    if (!entry) throw new Error("MangaDex 章节已过期，请重新刷新来源");
    return parseDownloadTarget(entry.resource.targetUrl);
  }

  async prepareMangaDownload(resourceId: string): Promise<MangaChapterDescriptor> {
    const entry = this.chapters.get(resourceId);
    if (!entry) throw new Error("MangaDex 章节已过期，请重新刷新来源");
    const response = atHomeResponseSchema.parse(await this.fetchJson(this.baseUrl + "/at-home/server/" + encodeURIComponent(entry.chapterId)));
    if (response.result !== "ok") throw new Error("MangaDex 章节图片服务不可用");
    const imageUrls = response.chapter.data.map((fileName) => response.baseUrl + "/data/" + response.chapter.hash + "/" + encodeURIComponent(fileName));
    if (!imageUrls.length) throw new Error("MangaDex 章节没有可下载图片");
    return {
      imageUrls,
      title: metadataString(entry.resource, "seriesTitle") || "MangaDex",
      chapter: metadataString(entry.resource, "chapterName") || "章节",
      referer: "https://mangadex.org/",
    };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.fetchJson(this.baseUrl + "/manga?title=" + encodeURIComponent("One Piece") + "&limit=1");
      const parsed = mangaSearchResponseSchema.safeParse(response);
      if (!parsed.success || parsed.data.result !== "ok") throw new Error("MangaDex API 响应无效");
      return { ok: true, checkedAt, message: "搜索接口连接正常；具体章节的图片可用性将在下载时检查" };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "MangaDex API 不可用" };
    }
  }

  private async searchManga(keyword: string): Promise<Manga[]> {
    const url = this.baseUrl + "/manga?title=" + encodeURIComponent(keyword) + "&limit=24&offset=0&order[relevance]=desc&includes[]=cover_art";
    const parsed = mangaSearchResponseSchema.safeParse(await this.fetchJson(url));
    if (!parsed.success || parsed.data.result !== "ok") throw new Error("MangaDex 搜索响应无效");
    return parsed.data.data;
  }

  private async loadChapters(mangaId: string): Promise<Chapter[]> {
    const languages = ["zh", "zh-hk", "zh-tw", "ja", "en"];
    const query = languages.map((language) => "translatedLanguage[]=" + encodeURIComponent(language)).join("&");
    const chapters = new Map<string, Chapter>();
    for (let offset = 0; offset < 2_000; offset += 100) {
      const url = this.baseUrl + "/manga/" + encodeURIComponent(mangaId) + "/feed?limit=100&offset=" + offset + "&order[volume]=asc&order[chapter]=asc&" + query;
      const parsed = chapterFeedResponseSchema.safeParse(await this.fetchJson(url));
      if (!parsed.success || parsed.data.result !== "ok") throw new Error("MangaDex 章节列表响应无效");
      const before = chapters.size;
      for (const chapter of parsed.data.data) chapters.set(chapter.id, chapter);
      if (parsed.data.data.length < 100 || chapters.size === before ||
        (parsed.data.total !== undefined && offset + 100 >= parsed.data.total)) break;
    }
    return [...chapters.values()].sort((left, right) => chapterSortValue(left) - chapterSortValue(right));
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: timeoutSignal(this.timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) throw new Error("MangaDex API HTTP " + response.status);
    return response.json();
  }
}

function titleAliases(item: Manga): string[] {
  return [
    ...Object.values(item.attributes.title),
    ...item.attributes.altTitles.flatMap((value) => Object.values(value)),
  ];
}

function preferredTitle(item: Manga): string {
  const titles = item.attributes.title;
  return titles["zh"] || titles["zh-hk"] || titles["zh-tw"] || titles.en || Object.values(titles)[0] || item.id;
}

function formatChapter(chapter: Chapter): string {
  const volume = chapter.attributes.volume ? "Vol." + chapter.attributes.volume + " " : "";
  const number = chapter.attributes.chapter ? "Ch." + chapter.attributes.chapter : "Oneshot";
  const title = chapter.attributes.title?.trim();
  return volume + number + (title ? " · " + title : "") + " [" + (chapter.attributes.translatedLanguage || "unknown") + "]";
}

function chapterSortValue(chapter: Chapter): number {
  const value = parseNumber(chapter.attributes.chapter);
  return value ?? Number.MAX_SAFE_INTEGER;
}

function parseNumber(value: string | null | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function metadataString(resource: ResourceItem, key: string): string {
  const value = resource.metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function mangaLanguageScore(language: string | undefined): number {
  return language === "zh" ? 3 : language === "zh-hk" || language === "zh-tw" ? 2 : language === "en" ? 1 : 0;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}
