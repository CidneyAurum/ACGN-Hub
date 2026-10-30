import { XMLParser } from "fast-xml-parser";
import type { TextFetcher } from "@/application/feed-ports";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MangaChapterDescriptor } from "@/domain/manga";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createTextFetcher } from "@/infrastructure/feeds/text-transport";
import { MinIntervalLimiter } from "@/infrastructure/metadata/rate-limiter";
import { parseDownloadTarget } from "@/shared/validation";
import { sourceSearchTerms, sourceTitleMatch } from "./source-matching";

interface Options { fetcher?: TextFetcher; timeoutMs?: number; minIntervalMs?: number }
interface HtmlNode { tag: string; attributes: Record<string, string>; children: HtmlNode[]; text: string }
interface Manga { id: string; title: string; coverUrl?: string }
interface ChapterEntry { resource: ResourceItem; chapterId: string }

const ORIGIN = "https://mangabz.com";
const ID = /^[1-9]\d{0,11}$/;
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const sharedLimiters = new WeakMap<TextFetcher, MinIntervalLimiter>();
const htmlParser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", htmlEntities: true,
  unpairedTags: ["img", "input", "meta", "link", "br", "hr", "source", "wbr"],
  stopNodes: ["*.script", "*.style"], trimValues: false, parseTagValue: false,
});

/** Public MangaBZ reader: no login, remote script execution or persisted CDN keys. */
export class MangabzSourceProvider implements SourceProvider {
  readonly id = "mangabz:" + ORIGIN;
  readonly name = "MangaBZ 漫画";
  readonly supportedTypes: MediaType[] = ["manga"];
  private readonly fetcher: TextFetcher;
  private readonly timeoutMs: number;
  private readonly limiter: MinIntervalLimiter;
  private readonly mangas = new Map<string, Manga>();
  private readonly chapters = new Map<string, ChapterEntry>();

