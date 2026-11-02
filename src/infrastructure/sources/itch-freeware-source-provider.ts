import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { TextFetcher } from "@/application/feed-ports";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { sanitizeFileName } from "@/domain/organization";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";
import { timeoutSignal, anySignal, throwIfAborted, disposeAbortSignal } from "@/shared/abort-signals";
import { createItchFreewareFetcher } from "./itch-transport";
import { matchesGalgameTitle } from "./galgame-title-matching";
import { sourceSearchTerms } from "./source-matching";

const BASE = "https://itch.io";
const MAX_TEXT = 3 * 1024 * 1024;
interface CatalogueEntry {
  id: string; page: string; gameId: number; title: string; aliases: string[]; author: string;
  vndbId: string; fallbackLanguages: string[]; filePattern: RegExp; labelArchive?: "zip";
}
/** Audited, author-owned complete freeware only. This is not a site-wide search.
 * Current pages/files are fetched again; paid extras never enter the catalogue. */
const CATALOGUE: readonly CatalogueEntry[] = [
  { id: "npckc/one-night-hot-springs", page: "https://npckc.itch.io/one-night-hot-springs", gameId: 226937,
    title: "one night, hot springs", aliases: ["one night hot springs"], author: "npckc", vndbId: "v22619",
    fallbackLanguages: [], filePattern: /^(?:one-night-hot-springs-(?:win-linux|osx)\.zip|com\.npckc\.onsen-[\w.-]+-release\.apk)$/i },
  { id: "brianna-lei/butterfly-soup", page: "https://brianna-lei.itch.io/butterfly-soup", gameId: 143899,
    title: "蝴蝶汤", aliases: ["Butterfly Soup", "蝴蝶湯"], author: "Brianna Lei", vndbId: "v21875",
    fallbackLanguages: [], filePattern: /^Butterfly Soup - (?:PC|Mac|Linux) \(v\d+(?:\.\d+)*\)$/i, labelArchive: "zip" },
  { id: "zephyo/missed-message", page: "https://zephyo.itch.io/missed-message", gameId: 415035,
    title: "missed messages.", aliases: ["missed messages", "missed message"], author: "angela he", vndbId: "v25774",
    fallbackLanguages: ["en"], filePattern: /^missedmessages(?:Windows|Linux)?\.zip$/i },
];

interface HtmlNode { tag: string; attributes: Record<string, string>; children: HtmlNode[]; text: string; order?: Array<string | HtmlNode> }
interface GamePage { entry: CatalogueEntry; title: string; languages: string[]; coverUrl?: string; description: string }
interface Upload { id: string; name: string; platforms: string[]; format: string; sizeLabel?: string; version?: string }
interface FreeDownloads { game: GamePage; uploads: Upload[]; csrf: string }
export interface ItchFreewareSourceProviderOptions { fetcher?: TextFetcher; timeoutMs?: number; signal?: AbortSignal }
const htmlParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", htmlEntities: true,
  unpairedTags: ["img", "input", "meta", "link", "br", "hr", "source", "wbr", "area", "base", "embed"],
  stopNodes: ["*.script", "*.style"], trimValues: false, parseTagValue: false });
const viewSchema = z.object({ generate_download_url: z.string().url(), game: z.object({ id: z.number().int().positive(), slug: z.string(), min_price: z.number(), actual_price: z.number() }) });
const issuedSchema = z.object({ url: z.string().min(1).max(16_384), external: z.boolean().optional() });
const LANGUAGE_LABELS: Record<string, string> = { "zh-Hans": "简体中文", "zh-Hant": "繁体中文", zh: "中文", en: "英文", ja: "日文", ko: "韩文", fr: "法文", de: "德文", es: "西班牙文", "es-419": "拉丁美洲西班牙文", ru: "俄文", pt: "葡萄牙文", "pt-br": "巴西葡萄牙文", id: "印尼文", pl: "波兰文", vi: "越南文", cs: "捷克文", fa: "波斯文" };
const PLATFORM_LABELS: Record<string, string> = { win: "Windows", lin: "Linux", mac: "macOS", and: "Android" };

