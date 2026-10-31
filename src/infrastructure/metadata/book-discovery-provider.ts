import { z } from "zod";
import type { Media } from "@/domain/media";
import { normalizeImageUrl } from "@/infrastructure/media/image-loader";
import { abortableRequest } from "./abortable-request";
import { createJsonFetcher, type JsonFetcher } from "./json-transport";
import { classifyBangumiBook, isBangumiLightNovel } from "./bangumi-book-kind";

export type BookDiscoveryType = "manga" | "novel";
/** `recent` is recent releases ordered by popularity, not a chapter-update feed. */
export type BookDiscoverySort = "heat" | "score" | "recent";
export const BOOK_DISCOVERY_PAGE_SIZE = 24;
const API_PAGE_SIZE = 20;
const NOVEL_FIRST_BATCH_SIZE = 8;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_PREFIX = "acgn-hub.discovery-book.v1";
const ENDPOINT = "https://api.bgm.tv/v0/search/subjects";
type BookCacheStorage = Pick<Storage, "getItem" | "setItem">;

export interface BookDiscoveryResult {
  type: BookDiscoveryType;
  sort: BookDiscoverySort;
  items: Media[];
  /** Matching upstream hits, before defensive classification/cover validation. */
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  updatedAt: string;
  cached: boolean;
  stale: boolean;
  /** A valid prefix of this page is available; retry this page before advancing. */
  partial?: boolean;
  warning?: string;
}

export interface BookDiscoveryOptions {
  page?: number;
  sort?: BookDiscoverySort;
  refresh?: boolean;
  signal?: AbortSignal;
  fetcher?: JsonFetcher;
  now?: () => number;
  timeoutMs?: number;
  /** null disables persistent caching. */
  storage?: BookCacheStorage | null;
  /** Valid cached or newly received books can render before the remaining request finishes. */
  onProgress?: (result: BookDiscoveryResult) => void;
}

