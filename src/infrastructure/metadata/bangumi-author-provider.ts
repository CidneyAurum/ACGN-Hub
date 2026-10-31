import { z } from "zod";
import type { Author } from "@/domain/author";
import type { Media, MediaType } from "@/domain/media";
import { BangumiProviderError } from "./bangumi-provider";
import { classifyBangumiBook } from "./bangumi-book-kind";
import { abortableRequest } from "./abortable-request";
import { createJsonFetcher, type JsonFetcher } from "./json-transport";
import { MemoryCache } from "./memory-cache";
import { MinIntervalLimiter, type Sleep } from "./rate-limiter";
import { parseJsonResponse, isTimeoutError } from "./response-errors";

const API = "https://api.bgm.tv/v0";
const PAGE_SIZE = 20;
const CACHE_TTL = 5 * 60_000;
const imagesSchema = z.object({
  small: z.string().nullable().optional(), grid: z.string().nullable().optional(),
  large: z.string().nullable().optional(), medium: z.string().nullable().optional(),
  common: z.string().nullable().optional(),
}).passthrough().nullable().optional();
const personSchema = z.object({
  id: z.number().int().positive().safe(), name: z.string().trim().min(1),
  images: imagesSchema, img: z.string().nullable().optional(),
  // The experimental search currently returns PersonDetail, whereas its
  // published schema describes Person.short_summary. Accept both explicitly.
  summary: z.string().nullable().optional(), short_summary: z.string().nullable().optional(),
  infobox: z.array(z.unknown()).nullable().optional(),
}).passthrough();
const peopleSchema = z.object({
  total: z.number().int().nonnegative(), limit: z.number().int().positive().max(PAGE_SIZE),
  offset: z.number().int().nonnegative(), data: z.array(personSchema).max(PAGE_SIZE),
});
const relatedSubjectSchema = z.object({
  id: z.number().int().positive().safe(), type: z.number().int(),
  name: z.string().trim().min(1), name_cn: z.string().nullable().optional(),
  staff: z.string(), image: z.string().nullable().optional(),
}).passthrough();
const relatedSubjectsSchema = z.array(relatedSubjectSchema);
const subjectSchema = z.object({
  id: z.number().int().positive().safe(), type: z.number().int(), name: z.string().trim().min(1),
  name_cn: z.string().nullable().optional(), summary: z.string().nullable().optional(),
  platform: z.string().nullable().optional(), date: z.string().nullable().optional(),
  images: imagesSchema, tags: z.array(z.unknown()).optional(), meta_tags: z.array(z.string()).optional(),
  nsfw: z.boolean().optional(), rating: z.unknown().optional(),
}).passthrough();
type RelatedSubject = z.infer<typeof relatedSubjectSchema>;
type Subject = z.infer<typeof subjectSchema>;

export interface AuthorRequestOptions { signal?: AbortSignal }
export interface AuthorWorksOptions extends AuthorRequestOptions { page?: number; pageSize?: number }
export interface AuthorWorksResult {
  items: Media[];
  hasMore: boolean;
  /** Exact for animation; omitted for books until their shared category is classified. */
  total?: number;
  page: number;
  pageSize: number;
  warning?: string;
}
export interface BangumiAuthorProviderOptions {
  fetcher?: JsonFetcher;
  cache?: MemoryCache;
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: Sleep;
  timeoutMs?: number;
}

/**
 * Official contract: https://github.com/bangumi/api/blob/master/open-api/v0.yaml
 * POST /search/persons is experimental. GET /persons/{id}/subjects returns an
 * unpaged, flat array with `staff` and `image`, including duplicate subject IDs
 * for different jobs. It has no book platform, so classify only the current
 * candidate page with at most three concurrent subject requests.
 */
