import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { MinIntervalLimiter, type Sleep } from "@/infrastructure/metadata/rate-limiter";
import { isTimeoutError } from "@/infrastructure/metadata/response-errors";

const API = "https://api.vndb.org/kana";
const VN_FIELDS = "title,alttitle,titles{title,latin,lang},aliases,released,image{url}";
const RELEASE_FIELDS = "title,alttitle,languages{lang,title,latin,main},platforms,freeware,patch,released,official,vns{id,rtype},extlinks{url,label,name}";
const titleSchema = z.object({ title: z.string(), latin: z.string().nullable().optional(), lang: z.string() });
const vnSchema = z.object({
  id: z.string().regex(/^v[1-9]\d*$/), title: z.string().min(1), alttitle: z.string().nullable().optional(),
  titles: z.array(titleSchema).default([]), aliases: z.array(z.string()).default([]), released: z.string().nullable().optional(),
  image: z.object({ url: z.string().url() }).nullable().optional(),
});
const vnResponseSchema = z.object({ results: z.array(vnSchema), more: z.boolean().default(false) });
const releaseSchema = z.object({
  id: z.string().regex(/^r[1-9]\d*$/), title: z.string().min(1), alttitle: z.string().nullable().optional(),
  languages: z.array(z.object({ lang: z.string(), title: z.string().nullable().optional(), latin: z.string().nullable().optional(), main: z.boolean().optional() })),
  platforms: z.array(z.string()), freeware: z.boolean(), patch: z.boolean(), official: z.boolean(), released: z.string().nullable().optional(),
  vns: z.array(z.object({ id: z.string(), rtype: z.enum(["complete", "partial", "trial"]) })),
  // Skip a malformed external link without hiding every other release.
  extlinks: z.array(z.unknown()),
});
const releaseResponseSchema = z.object({ results: z.array(releaseSchema), more: z.boolean().default(false) });
const linkSchema = z.object({ url: z.string().min(1).max(8192), label: z.string(), name: z.string() });
type VN = z.infer<typeof vnSchema>;
type Release = z.infer<typeof releaseSchema>;

export interface VndbReleaseSourceProviderOptions {
  apiUrl?: string;
  fetcher?: JsonFetcher;
  timeoutMs?: number;
  minIntervalMs?: number;
  sleep?: Sleep;
  signal?: AbortSignal;
}

/** Anonymous public release catalog, not a file resolver.
 * https://api.vndb.org/kana#post-release documents official/freeware and vns.rtype.
 * Every result remains an external page even when VNDB marks the edition freeware.
 */
export class VndbReleaseSourceProvider implements SourceProvider {
  readonly id = "vndb-release";
  readonly name = "VNDB 官方发行与试玩";
  readonly supportedTypes: MediaType[] = ["visual_novel"];
  private readonly fetcher: JsonFetcher;
  private readonly timeoutMs: number;
  private readonly limiter: MinIntervalLimiter;
  private readonly signal?: AbortSignal;
  private readonly resources = new Map<string, ResourceItem>();

  constructor(options: VndbReleaseSourceProviderOptions = {}) {
    if ((options.apiUrl ?? API).replace(/\/$/, "") !== API) throw new Error("VNDB 发行来源地址必须使用官方 https://api.vndb.org/kana");
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(35_000, Math.max(500, options.timeoutMs!)) : 10_000;
    this.limiter = new MinIntervalLimiter(options.minIntervalMs ?? 1_500, Date.now, options.sleep);
    this.signal = options.signal;
  }