const subjectSchema = z.object({
  id: z.number().int().positive(),
  type: z.number().int(),
  name: z.string().trim().min(1),
  name_cn: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  platform: z.string().nullable().optional(),
  nsfw: z.boolean().optional(),
  tags: z.array(z.unknown()).optional(),
  meta_tags: z.array(z.string()).optional(),
  images: z.object({
    large: z.string().nullable().optional(),
    medium: z.string().nullable().optional(),
    common: z.string().nullable().optional(),
    small: z.string().nullable().optional(),
  }).nullable().optional(),
  image: z.string().nullable().optional(),
  rating: z.object({ score: z.number().min(0).max(10).optional(), total: z.number().int().nonnegative().optional(), rank: z.number().int().nonnegative().optional() }).nullable().optional(),
  collection: z.object({
    wish: z.number().int().nonnegative().optional(),
    collect: z.number().int().nonnegative().optional(),
    doing: z.number().int().nonnegative().optional(),
    on_hold: z.number().int().nonnegative().optional(),
    dropped: z.number().int().nonnegative().optional(),
  }).nullable().optional(),
}).passthrough();
type BookSubject = z.infer<typeof subjectSchema>;
const responseSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(API_PAGE_SIZE),
  offset: z.number().int().nonnegative(),
  // One damaged subject must not hide an otherwise useful discovery page.
  data: z.array(z.unknown()).max(API_PAGE_SIZE),
});
const cachedMediaSchema = z.object({
  id: z.string().regex(/^bangumi:\d+$/),
  type: z.enum(["manga", "novel"]),
  title: z.string().trim().min(1),
  originalTitle: z.string().optional(),
  aliases: z.array(z.string()),
  description: z.string().optional(),
  coverUrl: z.string(),
  releaseYear: z.number().int().positive().optional(),
  externalIds: z.array(z.object({ provider: z.string(), value: z.string() })),
  metadata: z.record(z.string(), z.unknown()),
});
const cacheSchema = z.object({
  version: z.literal(1),
  type: z.enum(["manga", "novel"]),
  sort: z.enum(["heat", "score", "recent"]),
  page: z.number().int().positive(),
  pageSize: z.literal(BOOK_DISCOVERY_PAGE_SIZE),
  items: z.array(cachedMediaSchema).max(BOOK_DISCOVERY_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  partial: z.boolean().optional(),
  updatedAt: z.string().datetime(),
});

/**
 * Official contract: https://github.com/bangumi/api/blob/master/open-api/v0.yaml
 * type=1 includes all books. Exact category/tag checks below keep comic adaptations
 * out of light novels even when user-supplied tags contain both categories.
 * The public search supports heat/score, but no chronological sort: recent is a
 * rolling release-year filter plus heat, displayed as “近一年热门”.
 */
export async function getBookDiscovery(type: BookDiscoveryType, options: BookDiscoveryOptions = {}): Promise<BookDiscoveryResult> {
  if (type !== "manga" && type !== "novel") throw new RangeError("书籍分类无效");
  const sort = options.sort ?? "heat";
  if (!["heat", "score", "recent"].includes(sort)) throw new RangeError("书籍排序无效");
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(page * BOOK_DISCOVERY_PAGE_SIZE)) throw new RangeError("书籍页码无效");
  const now = options.now ?? Date.now;
  const timestamp = now();
  if (!Number.isFinite(timestamp)) throw new RangeError("书籍更新时间无效");
  const timeoutMs = options.timeoutMs ?? (type === "novel" ? 20_000 : 12_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("书籍请求超时设置无效");
  const boundedTimeout = Math.min(35_000, timeoutMs);
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const key = `${CACHE_PREFIX}:${type}:${sort}:page${page}`;
  const range = recentDateRange(timestamp);
  const cached = readCache(storage, key, type, sort, page, range);
  const age = cached ? timestamp - Date.parse(cached.updatedAt) : Infinity;
  if (options.signal?.aborted) throw cancellationReason(options.signal);
  if (!options.refresh && cached && !cached.partial && age >= 0 && age < CACHE_TTL_MS) return { ...cached, cached: true, stale: false };
  // Show a usable saved shelf immediately, without changing its original date.
  if (cached?.items.length) options.onProgress?.({ ...cached, cached: true, stale: age < 0 || age >= CACHE_TTL_MS,
    warning: "正在更新推荐，先显示已保存的目录" });

  const controller = new AbortController();
  const cancel = () => controller.abort(cancellationReason(options.signal!));
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("书籍推荐请求超时", "TimeoutError")), boundedTimeout);
  const offset = (page - 1) * BOOK_DISCOVERY_PAGE_SIZE;
  const fetcher = options.fetcher ?? createJsonFetcher();
  const filter = {
    type: [1], tag: [type === "manga" ? "漫画" : "轻小说"], nsfw: false,
    ...(sort === "score" ? { rating_count: [">=50"] } : {}),
    ...(sort === "recent" ? { air_date: [`>=${range.start}`, `<${range.end}`] } : {}),
  };
  const rawSubjects: unknown[] = [];
  let total = 0;
  let latest: BookDiscoveryResult | undefined;
  const makeResult = (partial: boolean): BookDiscoveryResult => ({
    type, sort, items: discoveryItems(rawSubjects, type, sort, range), total, page, pageSize: BOOK_DISCOVERY_PAGE_SIZE,
    hasMore: rawSubjects.length > 0 && offset + BOOK_DISCOVERY_PAGE_SIZE < total,
    updatedAt: new Date(now()).toISOString(), cached: false, stale: false, partial,
  });
  const saveResult = (result: BookDiscoveryResult) => {
    if (result.partial && cached && !cached.partial && cached.items.length >= result.items.length) return;
    try { storage?.setItem(key, JSON.stringify({ version: 1, ...result })); } catch { /* Quota/private mode must not hide discoveries. */ }
  };
  try {
    while (rawSubjects.length < BOOK_DISCOVERY_PAGE_SIZE) {
      const requestOffset = offset + rawSubjects.length;
      const firstLimit = type === "novel" && page === 1 && rawSubjects.length === 0 ? NOVEL_FIRST_BATCH_SIZE : API_PAGE_SIZE;
      const requestLimit = Math.min(firstLimit, BOOK_DISCOVERY_PAGE_SIZE - rawSubjects.length);
      const response = await abortableRequest(() => requestPage(fetcher, requestOffset, requestLimit, filter, sort, controller.signal, boundedTimeout), controller.signal);
      if (!rawSubjects.length) total = response.total;
      rawSubjects.push(...response.data);
      const complete = !response.data.length || response.data.length < response.limit || offset + rawSubjects.length >= total || rawSubjects.length >= BOOK_DISCOVERY_PAGE_SIZE;
      latest = makeResult(!complete);
      if (latest.items.length || complete) {
        saveResult(latest);
        if (!complete) options.onProgress?.({ ...latest, warning: "已显示首批推荐，正在补全这一页" });
      }
      if (complete) return latest;
    }
    return latest!;
  } catch (cause) {
    // Switching categories must never restore the abandoned category's cache.
    if (options.signal?.aborted) throw cancellationReason(options.signal);
    if (cached && !cached.partial && latest?.items.length && cached.items.length >= latest.items.length) {
      return { ...cached, cached: true, stale: true, warning: "书籍推荐未能完整更新，正在显示该分类的已保存目录" };
    }
    if (latest?.items.length) return { ...latest, partial: true,
      warning: "已保留本页已获取的推荐，其余条目暂未加载；可点击补全本页重试" };
    if (cached) return { ...cached, cached: true, stale: true, warning: "书籍推荐暂时无法更新，正在显示该分类的缓存" };
    if (controller.signal.aborted) throw controller.signal.reason;
    throw cause;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function discoveryItems(rawSubjects: unknown[], type: BookDiscoveryType, sort: BookDiscoverySort, range: { start: string; end: string }): Media[] {
  const seen = new Set<number>();
  return rawSubjects.flatMap((value) => {
    const parsedSubject = subjectSchema.safeParse(value);
    if (!parsedSubject.success) return [];
    const subject = parsedSubject.data;
    if (!usableSubject(subject, type, sort, range) || seen.has(subject.id)) return [];
    seen.add(subject.id);
    return [toMedia(subject, type)];
  });
}

async function requestPage(fetcher: JsonFetcher, offset: number, limit: number, filter: Record<string, unknown>, sort: BookDiscoverySort, signal: AbortSignal, timeoutMs: number) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw cancellationReason(signal);
    try {
      const response = await fetcher(`${ENDPOINT}?limit=${limit}&offset=${offset}`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: "", sort: sort === "score" ? "score" : "heat", filter }), signal, timeoutMs,
      });
      if (response.status !== 200) {
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) { await retryDelay(signal); continue; }
        throw new BookResponseError(`书籍推荐暂时不可用（HTTP ${response.status}）`);
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.limit > limit || parsed.data.offset !== offset || parsed.data.data.length > parsed.data.limit) {
        throw new BookResponseError("书籍推荐响应格式发生变化，请稍后重试");
      }
      return parsed.data;
    } catch (cause) {
      if (signal.aborted) throw cancellationReason(signal);
      if (cause instanceof BookResponseError || attempt > 0) throw cause;
      await retryDelay(signal);
    }
  }
}
class BookResponseError extends Error {}

