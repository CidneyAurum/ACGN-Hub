import { timeoutSignal } from "@/shared/abort-signals";
import { z } from "zod";
import type { MetadataProvider, MetadataSearchQuery } from "@/application/metadata-ports";
import type { Media, MediaDetails } from "@/domain/media";
import { parseJsonResponse, isTimeoutError, isInvalidJsonError } from "./response-errors";
import { MemoryCache } from "./memory-cache";
import { MinIntervalLimiter, type Sleep } from "./rate-limiter";
import { createJsonFetcher, type JsonFetcher } from "./json-transport";

const VNDB_API = "https://api.vndb.org/kana";
const VNDB_FIELDS =
  "title,alttitle,titles{title,latin,lang,official,main},aliases,olang,released,languages,platforms,image{url,thumbnail,sexual,violence},description,rating,votecount";
// Extended field set used only by getDetails(); kept separate so a schema
// change on VNDB's side can never break plain search/getById.
const VNDB_DETAIL_FIELDS =
  `${VNDB_FIELDS},length_minutes,tags{name,rating,spoiler,lie},developers{name,original},staff{name,original,role}`;
const VNDB_CHARACTER_FIELDS = "name,original,vns{role}";
const CHARACTER_ROLE_LABELS: Record<string, string> = {
  main: "主角",
  primary: "主角",
  secondary: "配角",
  appears: "客串",
};

