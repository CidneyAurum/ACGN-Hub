import { timeoutSignal } from "@/shared/abort-signals";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { NovelDownloadDescriptor, NovelDownloadInput, NovelDownloadResult } from "@/domain/novel";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { matchAuthorName } from "@/domain/author";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { isTauriRuntime } from "@/shared/runtime";
import { parseDownloadTarget } from "@/shared/validation";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";
import { sourceSearchTerms, sourceTitleMatch } from "./source-matching";
import { novelHtmlToText } from "./novel-text";

const authorSchema = z.object({ name: z.string().default(""), position: z.string().optional() }).passthrough();
const catalogNovelSchema = z.object({
  nid: z.number(), name: z.string().min(1), authors: z.array(authorSchema).default([]),
  description: z.string().optional().default(""), cover: z.string().url().optional(), labels: z.array(z.string()).default([]),
}).passthrough();
const catalogResponseSchema = z.object({ ok: z.boolean(), data: z.array(catalogNovelSchema) }).passthrough();
const indexResponseSchema = z.object({ ok: z.boolean(), data: z.object({ items: z.array(z.object({
  nid: z.number(), title: z.string().min(1), author: z.string().optional(), cover: z.string().url().optional(),
  description: z.string().default(""), status: z.string().optional(), latestChapter: z.string().optional(),
}).passthrough()) }) }).passthrough();
const volumeRefSchema = z.object({ nid: z.number(), vid: z.number(), title: z.string().min(1), volume: z.string().optional() }).passthrough();
const novelDetailSchema = z.object({
  nid: z.number(), name: z.string().min(1), description: z.string().optional().default(""),
  authors: z.array(authorSchema).default([]), cover: z.string().url().optional(),
  volumes: z.array(volumeRefSchema).default([]),
}).passthrough();
const volumeSchema = z.object({
  nid: z.number(), vid: z.number(), name: z.string().min(1),
  chapters: z.array(z.object({ nid: z.number(), vid: z.number(), cid: z.number(), title: z.string().min(1) }).passthrough()).default([]),
}).passthrough();
const chapterSchema = z.object({
  cid: z.number(), nid: z.number().optional(), vid: z.number().optional(), title: z.string().min(1),
  content: z.string().optional().default(""), images: z.array(z.unknown()).optional().default([]),
}).passthrough();
const envelopeSchema = z.object({ ok: z.boolean(), data: z.unknown() }).passthrough();

type CatalogNovel = z.infer<typeof catalogNovelSchema>;
interface NovelDetail {
  nid: number;
  name: string;
  description?: string;
  authors: Array<{ name: string; position?: string }>;
  cover?: string;
  volumes: Array<{ nid: number; vid: number; title: string; volume?: string }>;
}
interface Volume {
  nid: number;
  vid: number;
  name: string;
  chapters: Array<{ nid: number; vid: number; cid: number; title: string }>;
}
interface Chapter {
  cid: number;
  title: string;
  content?: string;
  images?: unknown[];
}

interface LNovelSourceProviderOptions {
  fetcher?: JsonFetcher;
  timeoutMs?: number;
  catalogTimeoutMs?: number;
}

const CATALOG_TTL_MS = 30 * 60 * 1000;
const sharedCaches = new WeakMap<JsonFetcher, MemoryCache>();

interface NovelResourceEntry {
  nid: number;
  volumeId: number;
  seriesTitle?: string;
}

