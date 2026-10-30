import { z } from "zod";
import type { MetadataProvider, MetadataSearchQuery } from "@/application/metadata-ports";
import type { Media, MediaDetails, MediaStaffMember, MediaType } from "@/domain/media";
import { parseJsonResponse, isTimeoutError, isInvalidJsonError } from "./response-errors";
import { MemoryCache } from "./memory-cache";
import { MinIntervalLimiter, type Sleep } from "./rate-limiter";
import { createJsonFetcher, type JsonFetcher } from "./json-transport";
import { classifyBangumiBook } from "./bangumi-book-kind";

const BANGUMI_API = "https://api.bgm.tv/v0";
const BANGUMI_ANIME_TYPE = 2;
const BANGUMI_BOOK_TYPE = 1;

const imageSchema = z
  .object({
    small: z.string().nullable().optional(),
    grid: z.string().nullable().optional(),
    large: z.string().nullable().optional(),
    medium: z.string().nullable().optional(),
    common: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const subjectSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.number().int(),
    name: z.string().min(1),
    name_cn: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    images: imageSchema,
    tags: z.array(z.unknown()).optional(),
    rating: z.unknown().optional(),
    collection: z.unknown().optional(),
  })
  .passthrough();

const pagedSubjectSchema = z.object({
  total: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().nonnegative().optional().default(0),
  offset: z.number().int().nonnegative().optional().default(0),
  data: z.array(subjectSchema).default([]),
});

export type BangumiErrorCode =
  | "bad_request"
  | "rate_limited"
  | "server_error"
  | "not_found"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "network"
  | "invalid_response";

export class BangumiProviderError extends Error {
  constructor(
    readonly code: BangumiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BangumiProviderError";
  }
}

export interface BangumiProviderOptions {
  fetcher?: JsonFetcher;
  cache?: MemoryCache;
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: Sleep;
  userAgent?: string;
}

export class BangumiProvider implements MetadataProvider {
  readonly id = "bangumi";
  readonly supportedTypes = ["anime", "manga", "novel"] as const;
  private readonly fetcher: JsonFetcher;
  private readonly cache: MemoryCache;
  private readonly limiter: MinIntervalLimiter;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly sleep: Sleep;