  async search(query: SourceSearchQuery, signal = this.signal): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "visual_novel") return [];
    const keywords = [...new Set([query.keyword, ...query.aliases].map((value) => value.trim()).filter(Boolean))].slice(0, 3);
    if (!keywords.length) return [];
    const page = query.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new Error("VNDB 发行目录搜索页码无效");
    const responses = await Promise.allSettled(keywords.map(async (keyword) => {
      const parsed = vnResponseSchema.safeParse(await this.request("vn", {
        filters: ["search", "=", keyword], fields: VN_FIELDS, results: 12, page, sort: "searchrank",
      }, signal));
      if (!parsed.success) throw new Error("VNDB 作品目录格式发生变化，请在原站确认");
      return parsed.data.results;
    }));
    signal?.throwIfAborted();
    const successful = responses.filter((result) => result.status === "fulfilled");
    if (!successful.length) {
      const failure = responses.find((result) => result.status === "rejected");
      throw failure?.reason instanceof Error ? failure.reason : new Error("VNDB 作品目录检索失败");
    }
    const matches = new Map<string, VN>();
    for (const response of successful) for (const vn of response.value) if (!matches.has(vn.id)) matches.set(vn.id, vn);
    return [...matches.values()].slice(0, 24).map((vn) => {
      const aliases = [...new Set([vn.title, vn.alttitle, ...vn.aliases, ...vn.titles.flatMap((title) => [title.title, title.latin])].filter((value): value is string => Boolean(value?.trim())))];
      const year = vn.released && /^\d{4}/.test(vn.released) ? Number(vn.released.slice(0, 4)) : undefined;
      return {
        sourceId: this.id, sourceItemId: vn.id, title: preferredTitle(vn), aliases,
        ...(vn.image?.url ? { coverUrl: vn.image.url } : {}), ...(year ? { releaseYear: year } : {}),
        raw: { ...vn, aliases, sourceUrl: `https://vndb.org/${vn.id}`, catalogApiVersion: "kana" },
      };
    });
  }

  async listResources(sourceItemId: string, signal = this.signal): Promise<ResourceItem[]> {
    if (!/^v[1-9]\d*$/.test(sourceItemId)) throw new Error("VNDB 作品 ID 无效");
    const releases: Release[] = [];
    let catalogTruncated = false;
    // Canonical VNDB IDs allow a saved work to reload without a warm search cache.
    // Two bounded pages cover older trial editions without unbounded catalog crawling.
    for (let page = 1; page <= 2; page += 1) {
      const parsed = releaseResponseSchema.safeParse(await this.request("release", {
        filters: ["and", ["vn", "=", ["id", "=", sourceItemId]], ["official", "=", true]],
        fields: RELEASE_FIELDS, results: 100, sort: "released", reverse: true, page,
      }, signal));
      if (!parsed.success) throw new Error("VNDB 发行目录格式发生变化，请在原站确认");
      releases.push(...parsed.data.results);
      catalogTruncated = page === 2 && parsed.data.more;
      if (!parsed.data.more) break;
    }
    const sorted = releases.filter((release) => release.official && release.vns.some((linked) => linked.id === sourceItemId))
      .sort((left, right) => releasePriority(right, sourceItemId) - releasePriority(left, sourceItemId) || (right.released ?? "").localeCompare(left.released ?? ""));
    const results = new Map<string, ResourceItem>();
    let resultTruncated = false;
    releaseLoop: for (const release of sorted) {
      const rtype = release.vns.find((linked) => linked.id === sourceItemId)!.rtype;
      const editionLabel = release.patch ? "补丁（需游戏本体）" : rtype === "trial" ? "试玩版" : rtype === "partial" ? "部分内容" : "完整发行版";
      const priceLabel = release.freeware ? "免费发行" : "商店 / 付费发行";
      const languages = release.languages.map((language) => language.lang);
      const releaseTitle = release.languages.find((language) => /^zh(?:-|$)/i.test(language.lang))?.title?.trim() || release.title;
      for (const rawLink of release.extlinks) {
        const link = validDistributionLink(rawLink);
        if (!link) continue;
        // A shared website can represent different languages, platforms or a trial.
        // Only duplicate links within the same VNDB release have the same identity.
        const key = `${release.id}:${link.url}`;
        if (results.has(key)) continue;
        if (results.size >= 40) { resultTruncated = true; break releaseLoop; }
        const warnings = ["这是 VNDB 收录的官网或商店入口，请在原站确认版本、价格及获取条件；不会将网页加入文件下载。"];
        if (rtype === "trial") warnings.push("试玩版只包含体验内容，不是完整游戏。");
        if (rtype === "partial") warnings.push("此发行版本只包含部分内容。");
        if (release.patch) warnings.push("补丁不能独立运行，需要对应版本的游戏本体。");
        if (catalogTruncated) warnings.push("发行目录较多，本次只检查最新 200 条发行记录；更早版本请在 VNDB 查看。");
        const resource: ResourceItem = {
          id: `${this.id}:${release.id}:${encodeURIComponent(link.url)}`, sourceId: this.id, sourceItemId,
          title: `${releaseTitle} · ${editionLabel} · ${priceLabel} · ${link.label}`,
          protocol: "http", targetUrl: link.url,
          ...(languages.length ? { language: languages.join(" / ") } : {}),
          metadata: {
            downloadMode: "external_link", resourceLabel: `${editionLabel} · ${priceLabel}`,
            provider: this.name, sourceUrl: link.url, releasePage: `https://vndb.org/${release.id}`,
            vndbId: sourceItemId, vndbReleaseId: release.id, releaseType: rtype, releaseTitle,
            freeware: release.freeware, patch: release.patch, official: release.official,
            language: languages.join(" / "), languages, platform: release.platforms.join(" / "), platforms: release.platforms,
            languageLabels: [...new Set(languages.map(languageLabel))], platformLabels: [...new Set(release.platforms.map(platformLabel))],
            resourceTypeLabel: editionLabel, truncated: catalogTruncated,
            released: release.released ?? null, storeName: link.name, storeLabel: link.label,
            actionLabel: release.patch ? "前往补丁页面" : rtype === "trial" ? "前往试玩页面" : release.freeware ? "前往免费获取" : link.name === "website" ? "打开官方网站" : "前往商店",
            searchTerms: releaseSearchTerms(release, rtype),
            catalogApiVersion: "kana", warnings,
          },
          createdAt: new Date().toISOString(),
        };
        results.set(key, resource);
      }
    }
    const items = [...results.values()];
    for (const resource of items) {
      resource.metadata.catalogTruncated = catalogTruncated;
      resource.metadata.resultTruncated = resultTruncated;
      resource.metadata.truncated = catalogTruncated || resultTruncated;
      if (resultTruncated) (resource.metadata.warnings as string[]).push("发行入口较多，本次仅展示优先的 40 个入口；其余版本请在 VNDB 查看。");
      this.resources.set(resource.id, resource);
    }
    return items;
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("VNDB 发行入口已过期，请重新刷新来源");
    // Do not infer file download behavior from an official page's path or suffix.
    return { protocol: "http", url: resource.targetUrl };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const result = releaseResponseSchema.safeParse(await this.request("release", {
        filters: ["and", ["vn", "=", ["id", "=", "v21905"]], ["official", "=", true]], fields: RELEASE_FIELDS, results: 1,
      }, this.signal));
      if (!result.success) throw new Error("VNDB 发行目录响应格式发生变化");
      return { ok: true, checkedAt, message: "官方发行目录可匿名查询；提供官网、商店与试玩入口，具体获取条件以原站为准" };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "VNDB 发行目录暂时不可用" };
    }
  }

  private async request(endpoint: "vn" | "release", body: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    await abortableRequest(() => this.limiter.wait(), signal);
    const timedSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timedSignal]) : timedSignal;
    try {
      const response = await abortableRequest(() => this.fetcher(`${API}/${endpoint}`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: combinedSignal, timeoutMs: this.timeoutMs,
      }), combinedSignal);
      if (response.status === 429) throw new Error("VNDB 发行目录请求过于频繁，请稍后重试");
      if (response.status < 200 || response.status >= 300) throw new Error(`VNDB 发行目录 HTTP ${response.status}，请稍后重试或打开原站`);
      return await abortableRequest(() => response.json(), combinedSignal);
    } catch (cause) {
      signal?.throwIfAborted();
      if (timedSignal.aborted || isTimeoutError(cause)) throw new Error("VNDB 发行目录请求超时，请稍后重试");
      if (cause instanceof Error && cause.message.startsWith("VNDB ")) throw cause;
      if (cause instanceof SyntaxError) throw new Error("VNDB 发行目录返回了无效 JSON，请稍后重试");
      throw new Error("无法连接 VNDB 发行目录，请检查网络后重试");
    }
  }
}