async function retryDelay(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(cancellationReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 200);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Platform is authoritative; low-vote cross-medium tags cannot override it. */
export function classifyDiscoveryBookSubject(subject: { platform?: unknown; tags?: unknown; meta_tags?: unknown }): BookDiscoveryType | undefined {
  const kind = classifyBangumiBook(subject);
  return kind === "novel" ? isBangumiLightNovel(subject) ? "novel" : undefined : kind;
}
function normalizeTag(value: string): string { return value.trim().toLocaleLowerCase().replace(/\s+/g, " "); }
function bookTags(subject: { tags?: unknown; meta_tags?: unknown }): string[] {
  const tags = Array.isArray(subject.tags) ? subject.tags.flatMap((tag) => {
    if (typeof tag === "string") return [tag];
    if (tag && typeof tag === "object" && typeof tag.name === "string") return [tag.name];
    return [];
  }) : [];
  return [...tags, ...(Array.isArray(subject.meta_tags) ? subject.meta_tags.filter((tag): tag is string => typeof tag === "string") : [])].map(normalizeTag);
}
function coverUrl(subject: BookSubject): string | undefined {
  for (const raw of [subject.images?.large, subject.images?.medium, subject.images?.common, subject.images?.small, subject.image]) {
    if (!raw?.trim()) continue;
    try {
      const url = new URL(normalizeImageUrl(raw.trim()));
      if (url.protocol === "https:" && !/no_?icon|placeholder|default_cover/i.test(url.pathname)) return url.toString();
    } catch { /* Try the next genuine upstream image size. */ }
  }
  return undefined;
}
function usableSubject(subject: BookSubject, type: BookDiscoveryType, sort: BookDiscoverySort, range: { start: string; end: string }): boolean {
  if (subject.type !== 1 || subject.nsfw === true || classifyDiscoveryBookSubject(subject) !== type || !coverUrl(subject)) return false;
  if (bookTags(subject).some((tag) => /^(?:r[ -]?18\+?|18\+|成人向|成人|色情)$/.test(tag))) return false;
  if (sort === "score" && ((subject.rating?.total ?? 0) < 50 || (subject.rating?.score ?? 0) <= 0)) return false;
  return sort !== "recent" || (validDate(subject.date) && subject.date! >= range.start && subject.date! < range.end);
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function recentDateRange(timestamp: number): { start: string; end: string } {
  const today = new Date(timestamp);
  const day = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const start = new Date(day);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const end = new Date(day);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function toMedia(subject: BookSubject, type: BookDiscoveryType): Media {
  const title = subject.name_cn?.trim() || subject.name;
  const rating = (subject.rating?.total ?? 0) > 0 && (subject.rating?.score ?? 0) > 0 ? subject.rating!.score : undefined;
  const collectionCount = subject.collection ? Object.values(subject.collection).reduce((sum, value) => sum + (value ?? 0), 0) : undefined;
  return {
    id: `bangumi:${subject.id}`, type, title,
    ...(title !== subject.name ? { originalTitle: subject.name } : {}),
    aliases: [...new Set([subject.name, subject.name_cn?.trim()].filter((value): value is string => Boolean(value)))],
    ...(subject.summary?.trim() ? { description: subject.summary.trim() } : {}),
    coverUrl: coverUrl(subject),
    ...(validDate(subject.date) ? { releaseYear: Number(subject.date.slice(0, 4)) } : {}),
    externalIds: [{ provider: "bangumi", value: String(subject.id) }],
    metadata: { date: subject.date, platform: subject.platform, rating, voteCount: subject.rating?.total, rank: subject.rating?.rank, watching: subject.collection?.doing, collectionCount, tags: bookTags(subject), raw: subject },
  };
}
function defaultStorage(): BookCacheStorage | null { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } }
function cancellationReason(signal: AbortSignal): unknown { return signal.reason ?? new DOMException("书籍推荐请求已取消", "AbortError"); }
function readCache(storage: BookCacheStorage | null, key: string, type: BookDiscoveryType, sort: BookDiscoverySort, page: number, range: { start: string; end: string }): BookDiscoveryResult | undefined {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(storage?.getItem(key) ?? "null"));
    if (!parsed.success) return undefined;
    const value = parsed.data;
    if (value.type !== type || value.sort !== sort || value.page !== page) return undefined;
    if (!value.items.every((item) => {
      const raw = subjectSchema.safeParse(item.metadata.raw);
      return item.type === type && raw.success && item.id === `bangumi:${raw.data.id}` && usableSubject(raw.data, type, sort, range) && item.coverUrl === coverUrl(raw.data);
    })) return undefined;
    return { type, sort, items: value.items, total: value.total, page, pageSize: BOOK_DISCOVERY_PAGE_SIZE, hasMore: value.hasMore, updatedAt: value.updatedAt, cached: true, stale: false,
      ...(value.partial === undefined ? {} : { partial: value.partial }) };
  } catch { return undefined; }
}