export class ItchFreewareSourceProvider implements SourceProvider {
  readonly id = "itch_freeware:https://itch.io";
  readonly name = "itch.io · 官方免费精选";
  readonly supportedTypes: MediaType[] = ["visual_novel"];
  private readonly fetcher: TextFetcher;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(baseUrl = BASE, options: ItchFreewareSourceProviderOptions = {}) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error("itch.io 免费精选必须使用官方 https://itch.io 地址"); }
    if (url.origin !== BASE || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("itch.io 免费精选必须使用官方 https://itch.io 地址");
    this.fetcher = options.fetcher ?? createItchFreewareFetcher();
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(30_000, Math.max(500, options.timeoutMs!)) : 15_000;
    this.signal = options.signal;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "visual_novel" || !query.keyword.trim()) return [];
    if (query.page !== undefined && (!Number.isSafeInteger(query.page) || query.page < 1)) throw new Error("itch.io 免费精选页码无效");
    if ((query.page ?? 1) > 1) return [];
    const explicit = entryForInput(query.keyword);
    const terms = sourceSearchTerms(query.keyword, query.aliases, 4);
    const entries = explicit ? [explicit] : CATALOGUE.filter((entry) => matchesGalgameTitle(terms,
      [entry.title, ...entry.aliases, entry.vndbId]));
    const results = await Promise.allSettled(entries.map(async (entry) => this.toSearchResult(await this.loadGame(entry))));
    throwIfAborted(this.signal);
    const successes = results.filter((result) => result.status === "fulfilled");
    if (entries.length && !successes.length) throw results.find((result) => result.status === "rejected")!.reason;
    return successes.map((result) => result.value);
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const entry = entryById(sourceItemId);
    const { game, uploads } = await this.freeDownloads(entry);
    return uploads.map((upload) => {
      const languageLabels = game.languages.map((lang) => LANGUAGE_LABELS[lang] ?? lang);
      const platformLabels = upload.platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform);
      const originalUrl = `${entry.page}?acgn_upload=${upload.id}`;
      const filename = friendlyFilename(game, upload);
      return { id: `itch_freeware:${entry.id}:${upload.id}`, sourceId: this.id, sourceItemId: entry.id,
        title: `${game.title} · 完整游戏 · ${platformLabels.join(" / ") || "平台待确认"}${upload.version ? ` · ${upload.version}` : ""}`,
        protocol: "http", targetUrl: originalUrl, format: upload.format.toUpperCase(),
        ...(languageLabels.length ? { language: languageLabels.join(" / ") } : {}),
        metadata: { downloadMode: "direct_file", needsFreshDownloadTarget: true, resourceType: "game", resourceTypeLabel: "完整游戏",
          resourceLabel: "作者官方免费发行", official: true, freeware: true, curatedCatalogue: true, catalogueSize: CATALOGUE.length,
          sourceUrl: entry.page, itchGamePage: entry.page, itchCatalogueId: entry.id, itchGameId: entry.gameId, itchUploadId: upload.id,
          vndbId: entry.vndbId, originalFileName: upload.name, downloadFileName: filename,
          languages: game.languages, languageLabels, platforms: upload.platforms, platformLabels,
          ...(upload.sizeLabel ? { size: upload.sizeLabel + "（来源约数）", sizeLabel: upload.sizeLabel } : {}),
          ...(upload.version ? { version: upload.version } : {}),
          searchTerms: ["官方", "免费", "完整游戏", ...languageLabels, ...(game.languages.some((lang) => lang.startsWith("zh")) ? ["中文"] : []),
            ...platformLabels, ...(upload.platforms.includes("and") ? ["安卓"] : []), ...entry.aliases],
          warnings: ["这是作者授权免费发行的精选作品目录，不是 itch.io 全站搜索；不会将画集、付费附加包、试玩或补丁当作完整游戏。",
            "文件地址由源站在实际下载时签发；下载完成后需自行解压或安装，应用不会运行游戏。", "语言以作者作品页标注为准，未启动游戏逐句核验。"] },
        createdAt: new Date().toISOString() } satisfies ResourceItem;
    });
  }

  /** Stable identity survives restart. Recheck public price and accessible uploads
   * before asking the normal anonymous download endpoint for a fresh CDN URL. */
  async resolve(resourceId: string): Promise<DownloadTarget> {
    const match = /^itch_freeware:([^:]+):([1-9]\d{0,17})$/.exec(resourceId);
    if (!match) throw new Error("itch.io 免费精选文件 ID 无效");
    const entry = entryById(match[1]);
    const { game, uploads, csrf } = await this.freeDownloads(entry);
    const upload = uploads.find((item) => item.id === match[2]);
    if (!upload) throw new Error("这个文件已不在作者当前免费完整游戏列表中，请重新搜索版本");
    const issued = issuedSchema.safeParse(parseJson(await this.request(`${entry.page}/file/${upload.id}`, csrf)));
    if (!issued.success || issued.data.external) throw new Error("itch.io 未返回可直接下载的官方文件地址，请到原站确认");
    const url = safeCdnUrl(issued.data.url);
    if (!url) throw new Error("itch.io 返回了未支持的文件主机，已停止下载，请到原站确认");
    return { protocol: "http", url, filename: friendlyFilename(game, upload) };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try { await this.loadGame(CATALOGUE[0]); return { ok: true, checkedAt, message: "作者公开免费页可匿名读取；精选完整作品，不代表全站或所有文件速度" }; }
    catch (cause) { return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "itch.io 免费精选暂时不可用" }; }
  }

  private async loadGame(entry: CatalogueEntry): Promise<GamePage> {
    const body = await this.request(entry.page);
    const view = readViewOptions(body);
    if (view.game.id !== entry.gameId || view.game.slug !== new URL(entry.page).pathname.slice(1) || view.generate_download_url !== `${entry.page}/download_url`) {
      throw new Error("itch.io 作者页面的作品身份发生变化，请在原站核对");
    }
    if (view.game.min_price !== 0 || view.game.actual_price !== 0) throw new Error("这部作品当前不再免费，应用不会尝试取得付费文件");
    const root = parseHtml(body);
    const nodes = all(root);
    const info = nodes.find((node) => hasClass(node, "game_info_panel_widget")) ?? nodes.find((node) => hasClass(node, "info_panel_wrapper"));
    const languages = info ? readLanguages(info) : [];
    const image = nodes.find((node) => node.tag === "meta" && node.attributes.property === "og:image")?.attributes.content;
    const description = nodes.find((node) => hasClass(node, "formatted_description"));
    const coverUrl = safeCoverUrl(image);
    return { entry, title: entry.title, languages: languages.length ? languages : [...entry.fallbackLanguages],
      ...(coverUrl ? { coverUrl } : {}), description: description ? content(description).replace(/\s+/g, " ").trim().slice(0, 4_000) : "作者官方免费发行的完整视觉小说，文件版本与平台以当前页面为准。" };
  }

  private toSearchResult(game: GamePage): SourceSearchResult {
    return { sourceId: this.id, sourceItemId: game.entry.id, title: game.title,
      aliases: [game.entry.title, ...game.entry.aliases],
      ...(game.coverUrl ? { coverUrl: game.coverUrl } : {}),
      raw: { sourceUrl: game.entry.page, description: game.description, originalTitle: game.entry.aliases[0] ?? game.entry.title,
        authors: [game.entry.author], editionLabel: "作者官方免费完整游戏", languages: game.languages, curatedCatalogue: true,
        warnings: ["精选作者官方免费作品，不是 itch.io 全站搜索；作品数量有限。"] } };
  }

  private async freeDownloads(entry: CatalogueEntry): Promise<FreeDownloads> {
    const game = await this.loadGame(entry);
    const purchase = parseHtml(await this.request(`${entry.page}/purchase`));
    if (!all(purchase).some((node) => hasClass(node, "direct_download_btn"))) {
      throw new Error("作者没有提供普通匿名免费获取选项，请到原站确认；不会提交付款请求");
    }
    const csrf = csrfFrom(purchase);
    const issued = issuedSchema.safeParse(parseJson(await this.request(`${entry.page}/download_url`, csrf)));
    if (!issued.success || issued.data.external) throw new Error("itch.io 未返回官方免费文件列表");
    const downloadPage = safeDownloadPage(issued.data.url, entry.page);
    if (!downloadPage) throw new Error("itch.io 免费文件列表地址无效");
    const download = parseHtml(await this.request(downloadPage));
    const uploads = readUploads(download, entry);
    if (!uploads.length) throw new Error("作者当前免费列表中没有已确认的完整游戏文件，请在原站核对版本");
    return { game, uploads, csrf: csrfFrom(download) };
  }

  private async request(url: string, csrf?: string): Promise<string> {
    throwIfAborted(this.signal);
    const timed = timeoutSignal(this.timeoutMs);
    const signal = this.signal ? anySignal([this.signal, timed]) : timed;
    try {
      const response = await abortableRequest(() => this.fetcher(url, {
        method: csrf === undefined ? "GET" : "POST", credentials: "omit", signal,
        headers: { Accept: "text/html, application/json", ...(csrf === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) },
        ...(csrf === undefined ? {} : { body: new URLSearchParams({ csrf_token: csrf }).toString() }),
        ...({ timeoutMs: this.timeoutMs } as { timeoutMs: number }),
      }), signal);
      if (response.status < 200 || response.status >= 300) throw new Error(`itch.io 公开免费请求 HTTP ${response.status}，请稍后重试或打开原站`);
      const body = await abortableRequest(() => response.text(), signal);
      if (body.length > MAX_TEXT) throw new Error("itch.io 页面超过读取上限");
      if (/Vercel Security Checkpoint|cf-chl-|<title>\s*Just a moment/i.test(body)) throw new Error("itch.io 要求原站访问验证，应用不会绕过，请在浏览器确认");
      return body;
    } catch (cause) {
      throwIfAborted(this.signal);
      if (timed.aborted) throw new Error("itch.io 免费精选请求超时，请稍后重试");
      if (cause instanceof Error && (cause.message.startsWith("itch.io ") || cause.message.startsWith("作者"))) throw cause;
      throw new Error("itch.io 免费精选暂时无法连接，请检查网络或在原站重试");
    } finally { disposeAbortSignal(signal); disposeAbortSignal(timed); }
  }
}