function preferredTitle(vn: VN): string {
  return vn.titles.find((title) => /^zh(?:-|$)/i.test(title.lang))?.title.trim() || vn.title;
}

function releasePriority(release: Release, vnId: string): number {
  const chinese = release.languages.some((language) => /^zh(?:-|$)/i.test(language.lang));
  const desktop = release.platforms.some((platform) => ["win", "lin", "mac"].includes(platform));
  const type = release.vns.find((linked) => linked.id === vnId)?.rtype;
  return (chinese ? 100 : 0) + (release.freeware ? 60 : 0) + (type === "trial" ? 35 : 0)
    + (desktop ? 25 : 0) - (release.patch ? 150 : 0);
}

function releaseSearchTerms(release: Release, rtype: "complete" | "partial" | "trial"): string[] {
  const labels: string[] = [];
  for (const { lang } of release.languages) {
    if (/^zh(?:-|$)/i.test(lang)) labels.push("中文");
    if (lang === "zh-Hans") labels.push("简体中文");
    if (lang === "zh-Hant") labels.push("繁体中文");
    if (lang === "ja") labels.push("日语", "日文");
    if (lang === "en") labels.push("英语", "英文");
  }
  if (release.freeware) labels.push("免费");
  if (release.patch) labels.push("补丁", "需游戏本体");
  else if (rtype === "trial") labels.push("试玩", "体验版");
  else if (rtype === "partial") labels.push("部分内容");
  else labels.push("完整发行版");
  if (!release.freeware) labels.push("商店", "付费发行");
  for (const platform of release.platforms) {
    if (platform === "win") labels.push("Windows", "PC");
    if (platform === "lin") labels.push("Linux", "PC");
    if (platform === "mac") labels.push("macOS", "PC");
    if (platform === "and") labels.push("安卓", "Android");
    if (platform === "ios") labels.push("iOS");
    if (platform === "swi") labels.push("Switch");
  }
  return [...new Set(labels)];
}

