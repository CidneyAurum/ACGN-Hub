import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { parseDownloadTarget } from "@/shared/validation";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";
import { isTimeoutError } from "@/infrastructure/metadata/response-errors";
import { matchesGalgameTitle } from "./galgame-title-matching";

const decimalId = z.string().regex(/^[1-9]\d{0,18}$/);
const imageSchema = z.object({ url: z.string().url() }).passthrough();
const workSchema = z.object({ object: z.literal("work"), id: decimalId, display_name: z.string().min(1),
  latin: z.string().nullable().optional(), localized: z.record(z.string(), z.object({ value: z.string(), is_machine: z.boolean().optional() }).passthrough()).default({}),
  cover: imageSchema.nullable().optional(), banner: imageSchema.nullable().optional(), release_date: z.string().nullable().optional(), is_nsfw: z.boolean().optional(),
}).passthrough();
const worksSchema = z.object({ object: z.literal("list"), items: z.array(workSchema) }).passthrough();
const resourceCardSchema = z.object({ object: z.literal("galgame_resource"), id: decimalId, work: z.object({ id: decimalId }).passthrough(),
  resource_type: z.string().min(1), resource_languages: z.array(z.string()).default([]), resource_platforms: z.array(z.string()).default([]), resource_runtimes: z.array(z.string()).default([]),
  title: z.string().default(""), size: z.string().default(""), state: z.enum(["valid", "expired"]), provider_names: z.array(z.string()).default([]), updated_at: z.string().optional(),
}).passthrough();
const resourceListSchema = z.object({ object: z.literal("list"), items: z.array(resourceCardSchema), total: z.number().int().nonnegative().optional() }).passthrough();
type Work = z.infer<typeof workSchema>;
type ResourceCard = z.infer<typeof resourceCardSchema>;
const RESOURCE_PAGE_SIZE = 50;
const MAX_RESOURCE_PAGES = 10;
const RESOURCE_TYPE_LABELS: Record<string, string> = { game: "游戏本体", patch: "补丁", collection: "合集", tool: "工具", walkthrough: "攻略", ost: "原声", voice: "语音", artbook: "画集" };
const LANGUAGE_LABELS: Record<string, string> = { "zh-cn": "简体中文", "zh-hans": "简体中文", "zh-tw": "繁体中文", "zh-hk": "繁体中文", "zh-hant": "繁体中文", zh: "中文", ja: "日文", en: "英文", ko: "韩文", multi: "多语言", other: "其他语言" };
const PLATFORM_LABELS: Record<string, string> = { win: "Windows", windows: "Windows", mac: "macOS", macos: "macOS", lin: "Linux", linux: "Linux", and: "Android", android: "Android", ios: "iOS", web: "浏览器", switch: "Switch", psp: "PSP", psv: "PS Vita", other: "其他平台" };
const RUNTIME_LABELS: Record<string, string> = { "native-win": "Windows 原生", "native-mac": "macOS 原生", "native-linux": "Linux 原生", "native-and": "Android 原生", "native-android": "Android 原生", "native-ios": "iOS 原生", emulator: "模拟器", kirikiri: "吉里吉里", kirikiroid2: "吉里吉里2", tyranor: "Tyranor", renpy: "Ren'Py", onscripter: "ONScripter", web: "浏览器", other: "其他运行方式" };
export interface KUNGalgameSourceProviderOptions { fetcher?: JsonFetcher; timeoutMs?: number; signal?: AbortSignal }

/** Public v1 catalog. Share-link resolution and download counters stay on the source site.
 * https://github.com/KunMoe/kun-galgame-forum/tree/master/apps/api/internal/search/apiv1
 * The removed /api/galgame/search/picker route now falls into legacy authentication.
 */
