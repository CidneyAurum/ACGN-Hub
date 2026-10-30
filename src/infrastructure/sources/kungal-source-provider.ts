import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { parseDownloadTarget } from "@/shared/validation";

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
const resourceListSchema = z.object({ object: z.literal("list"), items: z.array(resourceCardSchema) }).passthrough();
type Work = z.infer<typeof workSchema>;
export interface KUNGalgameSourceProviderOptions { fetcher?: JsonFetcher; timeoutMs?: number }

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
  private readonly games = new Map<string, Work>();
  private readonly resources = new Map<string, ResourceItem>();
  constructor(baseUrl = "https://www.kungal.com", options: KUNGalgameSourceProviderOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("鲲 Galgame 地址必须是不带认证信息的 HTTP/HTTPS 地址");
    this.baseUrl = parsed.origin; this.id = `kungal:${this.baseUrl}`;
    this.fetcher = options.fetcher ?? createJsonFetcher(); this.timeoutMs = options.timeoutMs ?? 10_000;
  }
  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "visual_novel") return [];
    const queries = [...new Set([query.keyword, ...query.aliases].map((value) => value.trim()).filter(Boolean))].slice(0, 4);
    if (!queries.length) return [];
    const responses = await Promise.allSettled(queries.map((value) => this.searchWorks(value, query.page ?? 1)));
    const successful = responses.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!successful.length) {
      const failure = responses.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      throw failure instanceof Error ? failure : new Error("鲲 Galgame 公开目录搜索失败");
    }
    const terms = queries.map(normalize).filter(Boolean); const games = new Map<string, Work>();
    for (const items of successful) for (const game of items) {
      const haystack = normalize([game.display_name, game.latin, ...Object.values(game.localized).map((name) => name.value)].filter(Boolean).join(" "));
      if (!game.is_nsfw && terms.some((term) => haystack.includes(term))) games.set(game.id, game);
    }
    this.games.clear(); this.resources.clear();
    return [...games.values()].map((game) => {
      this.games.set(game.id, game);
      const coverUrl = game.cover?.url ?? game.banner?.url;
      const year = game.release_date && /^\d{4}-/.test(game.release_date) ? Number(game.release_date.slice(0, 4)) : undefined;
      return { sourceId: this.id, sourceItemId: game.id, title: preferredTitle(game), ...(coverUrl ? { coverUrl } : {}), ...(year ? { releaseYear: year } : {}),
        raw: { ...game, sourceUrl: `${this.baseUrl}/galgame/${game.id}`, catalogApiVersion: "v1" } };
    });
  }
  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const game = this.games.get(sourceItemId); if (!game) return [];
    const response = resourceListSchema.safeParse(await this.fetchJson(`${this.baseUrl}/api/v1/works/${game.id}/resources?page=1&limit=50`));
    if (!response.success) throw new Error("鲲 Galgame 公开资源目录响应格式发生变化，请打开原站查看");
    return response.data.items.filter((card) => card.state === "valid" && card.work.id === game.id).map((card) => {
      // These are HTML pages, never file/CDN URLs. POST /downloads mutates a
      // counter and is deliberately not invoked by catalog inspection.
      const resourcePage = `${this.baseUrl}/galgame/resource/${card.id}`;
      const typeLabels: Record<string, string> = { game: "游戏本体", patch: "补丁", collection: "合集", tool: "工具", walkthrough: "攻略", ost: "原声", voice: "语音", artbook: "画集" };
      const resource: ResourceItem = { id: `${this.id}:v1:${card.id}`, sourceId: this.id, sourceItemId,
        title: `${preferredTitle(game)} · ${card.title.trim() || typeLabels[card.resource_type] || card.resource_type} · ${card.provider_names.join(" / ") || "原站资源页"}`,
        protocol: "http", targetUrl: resourcePage, ...(card.resource_languages.length ? { language: card.resource_languages.join(" / ") } : {}),
        metadata: { downloadMode: "external_link", resourceLabel: "站外资源索引", provider: "鲲 Galgame", kungalResourceId: card.id, resourcePage, sourceUrl: resourcePage,
          providerNames: card.provider_names, resourceType: card.resource_type, language: card.resource_languages.join(" / "), platform: card.resource_platforms.join(" / "), runtimes: card.resource_runtimes,
          size: card.size, catalogApiVersion: "v1", ...(card.updated_at ? { sourceUpdatedAt: card.updated_at } : {}),
          warnings: ["这是原站资源页面，网盘权限、文件与下载条件需要在来源中确认，不会把网页加入文件下载"] }, createdAt: new Date().toISOString() };
      this.resources.set(resource.id, resource); return resource;
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
  private async searchWorks(keyword: string, page: number): Promise<Work[]> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new Error("鲲 Galgame 搜索页码无效");
    const endpoint = new URL(`${this.baseUrl}/api/v1/search/works`);
    endpoint.searchParams.set("q", keyword); endpoint.searchParams.set("page", String(page)); endpoint.searchParams.set("limit", "24"); endpoint.searchParams.set("include_nsfw", "false");
    const parsed = worksSchema.safeParse(await this.fetchJson(endpoint.toString()));
    if (!parsed.success) throw new Error("鲲 Galgame 公开作品目录响应格式发生变化，请打开原站查看"); return parsed.data.items;
  }
  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs), timeoutMs: this.timeoutMs });
    if (response.status < 200 || response.status >= 300) throw new Error(`鲲 Galgame 公开目录 HTTP ${response.status}，请打开原站确认访问条件`); return response.json();
  }
}
function preferredTitle(game: Work): string { return game.localized["zh-Hans"]?.value.trim() || game.localized["zh-Hant"]?.value.trim() || game.display_name.trim() || game.localized.en?.value.trim() || `鲲 Galgame #${game.id}`; }
function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ""); }