/** LNovel's cached Chinese light-novel catalogue and chapter API. */
export class LNovelSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "LNovel 中文轻小说";
  readonly supportedTypes: MediaType[] = ["novel"];
  private readonly baseUrl: string;
  private readonly fetcher: JsonFetcher;
  private readonly timeoutMs: number;
  private readonly catalogTimeoutMs: number;
  private readonly cache: MemoryCache;
  private readonly resources = new Map<string, NovelResourceEntry>();

  constructor(baseUrl = "https://lnovel.animes.garden", options: LNovelSourceProviderOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("LNovel API 地址必须是不带认证信息的 HTTP/HTTPS 地址");
    }
    this.baseUrl = parsed.origin;
    this.id = "lnovel:" + this.baseUrl;
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.catalogTimeoutMs = options.catalogTimeoutMs ?? 35_000;
    let cache = sharedCaches.get(this.fetcher);
    if (!cache) { cache = new MemoryCache(32); sharedCaches.set(this.fetcher, cache); }
    this.cache = cache;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "novel") return [];
    const directId = novelIdFromQuery(query.keyword, this.baseUrl);
    if (directId !== undefined) {
      const novel = await this.loadNovel(directId);
      return [{ sourceId: this.id, sourceItemId: String(directId), title: novel.name,
        ...(novel.cover ? { coverUrl: novel.cover } : {}), raw: novelSearchMetadata(novel) }];
    }
    const terms = sourceSearchTerms(query.keyword, query.aliases);
    if (!terms.length) return [];
    let catalog: CatalogNovel[] = [];
    let catalogFailure: unknown;
    try { catalog = await this.loadCatalog(); } catch (cause) { catalogFailure = cause; }
    const cachedMatches = catalog.filter((item) => item.isDeleted !== true &&
      (sourceTitleMatch(item.name, terms, [], { allowShortCjk: true }).score > 0 || authorMatch(item.authors, terms)));
    // /novels is only the materialized chapter cache. Popular original works
    // can be absent while their spin-offs are cached; consult the official
    // live index before concluding that only a derivative work is available.
    if (!cachedMatches.length || cachedMatches.every((item) => sourceTitleMatch(item.name, terms).warnings.length > 0 && !authorMatch(item.authors, terms))) {
      const supplements = await Promise.allSettled([this.loadPopularIndex("monthvisit"), this.loadPopularIndex("weekvisit")]);
      const merged = new Map(catalog.map((item) => [item.nid, item]));
      for (const result of supplements) if (result.status === "fulfilled") {
        for (const item of result.value) if (!merged.has(item.nid)) merged.set(item.nid, item);
      }
      catalog = [...merged.values()];
      if (!catalog.length && catalogFailure) throw catalogFailure;
    }
    const matched = catalog
      .filter((item) => item.isDeleted !== true)
      .map((item) => ({ item, score: Math.max(sourceTitleMatch(item.name, terms, [], { allowShortCjk: true }).score, authorMatch(item.authors, terms) ? 100 : 0) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.item.nid - right.item.nid)
      .slice(0, 12);
    return matched.map(({ item }) => {
      return {
        sourceId: this.id,
        sourceItemId: String(item.nid),
        title: item.name,
        ...(item.cover ? { coverUrl: item.cover } : {}),
        raw: novelSearchMetadata(item),
      };
    });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const nid = Number(sourceItemId);
    if (!Number.isInteger(nid) || nid < 1) return [];
    const novel = await this.loadNovel(nid);
    const result: ResourceItem[] = [];
    for (const [index, volume] of novel.volumes.entries()) {
      if (volume.nid !== nid || !Number.isSafeInteger(volume.vid) || volume.vid < 1) throw new Error("LNovel 分卷身份不匹配，请刷新来源后重试");
      const targetUrl = this.volumeUrl(nid, volume.vid);
      const target = parseDownloadTarget(targetUrl);
      const resource: ResourceItem = {
        id: `${this.id}:${nid}:${volume.vid}`,
        sourceId: this.id,
        sourceItemId: String(nid),
        title: `${novel.name} · ${volume.title}`,
        protocol: target.protocol,
        targetUrl: target.url,
        format: "TXT",
        volume: index + 1,
        language: "简体中文",
        metadata: {
          provider: "LNovel",
          downloadMode: "novel_txt",
          novelId: nid,
          volumeId: volume.vid,
          seriesTitle: novel.name,
          volumeTitle: volume.title,
          volumeOrder: index + 1,
          authors: authorNames(novel.authors),
          contentNote: "中文纯文本，不含插图；收录与更新取决于上游缓存",
        },
        createdAt: new Date().toISOString(),
      };
      this.resources.set(resource.id, { nid, volumeId: volume.vid, seriesTitle: novel.name });
      result.push(resource);
    }
    return result;
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const entry = this.entryFor(resourceId);
    return parseDownloadTarget(this.volumeUrl(entry.nid, entry.volumeId));
  }

  async prepareNovelDownload(resourceId: string): Promise<NovelDownloadDescriptor> {
    const entry = this.entryFor(resourceId);
    const novel = await this.loadNovel(entry.nid);
    const volume = await this.loadVolume(entry.nid, entry.volumeId);
    if (!volume.chapters.length) throw new Error("该分卷没有可下载章节，未生成空 TXT");
    return {
      title: entry.seriesTitle || novel.name,
      volume: volume.name,
      chapterCount: volume.chapters.length,
    };
  }

  async downloadNovel(resourceId: string, input: NovelDownloadInput): Promise<NovelDownloadResult> {
    if (!isTauriRuntime()) throw new Error("轻小说 TXT 下载只在桌面端可用");
    const entry = this.entryFor(resourceId);
    const novel = await this.loadNovel(entry.nid);
    const volume = await this.loadVolume(entry.nid, entry.volumeId);
    if (!volume.chapters.length) throw new Error("该分卷没有可下载章节，未生成空 TXT");
    const seriesTitle = entry.seriesTitle || novel.name;
    const parts = [`${seriesTitle}\n${volume.name}\n`, "TXT 纯文本版本，不含原书插图。\n", "=".repeat(40), "\n\n"];
    input.onProgress?.({ stage: "downloading", completed: 0, total: volume.chapters.length, detail: "正在读取章节" });
    let textChapters = 0;
    for (const [index, chapterRef] of volume.chapters.entries()) {
      if (input.isCancelled?.()) throw new Error("轻小说任务已取消");
      const chapter = await this.loadChapter(entry.nid, entry.volumeId, chapterRef.cid);
      const plain = novelHtmlToText(chapter.content ?? "");
      const hasImages = Boolean(chapter.images?.length) || /<img\b/i.test(chapter.content ?? "");
      if (!plain && !hasImages) throw new Error(`章节「${chapter.title}」内容为空，已停止生成以避免缺章`);
      const text = plain || "[本章为图片，TXT 版本不含插图]";
      if (plain) textChapters += 1;
      const block = `\n\n${chapter.title}\n${"-".repeat(24)}\n${text}\n`;
      parts.push(block);
      input.onProgress?.({
        stage: "downloading",
        completed: index + 1,
        total: volume.chapters.length,
        detail: `已读取第 ${index + 1}/${volume.chapters.length} 章`,
      });
    }
    if (!textChapters) throw new Error("本卷仅含图片，没有可生成 TXT 的正文");
    const content = parts.join("").trim() + "\n";
    if (input.isCancelled?.()) throw new Error("轻小说任务已取消");
    input.onProgress?.({ stage: "packaging", completed: volume.chapters.length, total: volume.chapters.length, detail: "正在写入 TXT" });
    await invoke("write_text_file", {
      content,
      outputRoot: input.outputRoot,
      outputPath: input.outputPath,
    });
    return { outputPath: input.outputPath, chapterCount: volume.chapters.length, characterCount: content.length };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const catalog = await this.requestCatalog();
      this.cache.set(`catalog:${this.baseUrl}`, catalog, CATALOG_TTL_MS);
      return { ok: true, checkedAt, message: `已读取 ${catalog.length} 部已缓存作品的索引；搜索不足时补查原站周/月榜，目录和正文在打开或下载时另行核实` };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "LNovel 不可用" };
    }
  }

  private async loadCatalog(): Promise<CatalogNovel[]> {
    return this.cache.getOrLoad(`catalog:${this.baseUrl}`, CATALOG_TTL_MS, () => this.requestCatalog());
  }

  private async requestCatalog(): Promise<CatalogNovel[]> {
    const parsed = catalogResponseSchema.safeParse(await this.fetchJson(this.baseUrl + "/api/bili/novels", this.catalogTimeoutMs));
    if (!parsed.success || !parsed.data.ok) throw new Error("LNovel 中文轻小说目录响应无效");
    return parsed.data.data;
  }

  private async loadPopularIndex(sort: "monthvisit" | "weekvisit"): Promise<CatalogNovel[]> {
    return this.cache.getOrLoad(`index:${this.baseUrl}:${sort}`, 10 * 60_000, async () => {
      const parsed = indexResponseSchema.safeParse(await this.fetchJson(this.baseUrl + `/api/bili/top/${sort}`, this.catalogTimeoutMs));
      if (!parsed.success || !parsed.data.ok) throw new Error("LNovel 实时榜单索引响应无效");
      return parsed.data.data.items.map((item) => ({ ...item, name: item.title,
        authors: item.author ? [{ name: item.author, position: "author" }] : [], labels: [],
        catalogueScope: "popular-index", sourceIndex: sort }));
    });
  }

  private async loadNovel(nid: number): Promise<NovelDetail> {
    return this.cache.getOrLoad(`novel:${this.baseUrl}:${nid}`, 5 * 60 * 1000, async () => {
      const parsed = await this.fetchEnvelope(this.baseUrl + `/api/bili/novel/${nid}`, novelDetailSchema, "LNovel 作品详情");
      if (parsed.nid !== nid) throw new Error("LNovel 作品身份不匹配，请重新搜索");
      if (parsed.isDeleted === true) throw new Error(lnovelErrorMessage(200, { message: "taken down" }));
      return parsed as unknown as NovelDetail;
    });
  }

  private async loadVolume(nid: number, vid: number): Promise<Volume> {
    return this.cache.getOrLoad(`volume:${this.baseUrl}:${nid}:${vid}`, 60_000, async () => {
      const volume = await this.fetchEnvelope(this.baseUrl + `/api/bili/novel/${nid}/vol/${vid}`, volumeSchema, "LNovel 分卷");
      if (volume.isDeleted === true) throw new Error("LNovel 来源已下架此分卷，请选择其它来源或版本");
      if (volume.nid !== nid || volume.vid !== vid || volume.chapters.some((chapter) => chapter.nid !== nid || chapter.vid !== vid) || new Set(volume.chapters.map((chapter) => chapter.cid)).size !== volume.chapters.length) {
        throw new Error("LNovel 分卷或章节身份不匹配，已停止下载，请刷新来源");
      }
      return volume as unknown as Volume;
    });
  }

  private async loadChapter(nid: number, vid: number, cid: number): Promise<Chapter> {
    return this.cache.getOrLoad(`chapter:${this.baseUrl}:${nid}:${vid}:${cid}`, 5 * 60_000, async () => {
      const chapter = await this.fetchEnvelope(this.baseUrl + `/api/bili/novel/${nid}/chapter/${cid}`, chapterSchema, "LNovel 章节");
      if (chapter.isDeleted === true) throw new Error(lnovelErrorMessage(200, { message: "taken down" }));
      if (chapter.cid !== cid || chapter.nid !== undefined && chapter.nid !== nid || chapter.vid !== undefined && chapter.vid !== vid) {
        throw new Error("LNovel 返回了其它作品或卷的章节，已停止下载");
      }
      return chapter as unknown as Chapter;
    });
  }

  private volumeUrl(nid: number, vid: number): string {
    return this.baseUrl + `/api/bili/novel/${nid}/vol/${vid}`;
  }

  /** Stored resource rows survive app restart, unlike this in-memory map. */
  private entryFor(resourceId: string): NovelResourceEntry {
    const cached = this.resources.get(resourceId);
    if (cached) return cached;
    if (!resourceId.startsWith(`${this.id}:`)) throw new Error("轻小说资源不属于当前来源，请重新搜索");
    const match = resourceId.match(/:(\d+):(\d+)$/);
    const nid = Number(match?.[1]);
    const volumeId = Number(match?.[2]);
    if (!Number.isInteger(nid) || nid < 1 || !Number.isInteger(volumeId) || volumeId < 1) {
      throw new Error("LNovel 卷资源已过期，请重新搜索");
    }
    return { nid, volumeId };
  }

  private async fetchEnvelope<T extends z.ZodTypeAny>(url: string, schema: T, label: string): Promise<z.output<T>> {
    const envelope = envelopeSchema.safeParse(await this.fetchJson(url));
    if (!envelope.success || !envelope.data.ok) throw new Error(`${label}响应无效`);
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) throw new Error(`${label}响应无效`);
    return parsed.data;
  }

  private async fetchJson(url: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    const response = await this.fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: timeoutSignal(timeoutMs),
      timeoutMs,
    });
    let body: unknown;
    try { body = await response.json(); }
    catch {
      if (response.status >= 200 && response.status < 300) throw new Error("LNovel API 未返回有效 JSON，未把网页或错误页当作小说正文");
    }
    if (response.status < 200 || response.status >= 300 || body && typeof body === "object" && "ok" in body && body.ok === false) {
      throw new Error(lnovelErrorMessage(response.status, body));
    }
    return body;
  }
}