function entryById(id: string): CatalogueEntry {
  const entry = CATALOGUE.find((item) => item.id === id);
  if (!entry) throw new Error("itch.io 精选作品 ID 无效；此来源不提供全站任意作品下载");
  return entry;
}
function entryForInput(input: string): CatalogueEntry | undefined {
  const value = input.trim();
  const entry = CATALOGUE.find((item) => item.id === value || item.vndbId.toLowerCase() === value.toLowerCase());
  if (entry) return entry;
  try { const url = new URL(value); if (url.username || url.password) return; return CATALOGUE.find((item) => url.origin + url.pathname.replace(/\/$/, "") === item.page); } catch { return; }
}
function readViewOptions(body: string): z.infer<typeof viewSchema> {
  // The published init call contains JSON. Parse data only; never evaluate JS.
  const raw = /\binit_ViewGame\([^,]+,\s*(\{[\s\S]*?\})\);/.exec(body)?.[1];
  const parsed = viewSchema.safeParse(raw ? parseJson(raw) : undefined);
  if (!parsed.success) throw new Error("itch.io 作者公开目录格式发生变化，请在原站确认");
  return parsed.data;
}
function parseJson(body: string): unknown {
  try { return JSON.parse(body); } catch { throw new Error("itch.io 返回了无效目录数据，请稍后重试"); }
}
function hasClass(node: HtmlNode, name: string): boolean { return (node.attributes.class ?? "").split(/\s+/).includes(name); }
function all(node: HtmlNode): HtmlNode[] { return [node, ...node.children.flatMap(all)]; }
function content(node: HtmlNode): string {
  return node.order ? node.order.map((part) => typeof part === "string" ? part : ["script", "style"].includes(part.tag) ? "" : content(part)).join(" ")
    : node.text + " " + node.children.filter((child) => !["script", "style"].includes(child.tag)).map(content).join(" ");
}
function parseHtml(body: string): HtmlNode {
  let count = 0;
  const convert = (entries: Record<string, unknown>[], depth: number): HtmlNode[] => {
    if (depth > 80) throw new Error("itch.io 页面嵌套过深");
    return entries.flatMap((entry) => Object.entries(entry).filter(([tag]) => ![":@", "#text"].includes(tag) && !tag.startsWith("?") && !tag.startsWith("!")).map(([tag, children]) => {
      if (++count > 30_000) throw new Error("itch.io 页面节点过多");
      const values = Array.isArray(children) ? children as Record<string, unknown>[] : [];
      const order: Array<string | HtmlNode> = values.flatMap((value): Array<string | HtmlNode> => typeof value["#text"] === "string" ? [value["#text"]] : convert([value], depth + 1));
      return { tag: tag.toLowerCase(), attributes: (entry[":@"] ?? {}) as Record<string, string>,
        text: order.filter((item): item is string => typeof item === "string").join(""), children: order.filter((item): item is HtmlNode => typeof item !== "string"), order };
    }));
  };
  try { return { tag: "root", attributes: {}, text: "", children: convert(htmlParser.parse(body), 0) }; }
  catch { throw new Error("itch.io 页面格式无效或过大，请在原站确认"); }
}
function csrfFrom(root: HtmlNode): string {
  const token = all(root).find((node) => node.tag === "meta" && node.attributes.name === "csrf_token")?.attributes.value;
  if (!token || token.length > 4_096 || /[\s\x00-\x1f]/.test(token)) throw new Error("itch.io 缺少源站签发的匿名表单，请重新读取原站");
  return token;
}
function safeDownloadPage(value: string, page: string): string | undefined {
  try {
    const url = new URL(value);
    const prefix = page + "/download/";
    const key = value.slice(prefix.length);
    return url.origin + url.pathname === value && value.startsWith(prefix) && key.length <= 512
      && !/%(?![a-f\d]{2})/i.test(key) && /^[\w.+/=-]{1,512}$/.test(decodeURIComponent(key)) ? value : undefined;
  } catch { return; }
}
function readLanguages(root: HtmlNode): string[] {
  return [...new Set(all(root).filter((node) => node.tag === "a").flatMap((node) => {
    const match = /^https:\/\/itch\.io\/games\/lang-([\w-]+)\/?$/.exec(node.attributes.href ?? "");
    if (!match) return [];
    const code = match[1].toLowerCase();
    return [code === "zh_hans" ? "zh-Hans" : code === "zh_hant" ? "zh-Hant" : code];
  }))];
}
function readUploads(root: HtmlNode, entry: CatalogueEntry): Upload[] {
  const items = new Map<string, Upload>();
  for (const card of all(root).filter((node) => hasClass(node, "upload"))) {
    const nodes = all(card);
    const button = nodes.find((node) => node.tag === "a" && hasClass(node, "download_btn") && /^[1-9]\d{0,17}$/.test(node.attributes["data-upload_id"] ?? ""));
    const named = nodes.find((node) => hasClass(node, "name"));
    const name = (named?.attributes.title || (named ? content(named) : "")).trim();
    if (!button || !name || name.length > 500 || !entry.filePattern.test(name)
      || /\bdemo\b|\btrial\b|\bpatch\b|goodies|soundtrack|artbook|art\s*collection|supporter|试玩|补丁|画集/i.test(name)) continue;
    const classes = nodes.map((node) => node.attributes.class ?? "").join(" ");
    const platforms = [/(?:^|\s)icon-windows8(?:\s|$)/.test(classes) ? "win" : "", /(?:^|\s)icon-tux(?:\s|$)/.test(classes) ? "lin" : "",
      /(?:^|\s)icon-apple(?:\s|$)/.test(classes) ? "mac" : "", /(?:^|\s)icon-android(?:\s|$)/.test(classes) ? "and" : ""].filter(Boolean);
    if (!platforms.length) continue;
    const format = name.match(/\.(zip|apk)$/i)?.[1].toLowerCase() ?? entry.labelArchive;
    if (!format) continue;
    const size = nodes.find((node) => hasClass(node, "file_size"));
    const sizeLabel = size ? content(size).replace(/\s+/g, " ").trim() : undefined;
    const versionText = content(card).match(/\bVersion\s+(\d+(?:\.\d+)*(?:[-\w.]*)?)/i)?.[1] ?? name.match(/\(v(\d+(?:\.\d+)*)\)/i)?.[1];
    items.set(button.attributes["data-upload_id"], { id: button.attributes["data-upload_id"], name, platforms, format,
      ...(sizeLabel && /^\d+(?:\.\d+)?\s*[KMGT]?I?B$/i.test(sizeLabel) ? { sizeLabel } : {}), ...(versionText ? { version: versionText } : {}) });
    if (items.size >= 20) break;
  }
  return [...items.values()].sort((a, b) => Number(b.platforms.includes("win")) - Number(a.platforms.includes("win")));
}
function friendlyFilename(game: GamePage, upload: Upload): string {
  const chinese = game.languages.some((lang) => lang.startsWith("zh"));
  const language = chinese ? game.languages.includes("zh-Hans") && game.languages.includes("zh-Hant") ? "简繁中文" : game.languages.includes("zh-Hant") ? "繁体中文" : "中文" : game.languages.includes("en") ? "英文" : "语言待确认";
  return sanitizeFileName(`${game.title} - ${language} - ${upload.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join("-")}${upload.version ? ` - v${upload.version}` : ""}.${upload.format}`);
}
function safeCoverUrl(value?: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value); return url.protocol === "https:" && ["img.itch.zone", "img.itch.io"].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : undefined; } catch { return; }
}
function safeCdnUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return;
    const host = url.hostname.toLowerCase();
    return /^(?:itchio-mirror\.)[a-z0-9]+\.r2\.cloudflarestorage\.com$/.test(host)
      || host === "w3g3a5v6.ssl.hwcdn.net" || host.endsWith(".hwcdn.net") || host === "cdn.itch.io"
      ? url.href : undefined;
  } catch { return; }
}