function languageLabel(language: string): string {
  return ({ zh: "中文", "zh-Hans": "简体中文", "zh-Hant": "繁体中文", ja: "日语", en: "英语", ko: "韩语",
    de: "德语", fr: "法语", es: "西班牙语", it: "意大利语", ru: "俄语", "pt-br": "葡萄牙语（巴西）" } as Record<string, string>)[language] ?? language;
}
function platformLabel(platform: string): string {
  return ({ win: "Windows", lin: "Linux", mac: "macOS", web: "网页", and: "Android", ios: "iOS", swi: "Switch", sw2: "Switch 2",
    ps1: "PlayStation", ps2: "PS2", ps3: "PS3", ps4: "PS4", ps5: "PS5", psp: "PSP", psv: "PS Vita", xb3: "Xbox 360", xbo: "Xbox One", xxs: "Xbox Series" } as Record<string, string>)[platform] ?? platform;
}

// These names are distribution destinations in the published VNDB schema.
// Generated database/wiki/analytics links (e.g. steamdb and egs) are excluded.
const STORE_DOMAINS: Record<string, string[]> = {
  steam: ["store.steampowered.com"], itch: ["itch.io"], gog: ["gog.com"], booth: ["booth.pm"],
  dlsite: ["dlsite.com"], jastusa: ["jastusa.com"], denpa: ["denpasoft.com"], mg: ["mangagamer.com"],
  dmm: ["dmm.co.jp", "dmm.com"], johren: ["johren.games"], getchu: ["getchu.com"], getchudl: ["getchu.com"],
  gyutto: ["gyutto.com"], digiket: ["digiket.com"], freem: ["freem.ne.jp"], novelgam: ["novelgame.jp"],
  gamejolt: ["gamejolt.com"], kagura: ["kaguragames.com"], googplay: ["play.google.com"], appstore: ["apps.apple.com"],
  nintendo: ["nintendo.com"], nintendo_jp: ["nintendo.com"], nintendo_hk: ["nintendo.com.hk"],
  playstation_na: ["store.playstation.com"], playstation_eu: ["store.playstation.com"],
  playstation_jp: ["store.playstation.com"], playstation_hk: ["store.playstation.com"],
};
const NON_DISTRIBUTION_DOMAINS = [
  "vndb.org", "wikipedia.org", "wikidata.org", "fandom.com", "steamdb.info", "erogamescape.dyndns.org",
  "archive.org", "archive.is", "webcache.googleusercontent.com", "apkpure.net", "apkpure.com", "apkmirror.com",
  "dcinside.com", "keyfc.net", "reddit.com", "youtube.com", "youtu.be", "twitter.com", "x.com", "facebook.com",
  "mega.nz", "pan.baidu.com", "drive.google.com", "1drv.ms", "quark.cn", "aliyundrive.com",
];
function domainMatches(host: string, domain: string): boolean { return host === domain || host.endsWith(`.${domain}`); }
function validDistributionLink(raw: unknown): { url: string; label: string; name: string } | undefined {
  const parsed = linkSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const link = parsed.data;
  try {
    const url = new URL(link.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || !url.hostname.includes(".")) return undefined;
    const host = url.hostname.toLowerCase();
    // No localhost/private IP, archive, wiki, social or arbitrary sharing destinations.
    if (/^[\d.]+$/.test(host) || host.includes(":") || host.endsWith(".localhost") || host.endsWith(".local")
      || NON_DISTRIBUTION_DOMAINS.some((domain) => domainMatches(host, domain))) return undefined;
    if (link.name === "website") {
      if (/(?:^|\/)(?:wiki|bbs|forum|forums|showtopic)(?:[/.\-]|$)/i.test(url.pathname)) return undefined;
    } else if (!STORE_DOMAINS[link.name]?.some((domain) => domainMatches(host, domain))) return undefined;
    url.hash = "";
    return { url: url.toString(), label: link.name === "website" ? "官网" : link.label, name: link.name };
  } catch { return undefined; }
}