  constructor(options: BangumiProviderOptions = {}) {
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.cache = options.cache ?? new MemoryCache();
    this.limiter = new MinIntervalLimiter(options.minIntervalMs ?? 350, Date.now, options.sleep);
    this.maxRetries = options.maxRetries ?? 1;
    this.userAgent = options.userAgent ?? "ACGN-Hub/0.3.5 (local desktop app)";
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async search(query: MetadataSearchQuery): Promise<Media[]> {
    const keyword = query.keyword.trim();
    if (!keyword) throw new BangumiProviderError("bad_request", "搜索关键词不能为空");
    if (query.type && !this.supportedTypes.includes(query.type as (typeof this.supportedTypes)[number])) {
      return [];
    }
    const page = Number.isFinite(query.page) ? Math.max(1, Math.floor(query.page!)) : 1;
    const limit = Math.min(50, Math.max(1, (Number.isFinite(query.pageSize) ? Math.floor(query.pageSize!) : 20)));
    const type = query.type ?? "anime";
    const cacheKey = `bangumi:search:${type}:${keyword}:${page}:${limit}`;
    return this.cache.getOrLoad<Media[]>(cacheKey, 5 * 60 * 1000, async () => {

      const offset = (page - 1) * limit;
      const body = {
        keyword,
        sort: "match",
        filter: { type: [type === "anime" ? BANGUMI_ANIME_TYPE : BANGUMI_BOOK_TYPE], nsfw: false },
      };
      const response = await this.request(
        `${BANGUMI_API}/search/subjects?limit=${limit}&offset=${offset}`,
        "POST",
        body,
      );
      const parsed = parsePagedSubjects(response.body);
      const media = parsed.data
        .filter((subject) => classifySubject(subject) === type)
        .map((subject) => toMedia(subject, type));
      return media;
    });
  }

  async getById(externalId: string): Promise<Media> {
    const id = parseBangumiId(externalId);
    const cacheKey = `bangumi:subject:${id}`;
    return this.cache.getOrLoad<Media>(cacheKey, 60 * 60 * 1000, async () => {

      const response = await this.request(`${BANGUMI_API}/subjects/${id}`, "GET");
      const subject = parseSubject(response.body);
      const type = classifySubject(subject);
      if (!type) throw new BangumiProviderError("bad_request", "指定条目类型暂不支持");
      const media = toMedia(subject, type);
      return media;
    });
  }

  /**
   * Rich introduction assembled from the subject detail plus its character
   * and staff lists. Character/person endpoints are best-effort: a failure
   * there degrades to subject-only details instead of failing the call.
   */
  async getDetails(externalId: string): Promise<MediaDetails> {
    const id = parseBangumiId(externalId);
    const cacheKey = `bangumi:subject-details:${id}`;
    return this.cache.getOrLoad<MediaDetails>(cacheKey, 60 * 60 * 1000, async () => {

      const response = await this.request(`${BANGUMI_API}/subjects/${id}`, "GET");
      const subject = parseSubject(response.body);

      let characters: MediaDetails["characters"] = [];
      try {
        const characterResponse = await this.request(`${BANGUMI_API}/subjects/${id}/characters`, "GET");
        characters = parseCharacters(characterResponse.body);
      } catch {
        // Characters are supplementary; keep the rest of the details usable.
      }

      let staff: MediaStaffMember[] = [];
      try {
        const personResponse = await this.request(`${BANGUMI_API}/subjects/${id}/persons`, "GET");
        staff = parsePersons(personResponse.body);
      } catch {
        // Same graceful degradation for staff.
      }

      const infobox = parseInfobox(subject.infobox);
      const ratingScore = readRatingNumber(subject.rating, "score");
      const ratingCount = readRatingNumber(subject.rating, "total");
      const tagNames = (Array.isArray(subject.tags) ? subject.tags : []).flatMap((tag) => {
        if (!tag || typeof tag !== "object") return [];
        const item = tag as { name?: unknown; count?: unknown };
        return typeof item.name === "string" ? [{ name: item.name.trim(), count: typeof item.count === "number" ? item.count : 0 }] : [];
      }).filter((tag) => tag.name).sort((left, right) => right.count - left.count).slice(0, 15).map((tag) => tag.name);

      const details: MediaDetails = {
        providerId: this.id,
        externalId: String(id),
        ...(subject.summary?.trim() ? { summary: subject.summary.trim() } : {}),
        tags: tagNames,
        ...((ratingScore !== undefined || ratingCount !== undefined) ? { rating: { score: ratingScore, count: ratingCount } } : {}),
        episodes: numberFromInfobox(infobox, ["话数"]),
        airDate: textFromInfobox(infobox, ["放送开始", "放送开始日期", "发售日", "发行日期", "出版年"]),
        studios: listFromInfobox(infobox, ["制作公司", "动画制作", "开发商", "出版社", "作者", "开发"]),
        platforms: listFromInfobox(infobox, ["平台"]),
        developers: [],
        staff,
        characters,
      };

      return details;
    });
  }

  private async request(url: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: unknown }> {
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
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status >= 200 && response.status < 300) {
          return { status: response.status, body: await parseJsonResponse(response, BangumiProviderError) };
        }
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
          attempt += 1;
          await this.delay(250 * 2 ** (attempt - 1));
          continue;
        }
        throw errorForStatus(response.status);
      } catch (cause) {
        if (cause instanceof BangumiProviderError) throw cause;
        if (isInvalidJsonError(cause)) throw new BangumiProviderError("invalid_response", "API returned invalid JSON");
        if (attempt < this.maxRetries) {
          attempt += 1;
          await this.delay(250 * 2 ** (attempt - 1));
          continue;
        }
        if (isTimeoutError(cause)) throw new BangumiProviderError("timeout", "Bangumi API request timed out");
        throw new BangumiProviderError("network", "无法连接 Bangumi API");
      }
    }
  }

  private async delay(milliseconds: number): Promise<void> {
    await this.sleep(milliseconds);
  }
}

