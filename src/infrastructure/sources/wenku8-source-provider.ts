import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { matchAuthorName } from "@/domain/author";
import { sanitizeFileName } from "@/domain/organization";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";
import { timeoutSignal, disposeAbortSignal } from "@/shared/abort-signals";
import { parseDownloadTarget } from "@/shared/validation";
import { sourceSearchTerms, sourceTitleMatch } from "./source-matching";

export const WENKU8_EPUB_CATALOG_BASE = "https://raw.githubusercontent.com/mojimoon/wenku8/main";
const CACHE_TTL_MS = 15 * 60 * 1000;
const sharedCaches = new WeakMap<JsonFetcher, MemoryCache>();
const volumeSchema = z.object({
  index: z.number().int().positive().max(10_000),
  title: z.string().trim().min(1).max(2_000),
  file: z.string().regex(/^(?:(?:orig|1600|1400|1000|800|600|noimg)-)?v\d{2,5}\.epub$/),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chapters: z.number().int().positive().max(100_000),
  images: z.number().int().nonnegative().max(100_000).default(0),
});
const editionSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/).optional(),
  tag: z.string().optional(),
  src_update: z.string().optional(),
  built_at: z.string().optional(),
  total: z.number().int().nonnegative().max(10_000).optional(),
  volumes: z.array(volumeSchema).max(10_000).default([]),
}).passthrough();
const bookSchema = editionSchema.extend({
  title: z.string().trim().min(1).max(2_000),
  author: z.string().max(2_000).optional(),
  blocked: z.unknown().optional(),
  variants: z.record(z.string(), editionSchema).default({}),
}).passthrough();
type Book = z.infer<typeof bookSchema> & { aid: string };
type Volume = z.infer<typeof volumeSchema>;
type Edition = z.infer<typeof editionSchema> & { quality: string };
interface SelectedVolume { volume: Volume; edition: Edition }
const qualityRanks: Record<string, number> = { orig: 10_000, "1600": 1600, "1400": 1400, default: 1000, "1000": 1000, "800": 800, "600": 600, noimg: 0 };

export interface Wenku8SourceProviderOptions {
  fetcher?: JsonFetcher;
  timeoutMs?: number;
  cacheTtlMs?: number;
  pageSize?: number;
}