export class BangumiAuthorProvider {
  private readonly fetcher: JsonFetcher;
  private readonly cache: MemoryCache;
  private readonly limiter: MinIntervalLimiter;
  private readonly sleep: Sleep;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(options: BangumiAuthorProviderOptions = {}) {
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.cache = options.cache ?? new MemoryCache();
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.limiter = new MinIntervalLimiter(options.minIntervalMs ?? 350, Date.now, this.sleep);
    this.maxRetries = Math.min(2, Math.max(0, Math.floor(options.maxRetries ?? 1)));
    this.timeoutMs = Math.min(35_000, Math.max(500, options.timeoutMs ?? 10_000));
  }

  async searchPeople(keyword: string, options: AuthorRequestOptions = {}): Promise<Author[]> {
    const value = keyword.trim();
    if (!value) throw new BangumiProviderError("bad_request", "请输入作者或制作人员姓名");
    const key = `bangumi:people:${value}`;
    checkCancelled(options.signal);
    const cached = this.cache.get<Author[]>(key);
    if (cached) return cached;
    const body = await this.request(`${API}/search/persons?limit=${PAGE_SIZE}&offset=0`, "POST", { keyword: value }, options.signal);
    const parsed = peopleSchema.safeParse(body);
    if (!parsed.success || parsed.data.offset !== 0 || parsed.data.data.length > parsed.data.limit) {
      throw invalidResponse("作者搜索响应格式发生变化，请稍后重试");
    }
    const seen = new Set<string>();
    const authors = parsed.data.data.map(toAuthor).filter((author) => !seen.has(author.id) && !!seen.add(author.id));
    checkCancelled(options.signal);
    for (const author of authors) this.cache.set(`bangumi:person:${author.id}`, author, CACHE_TTL);
    this.cache.set(key, authors, CACHE_TTL);
    return structuredClone(authors);
  }

  async listWorks(personId: string, type: MediaType, options: AuthorWorksOptions = {}): Promise<AuthorWorksResult> {
    const id = parsePersonId(personId);
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? PAGE_SIZE;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(page * pageSize)
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) {
      throw new BangumiProviderError("bad_request", "作者作品页码无效");
    }
    checkCancelled(options.signal);
    if (type === "visual_novel") return { items: [], hasMore: false, total: 0, page, pageSize };
    if (type !== "anime" && type !== "manga" && type !== "novel") throw new BangumiProviderError("bad_request", "作者作品分类无效");

    const [author, related] = await Promise.all([
      this.getAuthor(id, options.signal), this.getRelatedSubjects(id, options.signal),
    ]);
    const candidates = mergeRoles(related.filter((item) => item.type === (type === "anime" ? 2 : 1)));
    const start = (page - 1) * pageSize;
    const current = candidates.slice(start, start + pageSize);
    const result: AuthorWorksResult = {
      items: [], hasMore: start + pageSize < candidates.length, page, pageSize,
      ...(type === "anime" ? { total: candidates.length } : {}),
    };
    if (type === "anime") {
      result.items = current.map((subject) => withAuthor(toRelationMedia(subject), author, subject.staff));
      return result;
    }