const imageSchema = z
  .object({
    url: z.string().url(),
    thumbnail: z.string().url().nullable().optional(),
    sexual: z.number().min(0).max(2).nullable().optional(),
    violence: z.number().min(0).max(2).nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const titleSchema = z
  .object({
    title: z.string().min(1),
    latin: z.string().nullable().optional(),
    lang: z.string().min(1).optional(),
    official: z.boolean().optional(),
    main: z.boolean().optional(),
  })
  .passthrough();

const visualNovelSchema = z
  .object({
    id: z.string().regex(/^v\d+$/),
    title: z.string().min(1),
    alttitle: z.string().nullable().optional(),
    titles: z.array(titleSchema).optional().default([]),
    aliases: z.array(z.string()).optional().default([]),
    olang: z.string().nullable().optional(),
    released: z.string().nullable().optional(),
    languages: z.array(z.string()).optional().default([]),
    platforms: z.array(z.string()).optional().default([]),
    image: imageSchema,
    description: z.string().nullable().optional(),
    rating: z.number().nullable().optional(),
    votecount: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const responseSchema = z.object({
  results: z.array(visualNovelSchema),
  more: z.boolean().optional().default(false),
  count: z.number().int().nonnegative().optional(),
});

export type VndbErrorCode =
  | "bad_request"
  | "rate_limited"
  | "server_error"
  | "not_found"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "network"
  | "invalid_response";

export class VndbProviderError extends Error {
  constructor(
    readonly code: VndbErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VndbProviderError";
  }
}

export interface VndbProviderOptions {
  fetcher?: JsonFetcher;
  cache?: MemoryCache;
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: Sleep;
  userAgent?: string;
}

export type VndbDiscoverySort = "rating" | "recent";
export interface VndbDiscoveryOptions {
  sort?: VndbDiscoverySort;
  page?: number;
  refresh?: boolean;
  now?: Date;
}
export interface VndbDiscoveryResult {
  items: Media[];
  sort: VndbDiscoverySort;
  page: number;
  hasMore: boolean;
  updatedAt: string;
  cached: boolean;
}

export class VndbProvider implements MetadataProvider {
  readonly id = "vndb";
  readonly supportedTypes = ["visual_novel"] as const;
  private readonly fetcher: JsonFetcher;
  private readonly cache: MemoryCache;
  private readonly limiter: MinIntervalLimiter;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly sleep: Sleep;
  private discoveryGeneration = 0;

  constructor(options: VndbProviderOptions = {}) {
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.cache = options.cache ?? new MemoryCache();
    this.limiter = new MinIntervalLimiter(options.minIntervalMs ?? 350, Date.now, options.sleep);
    this.maxRetries = options.maxRetries ?? 1;
    this.userAgent = options.userAgent ?? "ACGN-Hub/0.1 (local desktop app)";
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** Anonymous official catalog; language availability includes fan translations. */
  async discover(options: VndbDiscoveryOptions = {}): Promise<VndbDiscoveryResult> {
    const sort = options.sort ?? "rating";
    const page = options.page ?? 1;
    const now = options.now ?? new Date();
    if (!["rating", "recent"].includes(sort) || !Number.isInteger(page) || page < 1 || page > 100 || !Number.isFinite(now.getTime())) {
      throw new VndbProviderError("bad_request", "Galgame 推荐排序、页码或日期无效");
    }
    const today = localDate(now);
    if (options.refresh) this.discoveryGeneration++;
    const cacheKey = `vndb:discovery:${this.discoveryGeneration}:${sort}:${today}:${page}`;
    if (!options.refresh) {
      const cached = this.cache.get<VndbDiscoveryResult>(cacheKey);
      if (cached) return { ...cached, cached: true };
    }
    return this.cache.getOrLoad<VndbDiscoveryResult>(cacheKey, 30 * 60_000, async () => {
      const filters: unknown[] = ["and", ["or", ["lang", "=", "zh-Hans"], ["lang", "=", "zh-Hant"]],
        ["votecount", ">=", sort === "rating" ? 50 : 5], ["released", "<=", today]];
      if (sort === "recent") {
        const start = new Date(now);
        const year = now.getFullYear() - 2;
        start.setFullYear(year, now.getMonth(), Math.min(now.getDate(), new Date(year, now.getMonth() + 1, 0).getDate()));
        filters.push(["released", ">=", localDate(start)]);
      }
      const response = await this.request(`${VNDB_API}/vn`, "POST", {
        filters, fields: VNDB_FIELDS, sort: sort === "recent" ? "released" : "rating", reverse: true, results: 24, page,
      });
      const parsed = parseResponse(response.body);
      return { items: parsed.results.map(toMedia), sort, page, hasMore: parsed.more, updatedAt: now.toISOString(), cached: false };
    });
  }

  async search(query: MetadataSearchQuery): Promise<Media[]> {
    const keyword = query.keyword.trim();
    if (!keyword) throw new VndbProviderError("bad_request", "搜索关键词不能为空");
    if (query.type && query.type !== "visual_novel") return [];

    const page = Number.isFinite(query.page) ? Math.max(1, Math.floor(query.page!)) : 1;
    const results = Math.min(100, Math.max(1, (Number.isFinite(query.pageSize) ? Math.floor(query.pageSize!) : 20)));
    const cacheKey = `vndb:search:${keyword}:${page}:${results}`;
    return this.cache.getOrLoad<Media[]>(cacheKey, 5 * 60 * 1000, async () => {

      const response = await this.request(`${VNDB_API}/vn`, "POST", {
        filters: ["search", "=", keyword],
        fields: VNDB_FIELDS,
        sort: "searchrank",
        results,
        page,
    });
    const parsed = parseResponse(response.body);
    const media = parsed.results.map(toMedia);
    return media;
    });
  }

  async getById(externalId: string): Promise<Media> {
    const id = parseVndbId(externalId);
    const cacheKey = `vndb:vn:${id}`;
    return this.cache.getOrLoad<Media>(cacheKey, 60 * 60 * 1000, async () => {

      const response = await this.request(`${VNDB_API}/vn`, "POST", {
        filters: ["id", "=", id],
        fields: VNDB_FIELDS,
        results: 1,
    });
    const parsed = parseResponse(response.body);
    const subject = parsed.results[0];
    if (!subject) throw new VndbProviderError("not_found", "VNDB 条目不存在", 404);
    const media = toMedia(subject);
    return media;
    });
  }

  /** Rich introduction: description, spoiler-free tags, staff, cast… */
  async getDetails(externalId: string): Promise<MediaDetails> {
    const id = parseVndbId(externalId);
    const cacheKey = `vndb:vn-details:${id}`;
    return this.cache.getOrLoad<MediaDetails>(cacheKey, 60 * 60 * 1000, async () => {

      const response = await this.request(`${VNDB_API}/vn`, "POST", {
        filters: ["id", "=", id],
        fields: VNDB_DETAIL_FIELDS,
        results: 1,
    });
    const parsed = parseResponse(response.body);
    const subject = parsed.results[0];
    if (!subject) throw new VndbProviderError("not_found", "VNDB 条目不存在", 404);

    // Cast comes from the documented /character endpoint (stable fields);
    // a failure there degrades to details without a cast list.
    let characters: MediaDetails["characters"] = [];
    try {
      const characterResponse = await this.request(`${VNDB_API}/character`, "POST", {
        filters: ["vn", "=", ["id", "=", id]],
        fields: VNDB_CHARACTER_FIELDS,
        results: 40,
        sort: "searchrank",
      });
      characters = parseVndbCharacters(characterResponse.body);
    } catch {
      // Keep the rest of the details usable.
    }

    const details = { ...toDetails(subject), characters };
    return details;
    });
  }

  private async request(url: string, method: "POST", body: unknown): Promise<{ status: number; body: unknown }> {
    let attempt = 0;
    while (true) {
      await this.limiter.wait();
      try {
        const response = await this.fetcher(url, {
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-ACGN-Hub-Client": this.userAgent,
          },
          body: JSON.stringify(body),
          signal: timeoutSignal(10_000),
        });
        if (response.status >= 200 && response.status < 300) {
          return { status: response.status, body: await parseJsonResponse(response, VndbProviderError) };
        }
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
          attempt += 1;
          await this.delay(250 * 2 ** (attempt - 1));
          continue;
        }
        throw errorForStatus(response.status);
      } catch (cause) {
        if (cause instanceof VndbProviderError) throw cause;
        if (isInvalidJsonError(cause)) throw new VndbProviderError("invalid_response", "API returned invalid JSON");
        if (attempt < this.maxRetries) {
          attempt += 1;
          await this.delay(250 * 2 ** (attempt - 1));
          continue;
        }
        if (isTimeoutError(cause)) throw new VndbProviderError("timeout", "Vndb API request timed out");
        throw new VndbProviderError("network", "无法连接 VNDB API");
      }
    }
  }

  private async delay(milliseconds: number): Promise<void> {
    await this.sleep(milliseconds);
  }
}

function errorForStatus(status: number): VndbProviderError {
  if (status === 401) return new VndbProviderError("unauthorized", "VNDB API 需要登录认证", status);
  if (status === 403) return new VndbProviderError("forbidden", "VNDB API 拒绝访问", status);
  if (status === 400) return new VndbProviderError("bad_request", "VNDB 请求参数无效", status);
  if (status === 404) return new VndbProviderError("not_found", "VNDB 条目不存在", status);
  if (status === 429) return new VndbProviderError("rate_limited", "VNDB 请求过于频繁", status);
  if (status >= 500) return new VndbProviderError("server_error", "VNDB 服务暂时不可用", status);
  return new VndbProviderError("network", `VNDB API HTTP ${status}`, status);
}

function parseResponse(body: unknown) {
  const result = responseSchema.safeParse(body);
  if (!result.success) {
    throw new VndbProviderError("invalid_response", "VNDB 响应格式不符合预期");
  }
  return result.data;
}

function parseVndbId(externalId: string): string {
  const value = externalId.startsWith("vndb:") ? externalId.slice("vndb:".length) : externalId;
  if (!/^v\d+$/.test(value)) throw new VndbProviderError("bad_request", "VNDB 条目 ID 无效");
  return value;
}

function toMedia(subject: z.infer<typeof visualNovelSchema>): Media {
  const titleCandidates = subject.titles
    .flatMap((item) => [item.title, item.latin ?? undefined])
    .filter((value): value is string => Boolean(value));
  const chineseTitle = subject.titles.find((item) =>
    item.lang?.toLocaleLowerCase().startsWith("zh") && /[\u3400-\u9fff]/u.test(item.title),
  )?.title.trim();
  const title = chineseTitle || subject.title;
  const originalTitle = subject.alttitle?.trim() || titleCandidates.find((value) => value !== title);
  const aliases = [...new Set([subject.title, subject.alttitle ?? undefined, ...subject.aliases, ...titleCandidates].filter(Boolean))] as string[];
  // VNDB's image flag is an average: 0 safe, 1 nudity, 2 sexual content.
  // Keep neutral placeholders for flagged images, including on search/details.
  const safeImage = subject.image && (subject.image.sexual ?? 0) < 1 && (subject.image.violence ?? 0) < 2 ? subject.image : undefined;
  const coverUrl = safeImage?.url || safeImage?.thumbnail || undefined;
  const releaseYear = subject.released ? Number(subject.released.slice(0, 4)) : undefined;

  return {
    id: `vndb:${subject.id}`,
    type: "visual_novel",
    title,
    ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
    aliases,
    ...(subject.description ? { description: cleanVndbDescription(subject.description) } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    ...(releaseYear !== undefined && Number.isInteger(releaseYear) && releaseYear > 0 ? { releaseYear } : {}),
    externalIds: [{ provider: "vndb", value: subject.id }],
    metadata: {
      vndbId: subject.id,
      originalLanguage: subject.olang ?? null,
      released: subject.released ?? null,
      languages: subject.languages,
      platforms: subject.platforms,
      rating: normalizeVndbRating(subject.rating) ?? null,
      vndbRating: subject.rating ?? null,
      voteCount: subject.votecount ?? null,
    },
  };
}

const STAFF_ROLE_LABELS: Record<string, string> = {
  director: "导演",
  scenario: "剧本",
  art: "原画",
  chardesign: "人设",
  music: "音乐",
  original: "原作",
  technical: "技术",
  staff: "制作协助",
};

interface VndbDetailSubject {
  id: string;
  description?: string | null;
  rating?: number | null;
  votecount?: number | null;
  length_minutes?: number | null;
  released?: string | null;
  platforms: string[];
  tags: Array<{ name?: unknown; rating?: unknown; spoiler?: unknown }>;
  developers: Array<{ name?: unknown; original?: unknown }>;
  staff: Array<{ name?: unknown; original?: unknown; role?: unknown }>;
}

function toDetails(subject: z.infer<typeof visualNovelSchema>): MediaDetails {
  // The extended fields ride the same passthrough schema; read them leniently.
  const detail = subject as z.infer<typeof visualNovelSchema> & Partial<VndbDetailSubject>;

  const tags = (detail.tags ?? [])
    .filter((tag): tag is { name: string; rating: number | null; spoiler: number | null } =>
      typeof tag?.name === "string" && Boolean(tag.name))
    .filter((tag) => tag.spoiler === null || tag.spoiler === undefined || tag.spoiler <= 0)
    .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0))
    .slice(0, 15)
    .map((tag) => tag.name);

  const developers = (detail.developers ?? [])
    .map((developer) => typeof developer?.name === "string" ? developer.name : undefined)
    .filter((value): value is string => Boolean(value));

  const staff = (detail.staff ?? [])
    .filter((member): member is { name: string; original?: unknown; role?: unknown } => typeof member?.name === "string" && Boolean(member.name))
    .map((member) => ({
      name: member.name,
      ...(typeof member.original === "string" && member.original ? { originalName: member.original } : {}),
      ...(typeof member.role === "string" && member.role ? { role: STAFF_ROLE_LABELS[member.role] ?? member.role } : {}),
    }));

  return {
    providerId: "vndb",
    externalId: subject.id,
    ...(detail.description ? { summary: cleanVndbDescription(detail.description) } : {}),
    tags,
    ...(normalizeVndbRating(detail.rating) !== undefined ? { rating: { score: normalizeVndbRating(detail.rating)!, count: detail.votecount ?? undefined } } : {}),
    ...(typeof detail.length_minutes === "number" && detail.length_minutes > 0 ? { durationMinutes: Math.round(detail.length_minutes) } : {}),
    airDate: detail.released ?? undefined,
    studios: developers,
    platforms: detail.platforms ?? [],
    developers,
    staff,
    characters: [],
  };
}

const characterEntrySchema = z.object({
  name: z.string().min(1),
}).passthrough();

function parseVndbCharacters(body: unknown): MediaDetails["characters"] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const characters: MediaDetails["characters"] = [];
  for (const raw of results.slice(0, 40)) {
    const result = characterEntrySchema.safeParse(raw);
    if (!result.success) continue;
    const entry = result.data as z.infer<typeof characterEntrySchema> & {
      original?: unknown;
      vns?: Array<{ role?: unknown }>;
    };
    const role = CHARACTER_ROLE_LABELS[String(entry.vns?.[0]?.role ?? "")];
    characters.push({
      name: entry.name,
      ...(role ? { role } : {}),
      actors: [],
    });
  }
  return characters;
}

/** Strip VNDB BBCode ([url=…]/[spoiler]…) down to plain readable text. */
function cleanVndbDescription(description: string): string {
  return description
    .replace(/\[url=(https?:\/\/[^\]]+)\]([\s\S]*?)\[\/url\]/gi, "$2 ($1)")
    .replace(/\[url=(\/[^\]]+)\]([\s\S]*?)\[\/url\]/gi, "$2")
    .replace(/\[(?:spoiler|b|i|u|s)\]([\s\S]*?)\[\/(?:spoiler|b|i|u|s)\]/gi, "$1")
    .replace(/\[[^\]]*\]/g, "")
    .trim();
}

function normalizeVndbRating(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value / 10 : undefined;
}
function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