export class KUNGalgameSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "鲲 Galgame";
  readonly supportedTypes: MediaType[] = ["visual_novel"];
  private readonly baseUrl: string;
  private readonly fetcher: JsonFetcher;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly games = new Map<string, Work>();
  private readonly resources = new Map<string, ResourceItem>();
  constructor(baseUrl = "https://www.kungal.com", options: KUNGalgameSourceProviderOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("鲲 Galgame 地址必须是不带认证信息的 HTTP/HTTPS 地址");
    this.baseUrl = parsed.origin; this.id = `kungal:${this.baseUrl}`;
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(35_000, Math.max(500, options.timeoutMs!)) : 10_000;
    this.signal = options.signal;
  }
  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "visual_novel") return [];
    const explicitId = this.workIdFromInput(query.keyword);
    if (explicitId) {
      const game = await this.loadWork(explicitId);
      return game.is_nsfw ? [] : [this.toSearchResult(game)];
    }
    const queries = [...new Set([query.keyword, ...query.aliases].map((value) => value.trim()).filter(Boolean))].slice(0, 4);
    if (!queries.length) return [];
    const responses = await Promise.allSettled(queries.map((value) => this.searchWorks(value, query.page ?? 1)));
    this.signal?.throwIfAborted();
    const successful = responses.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!successful.length) {
      const failure = responses.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      throw failure instanceof Error ? failure : new Error("鲲 Galgame 公开目录搜索失败");
    }
    const games = new Map<string, Work>();
    for (const items of successful) for (const game of items) {
      if (!game.is_nsfw && matchesGalgameTitle(queries, workAliases(game))) games.set(game.id, game);
    }
    return [...games.values()].map((game) => this.toSearchResult(game));
  }
  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    if (!decimalId.safeParse(sourceItemId).success) throw new Error("鲲 Galgame 作品 ID 无效");
    const game = this.games.get(sourceItemId) ?? await this.loadWork(sourceItemId);
    if (game.is_nsfw) return [];
    const cards = new Map<string, ResourceCard>();
    let truncated = false;
    for (let page = 1; page <= MAX_RESOURCE_PAGES; page++) {
      const response = resourceListSchema.safeParse(await this.fetchJson(`${this.baseUrl}/api/v1/works/${game.id}/resources?page=${page}&limit=${RESOURCE_PAGE_SIZE}`));
      if (!response.success) throw new Error("鲲 Galgame 公开资源目录响应格式发生变化，请打开原站查看");
      const previousSize = cards.size;
      for (const card of response.data.items) cards.set(card.id, card);
      const hasMore = response.data.items.length >= RESOURCE_PAGE_SIZE && (response.data.total === undefined || page * RESOURCE_PAGE_SIZE < response.data.total);
      if (!hasMore) break;
      if (page === MAX_RESOURCE_PAGES || cards.size === previousSize) { truncated = true; break; }
    }
    return [...cards.values()].filter((card) => card.state === "valid" && card.work.id === game.id).map((card) => {
      // These are HTML pages, never file/CDN URLs. POST /downloads mutates a
      // counter and is deliberately not invoked by catalog inspection.
      const resourcePage = `${this.baseUrl}/galgame/resource/${card.id}`;
      const resourceTypeLabel = RESOURCE_TYPE_LABELS[card.resource_type] || card.resource_type;
      const languageLabels = translateLabels(card.resource_languages, LANGUAGE_LABELS);
      const platformLabels = translateLabels(card.resource_platforms, PLATFORM_LABELS);
      const runtimeLabels = translateLabels(card.resource_runtimes, RUNTIME_LABELS);
      const androidKeywords = card.resource_platforms.some((value) => ["and", "android"].includes(value.toLowerCase())) ||
        card.resource_runtimes.some((value) => ["native-and", "native-android"].includes(value.toLowerCase())) ? ["安卓"] : [];
      const sizeBytes = parseResourceSize(card.size);
      const warnings = ["这是原站资源页面，网盘权限、文件与下载条件需要在来源中确认，不会把网页加入文件下载"];
      if (truncated) warnings.push(`资源目录较多或分页未完整返回，目前最多读取前 ${RESOURCE_PAGE_SIZE * MAX_RESOURCE_PAGES} 条，请到原站查看完整目录`);
      const resource: ResourceItem = { id: `${this.id}:v1:${card.id}`, sourceId: this.id, sourceItemId,
        title: [preferredTitle(game), card.title.trim() || resourceTypeLabel, platformLabels.join(" / "), card.provider_names.join(" / ") || "原站资源页"].filter(Boolean).join(" · "),
        protocol: "http", targetUrl: resourcePage, ...(languageLabels.length ? { language: languageLabels.join(" / ") } : {}), ...(sizeBytes ? { sizeBytes } : {}),
        metadata: { downloadMode: "external_link", resourceLabel: "站外资源索引", provider: "鲲 Galgame", kungalResourceId: card.id, resourcePage, sourceUrl: resourcePage,
          providerNames: card.provider_names, resourceType: card.resource_type, language: card.resource_languages.join(" / "), platform: card.resource_platforms.join(" / "), runtimes: card.resource_runtimes,
          resourceTypeLabel, languageLabels, platformLabels, runtimeLabels,
          size: card.size, sizeLabel: card.size.trim(), catalogApiVersion: "v1", ...(card.updated_at ? { sourceUpdatedAt: card.updated_at } : {}),
          searchTerms: [resourceTypeLabel, ...languageLabels, ...platformLabels, ...runtimeLabels, ...androidKeywords, card.size, ...card.provider_names, ...card.resource_platforms, ...card.resource_runtimes, ...card.resource_languages].join(" "),
          ...(truncated ? { catalogTruncated: true } : {}), warnings }, createdAt: new Date().toISOString() };
      this.resources.set(resource.id, resource);
      if (this.resources.size > 1_500) this.resources.delete(this.resources.keys().next().value!);
      return resource;
    });
  }
  async resolve(resourceId: string): Promise<DownloadTarget> {
    const resource = this.resources.get(resourceId); if (!resource) throw new Error("鲲 Galgame 资源已过期，请重新刷新来源");
    return parseDownloadTarget(resource.targetUrl);
  }
  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try { await this.searchWorks("CLANNAD", 1); return { ok: true, checkedAt, message: "公开作品目录可匿名检索；资源为原站页面，具体文件权限需在原站确认" }; }
    catch (cause) { return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "鲲 Galgame 公开目录不可用" }; }
  }
  private toSearchResult(game: Work): SourceSearchResult {
    this.games.set(game.id, game);
    if (this.games.size > 200) this.games.delete(this.games.keys().next().value!);
    const coverUrl = game.cover?.url ?? game.banner?.url;
    const year = game.release_date && /^\d{4}-/.test(game.release_date) ? Number(game.release_date.slice(0, 4)) : undefined;
    return { sourceId: this.id, sourceItemId: game.id, title: preferredTitle(game), aliases: workAliases(game), ...(coverUrl ? { coverUrl } : {}), ...(year ? { releaseYear: year } : {}),
      raw: { ...game, sourceUrl: `${this.baseUrl}/galgame/${game.id}`, catalogApiVersion: "v1" } };
  }
  private async loadWork(id: string): Promise<Work> {
    const parsed = workSchema.safeParse(await this.fetchJson(`${this.baseUrl}/api/v1/works/${id}`));
    if (!parsed.success || parsed.data.id !== id) throw new Error("鲲 Galgame 公开作品详情响应格式发生变化，请打开原站查看");
    this.games.set(id, parsed.data);
    return parsed.data;
  }
  private workIdFromInput(input: string): string | undefined {
    const trimmed = input.trim();
    if (decimalId.safeParse(trimmed).success) return trimmed;
    try {
      const parsed = new URL(trimmed);
      if (parsed.origin !== this.baseUrl || parsed.username || parsed.password) return undefined;
      const id = parsed.pathname.match(/^\/galgame\/([1-9]\d{0,18})\/?$/)?.[1];
      return id;
    } catch { return undefined; }
  }
  private async searchWorks(keyword: string, page: number): Promise<Work[]> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new Error("鲲 Galgame 搜索页码无效");
    const endpoint = new URL(`${this.baseUrl}/api/v1/search/works`);
    endpoint.searchParams.set("q", keyword); endpoint.searchParams.set("page", String(page)); endpoint.searchParams.set("limit", "24"); endpoint.searchParams.set("include_nsfw", "false");
    const parsed = worksSchema.safeParse(await this.fetchJson(endpoint.toString()));
    if (!parsed.success) throw new Error("鲲 Galgame 公开作品目录响应格式发生变化，请打开原站查看"); return parsed.data.items;
  }
  private async fetchJson(url: string): Promise<unknown> {
    this.signal?.throwIfAborted();
    const timed = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timed]) : timed;
    try {
      const response = await abortableRequest(() => this.fetcher(url, {
        method: "GET", headers: { Accept: "application/json" }, credentials: "omit", signal, timeoutMs: this.timeoutMs,
      }), signal);
      if (response.status === 429) throw new Error("鲲 Galgame 目录请求过于频繁，请稍后重试");
      if (response.status < 200 || response.status >= 300) throw new Error(`鲲 Galgame 公开目录 HTTP ${response.status}，请打开原站确认访问条件`);
      return await abortableRequest(() => response.json(), signal);
    } catch (cause) {
      this.signal?.throwIfAborted();
      if (timed.aborted || isTimeoutError(cause)) throw new Error("鲲 Galgame 目录请求超时，请稍后重试");
      if (cause instanceof Error && cause.message.startsWith("鲲 Galgame ")) throw cause;
      if (cause instanceof SyntaxError) throw new Error("鲲 Galgame 公开目录返回了无效 JSON，请稍后重试");
      throw new Error("无法连接鲲 Galgame 公开目录，请检查网络后重试");
    }
  }
}
function preferredTitle(game: Work): string { return game.localized["zh-Hans"]?.value.trim() || game.localized["zh-Hant"]?.value.trim() || game.display_name.trim() || game.localized.en?.value.trim() || `鲲 Galgame #${game.id}`; }
function workAliases(game: Work): string[] {
  return [...new Set([game.display_name, game.latin, ...Object.values(game.localized).map((name) => name.value)]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => [value.trim(), ...value.split(/\s+[|｜]\s+/u).map((part) => part.trim())]).filter(Boolean))];
}
function translateLabels(values: string[], labels: Record<string, string>): string[] {
  return [...new Set(values.map((value) => labels[value.toLowerCase()] || value))];
}
function parseResourceSize(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)(I?B)?$/i);
  if (!match) return undefined;
  const exponent = ["", "K", "M", "G", "T"].indexOf(match[2].toUpperCase());
  const size = Math.round(Number(match[1]) * 1024 ** exponent);
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}