    const settled = await mapConcurrent(current, 3, async (relation) => {
      checkCancelled(options.signal);
      const subject = await this.getSubject(relation.id, options.signal);
      if (subject.nsfw === true || classifyBangumiBook(subject) !== type) return undefined;
      return withAuthor(toSubjectMedia(subject, type, relation.image), author, relation.staff);
    }, options.signal);
    checkCancelled(options.signal);
    result.items = settled.flatMap((entry) => entry.status === "fulfilled" && entry.value ? [entry.value] : []);
    const failures = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failures.length === current.length && failures.length) throw failures[0].reason;
    if (failures.length) result.warning = `本页有 ${failures.length} 部关联作品的资料暂时读取失败，可重试本页。`;
    return result;
  }

  private async getAuthor(id: string, signal?: AbortSignal): Promise<Author> {
    checkCancelled(signal);
    const key = `bangumi:person:${id}`;
    const cached = this.cache.get<Author>(key);
    if (cached) return cached;
    const parsed = personSchema.safeParse(await this.request(`${API}/persons/${id}`, "GET", undefined, signal));
    if (!parsed.success || String(parsed.data.id) !== id) throw invalidResponse("作者资料响应格式发生变化，请稍后重试");
    const author = toAuthor(parsed.data);
    checkCancelled(signal);
    this.cache.set(key, author, CACHE_TTL);
    return author;
  }

  private async getRelatedSubjects(id: string, signal?: AbortSignal): Promise<RelatedSubject[]> {
    checkCancelled(signal);
    const key = `bangumi:person-subjects:${id}`;
    const cached = this.cache.get<RelatedSubject[]>(key);
    if (cached) return cached;
    const parsed = relatedSubjectsSchema.safeParse(await this.request(`${API}/persons/${id}/subjects`, "GET", undefined, signal));
    if (!parsed.success) throw invalidResponse("作者关联作品响应格式发生变化，请稍后重试");
    checkCancelled(signal);
    this.cache.set(key, parsed.data, CACHE_TTL);
    return parsed.data;
  }

  private async getSubject(id: number, signal?: AbortSignal): Promise<Subject> {
    checkCancelled(signal);
    const key = `bangumi:author-subject:${id}`;
    const cached = this.cache.get<Subject>(key);
    if (cached) return cached;
    const parsed = subjectSchema.safeParse(await this.request(`${API}/subjects/${id}`, "GET", undefined, signal));
    if (!parsed.success || parsed.data.id !== id) throw invalidResponse("作者作品详情响应格式发生变化，请稍后重试");
    checkCancelled(signal);
    this.cache.set(key, parsed.data, CACHE_TTL);
    return parsed.data;
  }

  private async request(url: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      checkCancelled(signal);
      const controller = new AbortController();
      const abort = () => controller.abort(cancellationReason(signal!));
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException("Bangumi 作者检索请求超时", "TimeoutError")), this.timeoutMs);
      try {
        return await abortableRequest(async () => {
          await this.limiter.wait();
          checkCancelled(controller.signal);
          const response = await this.fetcher(url, {
            method, headers: { Accept: "application/json", "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal, timeoutMs: this.timeoutMs,
          });
          if (response.status < 200 || response.status >= 300) throw statusError(response.status);
          return parseJsonResponse(response, BangumiProviderError);
        }, controller.signal);
      } catch (cause) {
        if (signal?.aborted) throw cancellationReason(signal);
        const retryable = !(cause instanceof BangumiProviderError) || cause.code === "rate_limited" || cause.code === "server_error";
        if (attempt < this.maxRetries && retryable) { await abortableRequest(() => this.sleep(250 * 2 ** attempt), signal); continue; }
        if (cause instanceof BangumiProviderError) throw cause;
        if (controller.signal.aborted || isTimeoutError(cause)) throw new BangumiProviderError("timeout", "Bangumi 作者检索超时，请重试");
        throw new BangumiProviderError("network", "无法连接 Bangumi 作者检索，请检查网络后重试");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }
  }
}