function errorForStatus(status: number): BangumiProviderError {
  if (status === 401) return new BangumiProviderError("unauthorized", "Bangumi API 需要登录认证", status);
  if (status === 403) return new BangumiProviderError("forbidden", "Bangumi API 拒绝访问", status);
  if (status === 400) return new BangumiProviderError("bad_request", "Bangumi 请求参数无效", status);
  if (status === 404) return new BangumiProviderError("not_found", "Bangumi 条目不存在", status);
  if (status === 429) return new BangumiProviderError("rate_limited", "Bangumi 请求过于频繁", status);
  if (status >= 500) return new BangumiProviderError("server_error", "Bangumi 服务暂时不可用", status);
  return new BangumiProviderError("network", `Bangumi API HTTP ${status}`, status);
}

function parseSubject(body: unknown) {
  const result = subjectSchema.safeParse(body);
  if (!result.success) {
    throw new BangumiProviderError("invalid_response", "Bangumi 条目响应格式不符合预期");
  }
  return result.data;
}

function parsePagedSubjects(body: unknown) {
  const result = pagedSubjectSchema.safeParse(body);
  if (!result.success) {
    throw new BangumiProviderError("invalid_response", "Bangumi 搜索响应格式不符合预期");
  }
  return result.data;
}

function parseBangumiId(externalId: string): number {
  const value = externalId.startsWith("bangumi:") ? externalId.slice("bangumi:".length) : externalId;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BangumiProviderError("bad_request", "Bangumi 条目 ID 无效");
  }
  return id;
}

function toMedia(subject: z.infer<typeof subjectSchema>, type: MediaType): Media {
  const title = subject.name_cn?.trim() || subject.name;
  const aliases = [
    ...new Set([
      subject.name,
      subject.name_cn?.trim(),
      ...extractInfoboxAliases(subject.infobox),
    ].filter((value): value is string => Boolean(value))),
  ];
  const images = subject.images;
  const coverUrl = images?.large || images?.medium || images?.common || images?.grid || images?.small || undefined;
  const releaseYear = subject.date ? Number(subject.date.slice(0, 4)) : undefined;
  return {
    id: `bangumi:${subject.id}`,
    type,
    title,
    ...(subject.name !== title ? { originalTitle: subject.name } : {}),
    aliases,
    ...(subject.summary ? { description: subject.summary } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    ...(releaseYear !== undefined && Number.isInteger(releaseYear) && releaseYear > 0 ? { releaseYear } : {}),
    externalIds: [{ provider: "bangumi", value: String(subject.id) }],
    metadata: {
      bangumiType: subject.type,
      ...(readRatingNumber(subject.rating, "score") !== undefined ? { rating: readRatingNumber(subject.rating, "score") } : {}),
      ...(readRatingNumber(subject.rating, "total") !== undefined ? { ratingCount: readRatingNumber(subject.rating, "total") } : {}),
      date: subject.date ?? null,
      platform: subject.platform ?? null,
      raw: subject,
    },
  };
}

function extractInfoboxAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const aliases: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { key?: unknown; value?: unknown };
    if (item.key !== "别名") continue;
    const values = Array.isArray(item.value) ? item.value : [item.value];
    for (const candidate of values) {
      if (typeof candidate === "string") {
        const alias = candidate.trim();
        if (alias) aliases.push(alias);
        continue;
      }
      if (candidate && typeof candidate === "object") {
        const text = (candidate as { v?: unknown }).v;
        if (typeof text === "string" && text.trim()) aliases.push(text.trim());
      }
    }
  }
  return aliases;
}

