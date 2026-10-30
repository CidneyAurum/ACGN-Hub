import { z } from "zod";
import type { Media } from "@/domain/media";
import { getAnimeSeasonRange, isDateInAnimeSeason, validateAnimeSeason, type AnimeSeason } from "@/domain/anime-season";
import { normalizeImageUrl } from "@/infrastructure/media/image-loader";
import { abortableRequest } from "./abortable-request";
import { createJsonFetcher, type JsonFetcher } from "./json-transport";

export const SEASON_DISCOVERY_PAGE_SIZE = 24;
// The live public API caps a response at 20 even when limit=24 is requested.
// Aggregate smaller requests so display pages remain complete and never skip 4 hits.
const API_PAGE_SIZE = 20;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_PREFIX = "acgn-hub.discovery-season.v1";
const ENDPOINT = "https://api.bgm.tv/v0/search/subjects";

export interface SeasonDiscoveryResult {
  season: AnimeSeason;
  items: Media[];
  /** Bangumi's total matching hits, before defensive date/type validation. */
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  updatedAt: string;
  cached: boolean;
  stale: boolean;
  warning?: string;
}

type SeasonCacheStorage = Pick<Storage, "getItem" | "setItem">;
export interface SeasonDiscoveryOptions {
  page?: number;
  refresh?: boolean;
  fetcher?: JsonFetcher;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** null disables persistent caching; the default is localStorage when available. */
  storage?: SeasonCacheStorage | null;
}