  constructor(baseUrl = ORIGIN, options: Options = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || !["mangabz.com", "www.mangabz.com"].includes(parsed.hostname) ||
      parsed.port || parsed.username || parsed.password || !["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash) {
      throw new Error("MangaBZ 地址只支持 https://mangabz.com 或 https://www.mangabz.com");
    }
    this.fetcher = options.fetcher ?? createTextFetcher();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (options.minIntervalMs !== undefined) this.limiter = new MinIntervalLimiter(options.minIntervalMs);
    else {
      let limiter = sharedLimiters.get(this.fetcher);
      if (!limiter) { limiter = new MinIntervalLimiter(200); sharedLimiters.set(this.fetcher, limiter); }
      this.limiter = limiter;
    }
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "manga") return [];
    const terms = sourceSearchTerms(query.keyword, query.aliases, 3);
    if (!terms.length) return [];
    const matches = new Map<string, Manga>();
    let succeeded = false;
    let failure: unknown;
    for (const term of terms) {
      try {
        const url = new URL("/search", ORIGIN);
        url.searchParams.set("title", term);
        url.searchParams.set("page", String(Math.min(20, Math.max(1, Math.trunc(query.page || 1)))));
        const document = parseHtml(await this.request(url.href));
        succeeded = true;
        const list = find(document, (node) => hasClass(node, "mh-list"));
        for (const item of list?.children ?? []) {
          const heading = find(item, (node) => node.tag === "h2");
          const link = find(heading ?? item, (node) => node.tag === "a" && Boolean(node.attributes.href));
          const id = mangaId(link?.attributes.href);
          const title = heading ? content(heading).trim() : "";
          if (!id || !title || sourceTitleMatch(title, terms).score <= 0) continue;
          const image = find(item, (node) => node.tag === "img");
          const cover = image?.attributes["data-src"] || image?.attributes.src;
          const manga: Manga = { id, title, ...(cover && safeImageUrl(cover) ? { coverUrl: safeImageUrl(cover)! } : {}) };
          matches.set(id, manga);
          this.mangas.set(id, manga);
        }
      } catch (cause) { failure = cause; }
      if ([...matches.values()].some((item) => sourceTitleMatch(item.title, terms).score >= 100)) break;
    }
    if (!succeeded && failure) throw failure;
    return [...matches.values()]
      .sort((a, b) => sourceTitleMatch(b.title, terms).score - sourceTitleMatch(a.title, terms).score)
      .slice(0, 12).map((item) => ({ sourceId: this.id, sourceItemId: item.id, title: item.title,
        ...(item.coverUrl ? { coverUrl: item.coverUrl } : {}), raw: { provider: "MangaBZ", language: "zh" } }));
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    requireId(sourceItemId);
    const document = parseHtml(await this.request(`${ORIGIN}/${sourceItemId}bz/`));
    const heading = find(document, (node) => hasClass(node, "detail-info-title"));
    const title = heading?.text.trim() || (heading ? content(heading).trim() : "") || this.mangas.get(sourceItemId)?.title;
    if (!title) throw new Error("MangaBZ 作品详情格式已变化，请在原站确认作品");
    const list = find(document, (node) => node.attributes.id === "chapterlistload");
    if (!list) throw new Error("MangaBZ 当前作品没有可下载图片章节，或章节目录格式已变化");
    const resources = new Map<string, ResourceItem>();
    for (const node of descendants(list).filter((node) => node.tag === "a")) {
      const id = chapterId(node.attributes.href);
      if (!id) continue;
      const label = content(node).replace(/\s+/g, " ").trim();
      const chapterName = label.replace(/[（(]\s*\d+\s*P\s*[）)]/iu, "").trim();
      const pages = Number(label.match(/[（(]\s*(\d+)\s*P\s*[）)]/iu)?.[1]);
      if (!chapterName || !Number.isInteger(pages) || pages < 1 || pages > 2_000) continue;
      const number = Number(chapterName.match(/\d+(?:\.\d+)?/)?.[0]);
      const resource: ResourceItem = {
        id: `mangabz:${sourceItemId}:${id}`, sourceId: this.id, sourceItemId,
        title: `${title} · ${chapterName}`, protocol: "http", targetUrl: `${ORIGIN}/m${id}/`,
        ...(Number.isFinite(number) ? { chapter: number } : {}), language: "zh", format: "CBZ",
        metadata: { provider: "MangaBZ", downloadMode: "manga_cbz", mangaId: sourceItemId, chapterId: id,
          chapterName, seriesTitle: title, pages, translatedLanguage: "zh" }, createdAt: new Date().toISOString(),
      };
      this.chapters.set(resource.id, { resource, chapterId: id });
      resources.set(id, resource);
    }
    if (!resources.size) throw new Error("MangaBZ 当前作品没有可下载图片章节，或章节目录格式已变化");
    return [...resources.values()].sort((a, b) => (a.chapter ?? Number.MAX_SAFE_INTEGER) - (b.chapter ?? Number.MAX_SAFE_INTEGER));
  }

  restoreResource(resource: ResourceItem): void {
    if (resource.sourceId !== this.id || resource.metadata.provider !== "MangaBZ") return;
    const id = metadataString(resource, "chapterId");
    requireId(id);
    requireId(resource.sourceItemId);
    if (chapterId(resource.targetUrl) !== id) throw new Error("已保存的 MangaBZ 章节地址与标识不一致，请重新搜索");
    this.chapters.set(resource.id, { resource, chapterId: id });
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    return parseDownloadTarget(this.entry(resourceId).resource.targetUrl);
  }

  async prepareMangaDownload(resourceId: string): Promise<MangaChapterDescriptor> {
    const { resource, chapterId: id } = this.entry(resourceId);
    const referer = `${ORIGIN}/m${id}/`;
    const html = await this.request(referer);
    if (/\bisVip\s*=\s*["']True["']/iu.test(html)) throw new Error("MangaBZ 此章节需要原站权限，请在原站确认；应用不会绕过付费或登录限制");
    if (readVariable(html, "MANGABZ_CID") !== Number(id) || readVariable(html, "MANGABZ_MID") !== Number(resource.sourceItemId)) {
      throw new Error("MangaBZ 章节身份不匹配，已停止下载，请刷新来源");
    }
    const total = readVariable(html, "MANGABZ_IMAGE_COUNT");
    if (!Number.isInteger(total) || total < 1 || total > 2_000) throw new Error("MangaBZ 图片页数无效，无法准备完整章节");
    const imageUrls: string[] = [];
    while (imageUrls.length < total) {
      const page = imageUrls.length + 1;
      const url = `${referer}chapterimage.ashx?cid=${id}&page=${page}`;
      const batch = decodeImageBatch(await this.request(url, referer), id);
      if (!batch.length) throw new Error(`MangaBZ 第 ${page} 页未返回图片，章节准备未完成`);
      imageUrls.push(...batch.slice(0, total - imageUrls.length));
    }
    if (new Set(imageUrls).size !== total) throw new Error("MangaBZ 返回了重复图片，已停止生成不完整章节");
    return { imageUrls, title: metadataString(resource, "seriesTitle") || "MangaBZ",
      chapter: metadataString(resource, "chapterName") || "章节", referer };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const document = parseHtml(await this.request(`${ORIGIN}/manga-list-p1/`));
      if (!find(document, (node) => hasClass(node, "mh-list"))) throw new Error("MangaBZ 目录响应格式无效");
      return { ok: true, checkedAt, message: "公开目录可访问；章节图片将在下载时重新核实" };
    } catch (cause) { return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "MangaBZ 不可用" }; }
  }

  private entry(resourceId: string): ChapterEntry {
    const entry = this.chapters.get(resourceId);
    if (!entry) throw new Error("MangaBZ 章节记录已过期，请重新搜索或刷新来源");
    return entry;
  }

  private async request(url: string, referer = ORIGIN + "/"): Promise<string> {
    await this.limiter.wait();
    const response = await this.fetcher(url, { method: "GET", headers: { Accept: "text/html,application/javascript;q=0.9,*/*;q=0.5", Referer: referer, "User-Agent": AGENT }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (response.status < 200 || response.status >= 300) throw new Error(`MangaBZ HTTP ${response.status}，请稍后重试或在原站确认访问状态`);
    const body = await response.text();
    if (body.length > 4_000_000) throw new Error("MangaBZ 响应过大，已停止解析");
    if (/<(?:title|h1)[^>]*>[^<]*(?:Just a moment|Access Denied|Forbidden|人机验证|人機驗證|验证码|驗證碼)/iu.test(body) || /class\s*=\s*["'][^"']*captcha-container/iu.test(body)) {
      throw new Error("MangaBZ 要求人机验证或限制访问，请在原站处理后重试；应用不会绕过验证");
    }
    return body;
  }
}

function requireId(value: string): void { if (!ID.test(value)) throw new Error("MangaBZ 作品或章节 ID 无效"); }
function sitePath(value: string | undefined): string | undefined {
  if (!value) return;
  try { const url = new URL(value, ORIGIN); return url.protocol === "https:" && ["mangabz.com", "www.mangabz.com"].includes(url.hostname) && !url.port && !url.username && !url.password && !url.search && !url.hash ? url.pathname : undefined; } catch { return; }
}
function mangaId(value: string | undefined): string | undefined { return sitePath(value)?.match(/^\/([1-9]\d{0,11})bz\/$/)?.[1]; }
function chapterId(value: string | undefined): string | undefined { return sitePath(value)?.match(/^\/m([1-9]\d{0,11})\/$/)?.[1]; }
function safeImageUrl(value: string): string | undefined {
  try { const url = new URL(value, ORIGIN); return url.protocol === "https:" && (url.hostname === "mangabz.com" || url.hostname.endsWith(".mangabz.com")) && !url.username && !url.password && !url.port ? url.href : undefined; } catch { return; }
}
function metadataString(resource: ResourceItem, key: string): string { const value = resource.metadata[key]; return typeof value === "string" ? value.trim() : ""; }
function readVariable(body: string, name: string): number { return Number(body.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)\\s*;`))?.[1]); }
function hasClass(node: HtmlNode, name: string): boolean { return (node.attributes.class || "").split(/\s+/).includes(name); }
function descendants(node: HtmlNode): HtmlNode[] { return node.children.flatMap((child) => [child, ...descendants(child)]); }
function find(node: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode | undefined { if (predicate(node)) return node; for (const child of node.children) { const result = find(child, predicate); if (result) return result; } return; }
function content(node: HtmlNode): string { return node.text + node.children.map(content).join(" "); }
function parseHtml(body: string): HtmlNode {
  const convert = (entries: Record<string, unknown>[], depth = 0): HtmlNode[] => {
    if (depth > 100) throw new Error("MangaBZ 页面嵌套过深");
    return entries.flatMap((entry) => Object.entries(entry).filter(([tag]) => tag !== ":@" && tag !== "#text" && !tag.startsWith("?") && !tag.startsWith("!")).map(([tag, children]) => {
      const values = Array.isArray(children) ? children as Record<string, unknown>[] : [];
      const text = values.filter((item) => typeof item["#text"] === "string").map((item) => item["#text"]).join("");
      const attributes = entry[":@"] as Record<string, string> | undefined;
      return { tag: tag.toLowerCase(), attributes: attributes || {}, text, children: convert(values, depth + 1) };
    }));
  };
  try { return { tag: "root", attributes: {}, text: "", children: convert(htmlParser.parse(body)) }; }
  catch { throw new Error("MangaBZ 页面格式无效，无法读取作品或章节目录"); }
}

function decodeLiteral(value: string): string {
  if (value.length > 256_000 || !/^(['"])[\s\S]*\1$/.test(value)) throw new Error("MangaBZ 图片数据字符串无效");
  const quote = value[0];
  let result = "";
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];
    if (char === quote || char === "\n" || char === "\r") throw new Error("MangaBZ 图片数据包含无效字符串");
    if (char !== "\\") { result += char; continue; }
    const next = value[++index];
    if (["\\", "'", '"', "/"].includes(next)) result += next;
    else if (next === "u" && /^[0-9a-f]{4}$/i.test(value.slice(index + 1, index + 5))) { result += String.fromCharCode(parseInt(value.slice(index + 1, index + 5), 16)); index += 4; }
    else throw new Error("MangaBZ 图片数据包含不支持的转义");
  }
  return result;
}

/** Decode string-table substitutions only; the downloaded JavaScript is never executed. */
function decodeImageBatch(script: string, expectedChapterId: string): string[] {
  if (script.length > 256_000) throw new Error("MangaBZ 图片数据过大");
  const packed = script.trim().match(/^eval\(function\([^)]*\)\{[\s\S]*\}\(('(?:[^'\\]|\\.)*'),(\d+),(\d+),('(?:[^'\\]|\\.)*')\.split\('\|'\),0,\{\}\)\)\s*;?$/);
  if (!packed) throw new Error("MangaBZ 图片数据格式已变化，无法安全解析");
  const radix = Number(packed[2]);
  const count = Number(packed[3]);
  const words = decodeLiteral(packed[4]).split("|");
  if (radix < 2 || radix > 62 || count < 1 || count > 5_000 || words.length !== count) throw new Error("MangaBZ 图片字符串表无效");
  let body = decodeLiteral(packed[1]);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const code = (value: number): string => { let result = ""; do { result = alphabet[value % radix] + result; value = Math.floor(value / radix); } while (value); return result; };
  for (let index = count - 1; index >= 0; index--) if (words[index]) {
    body = body.replace(new RegExp("\\b" + code(index) + "\\b", "g"), () => words[index]);
    if (body.length > 512_000) throw new Error("MangaBZ 图片数据解码后过大");
  }
  const prefixLiteral = body.match(/\bvar\s+pix\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*;/)?.[1];
  const pathsLiteral = body.match(/\bvar\s+pvalue\s*=\s*(\[(?:\s*"(?:[^"\\]|\\.)*"\s*,?)*\])\s*;/)?.[1];
  const key = body.match(/\bvar\s+key\s*=\s*['"]([a-f\d]{16,128})['"]\s*;/i)?.[1];
  const cid = readVariable(body, "cid");
  if (!prefixLiteral || !pathsLiteral || !key || cid !== Number(expectedChapterId)) throw new Error("MangaBZ 图片数据缺少有效章节标识或图片列表");
  const prefix = safeImageUrl(decodeLiteral(prefixLiteral));
  if (!prefix || new URL(prefix).search || new URL(prefix).hash || !new URL(prefix).pathname.endsWith("/" + expectedChapterId)) throw new Error("MangaBZ 图片地址不属于当前章节");
  let paths: unknown;
  try { paths = JSON.parse(pathsLiteral); } catch { throw new Error("MangaBZ 图片路径列表无效"); }
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100) throw new Error("MangaBZ 图片批次页数无效");
  return paths.map((path: unknown) => {
    if (typeof path !== "string" || !/^\/[\w-]+\.(?:jpg|jpeg|png|webp)$/i.test(path)) throw new Error("MangaBZ 图片路径无效");
    const url = new URL(prefix + path);
    url.searchParams.set("cid", expectedChapterId); url.searchParams.set("key", key); url.searchParams.set("uk", "");
    return url.href;
  });
}