function classifySubject(subject: z.infer<typeof subjectSchema>): MediaType | undefined {
  if (subject.type === BANGUMI_ANIME_TYPE) return "anime";
  if (subject.type !== BANGUMI_BOOK_TYPE) return undefined;
  return classifyBangumiBook(subject);
}

interface InfoboxEntry {
  key: string;
  text: string[];
}

function parseInfobox(value: unknown): InfoboxEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: InfoboxEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { key?: unknown; value?: unknown };
    if (typeof item.key !== "string") continue;
    const values = Array.isArray(item.value) ? item.value : [item.value];
    const texts = values.flatMap((candidate) => {
      if (typeof candidate === "string") return [candidate.trim()];
      if (candidate && typeof candidate === "object") {
        const nested = candidate as { v?: unknown };
        if (typeof nested.v === "string") return [nested.v.trim()];
      }
      return [];
    }).filter(Boolean);
    if (texts.length) entries.push({ key: item.key.trim(), text: texts });
  }
  return entries;
}

function findInfobox(entries: InfoboxEntry[], keys: string[]): InfoboxEntry | undefined {
  return entries.find((entry) => keys.some((key) => entry.key === key));
}

function textFromInfobox(entries: InfoboxEntry[], keys: string[]): string | undefined {
  const entry = findInfobox(entries, keys);
  return entry?.text[0];
}

function numberFromInfobox(entries: InfoboxEntry[], keys: string[]): number | undefined {
  const text = textFromInfobox(entries, keys);
  if (!text) return undefined;
  const parsed = Number(text.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function listFromInfobox(entries: InfoboxEntry[], keys: string[]): string[] {
  return [...new Set(findInfobox(entries, keys)?.text ?? [])];
}

function readRatingNumber(value: unknown, field: "score" | "total"): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rating = value as Record<string, unknown>;
  const parsed = Number(rating[field]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const characterSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  role: z.string().nullable().optional(),
  actors: z
    .array(
      z
        .object({ id: z.number().int().positive(), name: z.string().min(1).optional() })
        .passthrough(),
    )
    .nullable()
    .optional(),
}).passthrough();

const personSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
}).passthrough();

function parseCharacters(body: unknown): MediaDetails["characters"] {
  if (!Array.isArray(body)) return [];
  const characters: MediaDetails["characters"] = [];
  for (const raw of body.slice(0, 40)) {
    const result = characterSchema.safeParse(raw);
    if (!result.success) continue;
    const character = result.data;
    characters.push({
      name: character.name,
      ...(character.role ? { role: translateCharacterRole(character.role) } : {}),
      actors: (character.actors ?? [])
        .filter((actor) => typeof actor.name === "string" && actor.name)
        .map((actor) => ({ name: actor.name as string })),
    });
  }
  return characters;
}

function translateCharacterRole(role: string): string | undefined {
  if (/^main$/i.test(role)) return "主角";
  if (/^support$/i.test(role)) return "配角";
  return role;
}

function parsePersons(body: unknown): MediaStaffMember[] {
  if (!Array.isArray(body)) return [];
  const staff: MediaStaffMember[] = [];
  for (const raw of body.slice(0, 60)) {
    const result = personSchema.safeParse(raw);
    if (!result.success) continue;
    const person = result.data;
    const relation = readPersonRelation(person);
    const originalName = readPersonText(person, "originalName") ?? readPersonText(person, "name_original");
    staff.push({
      name: person.name,
      ...(originalName ? { originalName } : {}),
      ...(relation ? { role: relation } : {}),
    });
  }
  return staff;
}

function readPersonRelation(person: unknown): string | undefined {
  return readPersonText(person, "relation") ?? readPersonText(person, "relation_name");
}

function readPersonText(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}