function invalidResponse(message: string): BangumiProviderError { return new BangumiProviderError("invalid_response", message); }
function statusError(status: number): BangumiProviderError {
  const message = `Bangumi 作者检索暂时不可用（HTTP ${status}）`;
  const code = status === 400 ? "bad_request" : status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "network";
  return new BangumiProviderError(code, message, status);
}
function cancellationReason(signal: AbortSignal): unknown { return signal.reason ?? new DOMException("作者检索已取消", "AbortError"); }
function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw cancellationReason(signal); }
function parsePersonId(value: string): string {
  const id = value.replace(/^bangumi:person:/, "");
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new BangumiProviderError("bad_request", "Bangumi 作者 ID 无效");
  return id;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function image(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    try { const url = new URL(value.trim().replace(/^http:/i, "https:")); if (url.protocol === "https:" && !url.username && !url.password) return url.toString(); } catch { /* Try the next provided image. */ }
  }
  return undefined;
}
function aliases(infobox: unknown): string[] {
  if (!Array.isArray(infobox)) return [];
  return [...new Set(infobox.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || !["别名", "简体中文名", "繁体中文名"].includes(String(raw.key))) return [];
    return (Array.isArray(raw.value) ? raw.value : [raw.value]).flatMap((value: unknown) => {
      const candidate = text(typeof value === "object" && value ? (value as { v?: unknown }).v : value);
      return candidate ? [candidate] : [];
    });
  }))];
}
function toAuthor(person: z.infer<typeof personSchema>): Author {
  const imageUrl = image(person.images?.large, person.images?.medium, person.images?.small, person.img);
  const summary = text(person.summary) ?? text(person.short_summary);
  return { id: String(person.id), name: person.name, aliases: aliases(person.infobox).filter((alias) => alias !== person.name),
    ...(imageUrl ? { imageUrl } : {}), ...(summary ? { summary } : {}) };
}
function mergeRoles(subjects: RelatedSubject[]): RelatedSubject[] {
  const merged = new Map<number, RelatedSubject>();
  const roles = new Map<number, Set<string>>();
  for (const subject of subjects) {
    if (!merged.has(subject.id)) { merged.set(subject.id, { ...subject }); roles.set(subject.id, new Set()); }
    const role = text(subject.staff);
    if (role) roles.get(subject.id)!.add(role);
  }
  return [...merged.values()].map((subject) => ({ ...subject, staff: [...roles.get(subject.id)!].join(" / ") }));
}
function toRelationMedia(subject: RelatedSubject): Media {
  const title = text(subject.name_cn) ?? subject.name;
  const coverUrl = image(subject.image);
  return { id: `bangumi:${subject.id}`, type: "anime", title,
    ...(title !== subject.name ? { originalTitle: subject.name } : {}),
    aliases: [...new Set([subject.name, text(subject.name_cn)].filter((value): value is string => !!value))],
    ...(coverUrl ? { coverUrl } : {}), externalIds: [{ provider: "bangumi", value: String(subject.id) }],
    metadata: { bangumiType: subject.type, raw: subject } };
}
function toSubjectMedia(subject: Subject, type: "manga" | "novel", fallbackImage?: string | null): Media {
  const title = text(subject.name_cn) ?? subject.name;
  const coverUrl = image(subject.images?.large, subject.images?.medium, subject.images?.common, subject.images?.small, fallbackImage);
  const releaseYear = subject.date && /^\d{4}-\d{2}-\d{2}$/.test(subject.date) ? Number(subject.date.slice(0, 4)) : undefined;
  const rating = subject.rating && typeof subject.rating === "object" ? subject.rating as Record<string, unknown> : {};
  const score = Number(rating.score); const count = Number(rating.total);
  return { id: `bangumi:${subject.id}`, type, title,
    ...(title !== subject.name ? { originalTitle: subject.name } : {}),
    aliases: [...new Set([subject.name, text(subject.name_cn), ...aliases(subject.infobox)].filter((value): value is string => !!value))],
    ...(text(subject.summary) ? { description: text(subject.summary) } : {}), ...(coverUrl ? { coverUrl } : {}),
    ...(releaseYear && releaseYear > 0 ? { releaseYear } : {}), externalIds: [{ provider: "bangumi", value: String(subject.id) }],
    metadata: { bangumiType: subject.type, platform: subject.platform, date: subject.date, raw: subject,
      ...(Number.isFinite(score) && score > 0 && score <= 10 ? { rating: score } : {}),
      ...(Number.isFinite(count) && count >= 0 ? { ratingCount: count } : {}) } };
}
function withAuthor(media: Media, author: Author, role: string): Media {
  return { ...media, metadata: { ...media.metadata, authorId: author.id, authorName: author.name, authorRelation: role, authorRole: role } };
}
async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, load: (item: T) => Promise<R>, signal?: AbortSignal): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      checkCancelled(signal);
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await load(items[index]) }; }
      catch (reason) { checkCancelled(signal); results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}