const subjectSchema = z.object({
  id: z.number().int().positive(),
  type: z.number().int(),
  name: z.string().min(1),
  name_cn: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  platform: z.string().nullable().optional(),
  images: z.object({
    large: z.string().nullable().optional(),
    common: z.string().nullable().optional(),
    medium: z.string().nullable().optional(),
    small: z.string().nullable().optional(),
  }).nullable().optional(),
  image: z.string().nullable().optional(),
  rating: z.object({ score: z.number().optional(), total: z.number().int().nonnegative().optional(), rank: z.number().int().nonnegative().optional() }).nullable().optional(),
  collection: z.object({
    wish: z.number().int().nonnegative().optional(),
    collect: z.number().int().nonnegative().optional(),
    doing: z.number().int().nonnegative().optional(),
    on_hold: z.number().int().nonnegative().optional(),
    dropped: z.number().int().nonnegative().optional(),
  }).nullable().optional(),
}).passthrough();
const responseSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  data: z.array(subjectSchema).max(API_PAGE_SIZE),
});
const cachedMediaSchema = z.object({
  id: z.string().regex(/^bangumi:\d+$/),
  type: z.literal("anime"),
  title: z.string().min(1),
  originalTitle: z.string().optional(),
  aliases: z.array(z.string()),
  description: z.string().optional(),
  coverUrl: z.string().optional(),
  releaseYear: z.number().int().optional(),
  externalIds: z.array(z.object({ provider: z.string(), value: z.string() })),
  metadata: z.record(z.string(), z.unknown()),
});
const cacheSchema = z.object({
  version: z.literal(1),
  season: z.object({ year: z.number().int(), quarter: z.number().int().min(1).max(4) }),
  page: z.number().int().positive(),
  pageSize: z.literal(SEASON_DISCOVERY_PAGE_SIZE),
  items: z.array(cachedMediaSchema).max(SEASON_DISCOVERY_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  updatedAt: z.string().datetime(),
});

/**
 * Official search contract: https://github.com/bangumi/api/blob/master/open-api/v0.yaml
 * air_date conditions are ANDed; heat sorts by collection count. Empty keyword is
 * accepted by the public API, allowing genuine season discovery without login.
 */
export async function getSeasonDiscovery(season: AnimeSeason, options: SeasonDiscoveryOptions = {}): Promise<SeasonDiscoveryResult> {
  validateAnimeSeason(season);
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(page * SEASON_DISCOVERY_PAGE_SIZE)) throw new RangeError("番剧页码无效");
  const now = options.now ?? Date.now;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const key = `${CACHE_PREFIX}:${season.year}:q${season.quarter}:page${page}`;
  const cached = readCache(storage, key, season, page);
  const age = cached ? now() - Date.parse(cached.updatedAt) : Infinity;
  if (options.signal?.aborted) throw cancellationReason(options.signal);
  if (!options.refresh && cached && age >= 0 && age < CACHE_TTL_MS) return { ...cached, cached: true, stale: false };

  const timeoutMs = Math.max(1, Math.min(35_000, options.timeoutMs ?? 12_000));
  if (!Number.isFinite(timeoutMs)) throw new RangeError("番剧请求超时设置无效");
  const controller = new AbortController();
  const cancel = () => controller.abort(cancellationReason(options.signal!));
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("季度番剧请求超时", "TimeoutError")), timeoutMs);
  const offset = (page - 1) * SEASON_DISCOVERY_PAGE_SIZE;
  const { startDate, endDateExclusive } = getAnimeSeasonRange(season);
  try {
    const parsed = await abortableRequest(async () => {
      const fetcher = options.fetcher ?? createJsonFetcher();
      const subjects: z.infer<typeof subjectSchema>[] = [];
      let total = 0;
      while (subjects.length < SEASON_DISCOVERY_PAGE_SIZE) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const requestOffset = offset + subjects.length;
        const requestLimit = Math.min(API_PAGE_SIZE, SEASON_DISCOVERY_PAGE_SIZE - subjects.length);
        const response = await fetcher(`${ENDPOINT}?limit=${requestLimit}&offset=${requestOffset}`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ keyword: "", sort: "heat", filter: { type: [2], air_date: [`>=${startDate}`, `<${endDateExclusive}`], nsfw: false } }),
          signal: controller.signal,
          timeoutMs,
        });
        if (response.status !== 200) throw new Error(`季度番剧暂时不可用（HTTP ${response.status}）`);
        const result = responseSchema.safeParse(await response.json());
        if (!result.success || result.data.limit > requestLimit || result.data.offset !== requestOffset || result.data.data.length > result.data.limit) {
          throw new Error("季度番剧响应格式发生变化，请稍后重试");
        }
        if (!subjects.length) total = result.data.total;
        subjects.push(...result.data.data);
        if (!result.data.data.length || result.data.data.length < result.data.limit || offset + subjects.length >= total) break;
      }
      return { total, data: subjects };
    }, controller.signal);
    const seen = new Set<number>();
    const items = parsed.data.filter((subject) => {
      if (subject.type !== 2 || !isDateInAnimeSeason(subject.date, season) || seen.has(subject.id)) return false;
      seen.add(subject.id);
      return true;
    }).map(toMedia);
    const result: SeasonDiscoveryResult = {
      season: { ...season }, items, total: parsed.total, page, pageSize: SEASON_DISCOVERY_PAGE_SIZE,
      hasMore: parsed.data.length > 0 && offset + SEASON_DISCOVERY_PAGE_SIZE < parsed.total,
      updatedAt: new Date(now()).toISOString(), cached: false, stale: false,
    };
    try { storage?.setItem(key, JSON.stringify({ version: 1, ...result })); } catch { /* Quota/private mode must not block discovery. */ }
    return result;
  } catch (cause) {
    // A switched season/page must not be resurrected by its cancelled request.
    if (options.signal?.aborted) throw cancellationReason(options.signal);
    if (cached) return { ...cached, cached: true, stale: true, warning: "季度番剧暂时无法更新，正在显示该季度的缓存" };
    if (controller.signal.aborted) throw controller.signal.reason;
    throw cause;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function defaultStorage(): SeasonCacheStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function readCache(storage: SeasonCacheStorage | null, key: string, season: AnimeSeason, page: number): SeasonDiscoveryResult | undefined {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(storage?.getItem(key) ?? "null"));
    if (!parsed.success) return undefined;
    const value = parsed.data;
    if (value.season.year !== season.year || value.season.quarter !== season.quarter || value.page !== page ||
      !value.items.every((item) => isDateInAnimeSeason(item.metadata.date, season))) return undefined;
    return { season: { ...season }, items: value.items, total: value.total, page, pageSize: SEASON_DISCOVERY_PAGE_SIZE, hasMore: value.hasMore, updatedAt: value.updatedAt, cached: true, stale: false };
  } catch { return undefined; }
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("季度番剧请求已取消", "AbortError");
}

function toMedia(subject: z.infer<typeof subjectSchema>): Media {
  const title = subject.name_cn?.trim() || subject.name;
  const cover = subject.images?.large || subject.images?.medium || subject.images?.common || subject.images?.small || subject.image;
  const collectionCount = subject.collection ? Object.values(subject.collection).reduce((sum, value) => sum + (value ?? 0), 0) : undefined;
  return {
    id: `bangumi:${subject.id}`, type: "anime", title,
    ...(title !== subject.name ? { originalTitle: subject.name } : {}),
    aliases: [...new Set([subject.name, subject.name_cn].filter((value): value is string => Boolean(value?.trim())))],
    ...(subject.summary?.trim() ? { description: subject.summary } : {}),
    ...(cover ? { coverUrl: normalizeImageUrl(cover) } : {}),
    releaseYear: Number(subject.date!.slice(0, 4)),
    externalIds: [{ provider: "bangumi", value: String(subject.id) }],
    metadata: { date: subject.date, platform: subject.platform, rating: subject.rating?.score, voteCount: subject.rating?.total, rank: subject.rating?.rank, watching: subject.collection?.doing, collectionCount, raw: subject },
  };
}