function novelIdFromQuery(value: string, baseUrl: string): number | undefined {
  const text = value.trim();
  if (/^\d{1,9}$/.test(text) && Number(text) > 0) return Number(text);
  try {
    const url = new URL(text);
    if (url.origin !== baseUrl && !/(?:^|\.)linovelib\.com$/i.test(url.hostname)) return undefined;
    const match = url.pathname.match(/\/(?:api\/bili\/|bili\/)?novel\/(\d+)(?:\.html|\/|$)/);
    return match && Number(match[1]) > 0 ? Number(match[1]) : undefined;
  } catch { return undefined; }
}

function authorNames(authors: NovelDetail["authors"]): string[] {
  return [...new Set(authors.filter((author) => !author.position || author.position === "author").map((author) => author.name.trim()).filter(Boolean))];
}
function authorMatch(authors: NovelDetail["authors"], terms: string[]): boolean {
  return terms.some((term) => authorNames(authors).some((name) => matchAuthorName({ name, aliases: [] }, term) === 100));
}
function novelSearchMetadata(novel: CatalogNovel | NovelDetail): Record<string, unknown> {
  const scope = "catalogueScope" in novel ? novel.catalogueScope : "cached";
  return { ...novel, description: novelHtmlToText(novel.description ?? ""), authors: authorNames(novel.authors), credits: novel.authors, provider: "LNovel", language: "zh",
    catalogueScope: scope,
    ...(scope === "popular-index" ? { warnings: ["来自原站实时榜单；章节缓存未收录此作品，目录和正文需另行核实"] } : {}) };
}

/** Classify public API errors without exposing upstream traces or implementation details. */
function lnovelErrorMessage(status: number, body: unknown): string {
  const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message.slice(0, 4_096) : "";
  if (/taken down|has been removed|已下架|已[刪删]除/i.test(message)) return "LNovel 来源已下架此作品或章节，请选择其它来源或版本";
  if (status === 408 || /remote browser.*disabled|scrapeless.*disabled|disabled until|request timeout/i.test(message)) {
    return "LNovel 作品索引存在，但来源当前无法取得未缓存的目录或正文，请稍后重试；已缓存作品仍可使用";
  }
  if (status === 429) return "LNovel 来源当前请求繁忙，请稍后重试";
  return status >= 200 && status < 300 ? "LNovel API 响应无效，请稍后重试" : `LNovel API HTTP ${status}，来源暂时未能提供有效内容`;
}
