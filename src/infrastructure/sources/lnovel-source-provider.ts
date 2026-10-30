import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { NovelDownloadDescriptor, NovelDownloadInput, NovelDownloadResult } from "@/domain/novel";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { isTauriRuntime } from "@/shared/runtime";
import { parseDownloadTarget } from "@/shared/validation";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";
import { sourceSearchTerms, sourceTitleMatch } from "./source-matching";

const authorSchema = z.object({ name: z.string().default(""), position: z.string().optional() }).passthrough();
const catalogNovelSchema = z.object({
  nid: z.number(), name: z.string().min(1), authors: z.array(authorSchema).default([]),
  description: z.string().optional().default(""), cover: z.string().url().optional(), labels: z.array(z.string()).default([]),
}).passthrough();
const catalogResponseSchema = z.object({ ok: z.boolean(), data: z.array(catalogNovelSchema) }).passthrough();
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
const chapterSchema = z.object({ cid: z.number(), title: z.string().min(1), content: z.string().optional().default("") }).passthrough();
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
  private readonly novels = new Map<number, CatalogNovel>();
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
        ...(novel.cover ? { coverUrl: novel.cover } : {}), raw: novel as unknown as Record<string, unknown> }];
    }
    const terms = sourceSearchTerms(query.keyword, query.aliases);
    if (!terms.length) return [];
    const catalog = await this.loadCatalog();
    const matched = catalog
      .map((item) => ({ item, score: sourceTitleMatch(item.name, terms).score }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.item.nid - right.item.nid)
      .slice(0, 12);
    this.novels.clear();
    this.resources.clear();
    return matched.map(({ item }) => {
      this.novels.set(item.nid, item);
      return {
        sourceId: this.id,
        sourceItemId: String(item.nid),
        title: item.name,
        ...(item.cover ? { coverUrl: item.cover } : {}),
        raw: item as unknown as Record<string, unknown>,
      };
    });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const nid = Number(sourceItemId);
    if (!Number.isInteger(nid) || nid < 1) return [];
    const novel = await this.loadNovel(nid);
    const result: ResourceItem[] = [];
    for (const volume of novel.volumes) {
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
        language: "简体中文",
        metadata: {
          provider: "LNovel",
          downloadMode: "novel_txt",
          novelId: nid,
          volumeId: volume.vid,
          seriesTitle: novel.name,
          volumeTitle: volume.title,
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
    const parts = [`${seriesTitle}\n${volume.name}\n`, "=".repeat(40), "\n\n"];
    input.onProgress?.({ stage: "downloading", completed: 0, total: volume.chapters.length, detail: "正在读取章节" });
    let characterCount = parts.join("").length;
    for (const [index, chapterRef] of volume.chapters.entries()) {
      if (input.isCancelled?.()) throw new Error("轻小说任务已取消");
      const chapter = await this.loadChapter(entry.nid, entry.volumeId, chapterRef.cid);
      const text = htmlToText(chapter.content ?? "");
      if (!text) throw new Error(`章节「${chapter.title}」内容为空，已停止生成以避免缺章`);
      const block = `\n\n${chapter.title}\n${"-".repeat(24)}\n${text}\n`;
      parts.push(block);
      characterCount += block.length;
      input.onProgress?.({
        stage: "downloading",
        completed: index + 1,
        total: volume.chapters.length,
        detail: `已读取第 ${index + 1}/${volume.chapters.length} 章`,
      });
    }
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
      return { ok: true, checkedAt, message: `目录连接正常，已验证 ${catalog.length} 部作品的索引；分卷和正文将在下载时检查` };
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

  private async loadNovel(nid: number): Promise<NovelDetail> {
    return this.cache.getOrLoad(`novel:${this.baseUrl}:${nid}`, 5 * 60 * 1000, async () => {
      const parsed = await this.fetchEnvelope(this.baseUrl + `/api/bili/novel/${nid}`, novelDetailSchema, "LNovel 作品详情");
      return parsed as unknown as NovelDetail;
    });
  }

  private async loadVolume(nid: number, vid: number): Promise<Volume> {
    return await this.fetchEnvelope(this.baseUrl + `/api/bili/novel/${nid}/vol/${vid}`, volumeSchema, "LNovel 分卷") as unknown as Volume;
  }

  private async loadChapter(nid: number, vid: number, cid: number): Promise<Chapter> {
    return await this.fetchEnvelope(this.baseUrl + `/api/bili/novel/${nid}/chapter/${cid}`, chapterSchema, "LNovel 章节") as unknown as Chapter;
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
      signal: AbortSignal.timeout(timeoutMs),
      timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`LNovel API HTTP ${response.status}`);
    return response.json();
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

function htmlToText(value: string): string {
  return decodeEntities(value)
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}