/** Public, prebuilt EPUB files; never invokes the upstream site's login or book builder. */
export class Wenku8EpubSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "轻小说文库 EPUB";
  readonly supportedTypes: MediaType[] = ["novel"];
  private readonly baseUrl: string;
  private readonly fetcher: JsonFetcher;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly pageSize: number;
  private readonly cache: MemoryCache;

  constructor(baseUrl = WENKU8_EPUB_CATALOG_BASE, options: Wenku8SourceProviderOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("轻小说 EPUB 目录地址必须是不带认证信息、查询参数或片段的 HTTP/HTTPS 地址");
    }
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
    this.id = "wenku8_epub:" + this.baseUrl;
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.pageSize = Number.isSafeInteger(options.pageSize) && options.pageSize! > 0 ? Math.min(options.pageSize!, 100) : 40;
    let cache = sharedCaches.get(this.fetcher);
    if (!cache) { cache = new MemoryCache(8); sharedCaches.set(this.fetcher, cache); }
    this.cache = cache;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "novel") return [];
    const terms = sourceSearchTerms(query.keyword, query.aliases);
    if (!terms.length) return [];
    const directId = /^\d+$/.test(query.keyword.trim()) ? query.keyword.trim() : undefined;
    const books = await this.loadCatalog();
    const matched = books.map((book) => ({ book, score: directId === book.aid ? 110
      : Math.max(sourceTitleMatch(book.title, terms, [], { allowShortCjk: true }).score,
        book.author && terms.some((term) => matchAuthorName({ name: book.author!, aliases: [] }, term) === 100) ? 100 : 0) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || Number(a.book.aid) - Number(b.book.aid));
    const page = Number.isSafeInteger(query.page) && query.page! > 0 ? query.page! : 1;
    return matched.slice((page - 1) * this.pageSize, page * this.pageSize).map(({ book }) => {
      const selected = bestVolumes(book);
      const total = Math.max(book.total ?? 0, ...Object.values(book.variants).map((edition) => edition.total ?? 0));
      return {
      sourceId: this.id, sourceItemId: book.aid, title: book.title,
      raw: {
        provider: "轻小说文库 EPUB", authors: book.author ? [book.author] : [],
        editionLabel: "简体中文 · 按卷 EPUB",
        status: blocked(book) ? "来源标记版权下架，暂无可下载 EPUB"
          : selected.length ? `已生成 ${selected.length}${total > selected.length ? `/${total}` : ""} 卷`
            : "尚无已生成的 EPUB 分卷",
        chapterCount: selected.reduce((sum, item) => sum + item.volume.chapters, 0),
        catalogStatus: blocked(book) ? "blocked" : selected.length ? "available" : "pending",
        description: "公开预生成 EPUB 目录，保留分卷和插图文件；收录与清晰度取决于上游，附件可用性在下载时核实。",
      },
    }; });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    if (!validAid(sourceItemId)) return [];
    const book = (await this.loadCatalog()).find((item) => item.aid === sourceItemId);
    if (!book) return [];
    assertAvailable(book);
    return bestVolumes(book).map(({ volume, edition }) => {
      const target = parseDownloadTarget(assetUrl(book, volume, edition));
      return {
        id: `${this.id}:${book.aid}:${volume.index}${edition.quality === "default" ? "" : `:${edition.quality}`}`,
        sourceId: this.id, sourceItemId: book.aid,
        title: `${book.title} · ${volume.title}`,
        protocol: target.protocol, targetUrl: target.url,
        format: "EPUB", language: "简体中文", sizeBytes: volume.size, volume: volume.index,
        metadata: {
          provider: "轻小说文库 EPUB", downloadMode: "direct",
          seriesTitle: book.title, volumeTitle: volume.title, volumeOrder: volume.index,
          authors: book.author ? [book.author] : [], novelId: book.aid, chapterCount: volume.chapters,
          imageCount: volume.images, imageQuality: edition.quality, imageQualityLabel: qualityLabel(edition.quality),
          releaseTag: edition.tag, releaseRepository: edition.repo,
          sourceUpdatedAt: book.src_update, builtAt: edition.built_at,
          originalFileName: `${book.aid}-${volume.file}`, downloadFileName: friendlyFilename(book, volume, edition),
          resourceLabel: volume.images ? `EPUB 直链 · ${qualityLabel(edition.quality)}` : "EPUB 直链 · 本卷无插图",
          contentNote: "直接保存来源生成的 EPUB，不重编码；插图尺寸由上游提供，并非原图清晰度保证。",
        },
        createdAt: new Date().toISOString(),
      };
    });
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const prefix = this.id + ":";
    const identity = resourceId.startsWith(prefix) ? resourceId.slice(prefix.length).match(/^([1-9]\d*):([1-9]\d*)(?::(orig|1600|1400|1000|800|600|noimg))?$/) : null;
    if (!identity || !validAid(identity[1])) throw new Error("EPUB 资源身份无效，请重新选择分卷");
    // Reconstruct from the current public catalogue, never trust a stored targetUrl.
    const book = (await this.loadCatalog()).find((item) => item.aid === identity[1]);
    if (!book) throw new Error("该轻小说已不在当前 EPUB 目录中，请刷新来源");
    assertAvailable(book);
    const quality = identity[3] ?? "default";
    const edition = editions(book).find((item) => item.quality === quality);
    const volume = edition?.volumes.find((item) => item.index === Number(identity[2]));
    if (!volume) throw new Error("该 EPUB 分卷已不在当前目录中，请刷新来源");
    return { ...parseDownloadTarget(assetUrl(book, volume, edition!)), filename: friendlyFilename(book, volume, edition!) };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const books = await this.requestCatalog();
      this.cache.set(this.baseUrl, books, this.cacheTtlMs);
      const available = books.filter((book) => !blocked(book) && bestVolumes(book).length).length;
      return { ok: true, checkedAt, message: `已读取 ${available} 部含分卷 EPUB 的作品索引；版权下架条目不提供资源，附件可用性在下载时核实` };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "轻小说 EPUB 目录暂不可用" };
    }
  }

  private async loadCatalog(): Promise<Book[]> {
    return this.cache.getOrLoad(this.baseUrl, this.cacheTtlMs, () => this.requestCatalog());
  }

  private async requestCatalog(): Promise<Book[]> {
    const signal = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetcher(this.baseUrl + "/out/epub_index.json", {
        method: "GET", headers: { Accept: "application/json" }, signal, timeoutMs: this.timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`轻小说 EPUB 目录 HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("轻小说 EPUB 目录响应格式无效");
      const entries = Object.entries(payload);
      if (entries.length > 50_000) throw new Error("轻小说 EPUB 目录过大，请检查来源地址");
      const books: Book[] = [];
      for (const [aid, value] of entries) {
        if (!validAid(aid)) continue;
        const parsed = bookSchema.safeParse(value);
        if (!parsed.success) continue;
        const book = { ...parsed.data, aid };
        if (!blocked(book) && book.volumes.length && !validEdition(book, aid, "default")) continue;
        book.variants = Object.fromEntries(Object.entries(book.variants).filter(([quality, edition]) =>
          quality !== "default" && Object.hasOwn(qualityRanks, quality) && validEdition(edition, aid, quality)));
        // A withdrawn record may still contain obsolete file metadata. Never expose it.
        if (blocked(book)) { book.volumes = []; book.variants = {}; }
        books.push(book);
      }
      if (!books.length) throw new Error("轻小说 EPUB 目录没有有效作品，请检查来源响应");
      return books;
    } finally { disposeAbortSignal(signal); }
  }
}

function validAid(value: string): boolean { return /^[1-9]\d{0,8}$/.test(value); }
function blocked(book: Book): boolean { return book.blocked !== undefined && book.blocked !== null && book.blocked !== false && book.blocked !== ""; }
function validEdition(edition: z.infer<typeof editionSchema>, aid: string, quality: string): boolean {
  return Boolean(edition.repo) && edition.tag === `book-${aid}` && validVolumes(edition.volumes, quality);
}
function validVolumes(volumes: Volume[], quality: string): boolean {
  const indexes = new Set<number>();
  for (const volume of volumes) {
    const match = volume.file.match(/^(?:(orig|1600|1400|1000|800|600|noimg)-)?v(\d+)\.epub$/);
    if (!match || (match[1] ?? "default") !== quality || Number(match[2]) !== volume.index || indexes.has(volume.index)) return false;
    indexes.add(volume.index);
  }
  return true;
}
function assertAvailable(book: Book): void {
  if (blocked(book)) throw new Error("该作品已被来源标记为版权下架，当前不提供 EPUB 下载；衍生篇是独立作品");
  if (!bestVolumes(book).length) throw new Error("该作品尚无已生成的 EPUB 分卷，未提供空文件或替代作品");
}
function editions(book: Book): Edition[] {
  if (blocked(book)) return [];
  return [{ ...book, quality: "default" }, ...Object.entries(book.variants).map(([quality, edition]) => ({ ...edition, quality }))]
    .filter((edition) => edition.volumes.length)
    .sort((a, b) => qualityRanks[b.quality] - qualityRanks[a.quality]);
}
function bestVolumes(book: Book): SelectedVolume[] {
  const selected = new Map<number, SelectedVolume>();
  for (const edition of editions(book)) for (const volume of edition.volumes) {
    if (!selected.has(volume.index)) selected.set(volume.index, { volume, edition });
  }
  return [...selected.values()].sort((a, b) => a.volume.index - b.volume.index);
}
function qualityLabel(quality: string): string {
  return quality === "orig" ? "插图原图版（来源标记）" : quality === "default" ? "来源默认插图" : quality === "noimg" ? "无插图版" : `插图长边 ${quality}px（来源标记）`;
}
function assetUrl(book: Book, volume: Volume, edition: Edition): string {
  return `https://github.com/${edition.repo}/releases/download/${encodeURIComponent(edition.tag!)}/${book.aid}-${volume.file}`;
}
function friendlyFilename(book: Book, volume: Volume, edition: Edition): string {
  const suffix = edition.quality === "default" ? "" : edition.quality === "orig" ? " - 原图版"
    : edition.quality === "noimg" ? " - 无插图版" : ` - 插图${edition.quality}px`;
  return sanitizeFileName(`${book.title} - ${volume.title}`).slice(0, 155) + suffix + ".epub";
}
