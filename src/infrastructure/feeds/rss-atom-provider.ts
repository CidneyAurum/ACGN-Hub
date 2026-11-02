import { timeoutSignal, disposeAbortSignal } from "@/shared/abort-signals";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { FeedProvider, TextFetcher } from "@/application/feed-ports";
import type { FeedDocument, FeedEnclosure, FeedItem } from "@/domain/feed";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";
import { MinIntervalLimiter, type Sleep } from "@/infrastructure/metadata/rate-limiter";
import { createTextFetcher } from "./text-transport";
import { parseDownloadTarget } from "@/shared/validation";
import { isTimeoutError } from "@/infrastructure/metadata/response-errors";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

export type FeedErrorCode = "bad_request" | "rate_limited" | "server_error" | "not_found" | "network" | "dns" | "tls" | "connection" | "read" | "invalid_response" | "timeout" | "unauthorized" | "forbidden";

export class FeedProviderError extends Error {
  constructor(readonly code: FeedErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "FeedProviderError";
  }
}

export interface RssAtomProviderOptions {
  fetcher?: TextFetcher;
  cache?: MemoryCache;
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: Sleep;
  timeoutMs?: number;
}

export class RssAtomProvider implements FeedProvider {
  readonly id = "rss-atom";
  private readonly fetcher: TextFetcher;
  private readonly cache: MemoryCache;
  private readonly limiter: MinIntervalLimiter;
  private readonly maxRetries: number;
  private readonly sleep: Sleep;
  private readonly timeoutMs: number;

  constructor(options: RssAtomProviderOptions = {}) {
    this.fetcher = options.fetcher ?? createTextFetcher();
    this.cache = options.cache ?? new MemoryCache();
    this.limiter = new MinIntervalLimiter(options.minIntervalMs ?? 500, Date.now, options.sleep);
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async read(url: string): Promise<FeedDocument> {
    const feedUrl = validateFeedUrl(url);
    const cacheKey = `feed:${feedUrl}`;
    return this.cache.getOrLoad<FeedDocument>(cacheKey, 2 * 60 * 1000, async () => {

      const xml = await this.request(feedUrl);
      const feed = parseFeedXml(xml, feedUrl);
      return feed;
    });
  }

  private async request(url: string): Promise<string> {
    let attempt = 0;
    while (true) {
      await this.limiter.wait();
      const signal = timeoutSignal(this.timeoutMs);
      try {
        const init = {
          method: "GET",
          headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
          signal,
          timeoutMs: this.timeoutMs,
        };
        const response = await abortableRequest(() => this.fetcher(url, init), init.signal);
        if (response.status >= 200 && response.status < 300) return await abortableRequest(() => response.text(), init.signal);
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
          attempt += 1;
          await this.delay(250 * 2 ** (attempt - 1));
          continue;
        }
        throw errorForStatus(response.status);
      } catch (cause) {
        if (cause instanceof FeedProviderError) throw cause;
        if (attempt < this.maxRetries) {
          attempt += 1;
          await this.delay(250 * 2 ** (attempt - 1));
          continue;
        }
        throw feedRequestError(cause);
      } finally { disposeAbortSignal(signal); }
    }
  }

  private async delay(milliseconds: number): Promise<void> {
    await this.sleep(milliseconds);
  }
}

/** Classify transport failures without putting URLs, tokens or raw response text in the UI. */
export function feedRequestError(cause: unknown): FeedProviderError {
  if (cause instanceof FeedProviderError) return cause;
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const prefix = message.match(/^\[(NETWORK_[A-Z]+)\]/)?.[1];
  if (prefix === "NETWORK_TIMEOUT" || isTimeoutError(cause)) return new FeedProviderError("timeout", "RSS/Atom 请求超时，请稍后重试");
  if (prefix === "NETWORK_DNS" || /dns error|dns lookup|name resolution|failed to lookup|unable to resolve host|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(message)) {
    return new FeedProviderError("dns", "RSS/Atom 域名解析失败（DNS），请检查当前网络的解析结果");
  }
  if (prefix === "NETWORK_TLS" || /certificate|cert_authority|TLS|SSL|sslhandshake|handshake failure|cert_verify/i.test(message)) {
    return new FeedProviderError("tls", "RSS/Atom HTTPS 证书或握手失败（TLS），请检查系统时间与网络环境");
  }
  if (prefix === "NETWORK_CONNECT" || /connection refused|connect error|connection reset|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ERR_CONNECTION_/i.test(message)) {
    return new FeedProviderError("connection", "RSS/Atom 无法建立网络连接，请检查当前网络是否能访问该站点");
  }
  if (prefix === "NETWORK_READ" || /error decoding response|error reading|body error|response.*(?:read|stream).*fail/i.test(message)) {
    return new FeedProviderError("read", "RSS/Atom 网络响应读取失败，请稍后重试");
  }
  if (cause instanceof TypeError && /fetch|network/i.test(message)) {
    return new FeedProviderError("network", "RSS/Atom 网络请求失败；浏览器未提供 DNS、TLS 或跨域限制的具体原因");
  }
  return new FeedProviderError("network", "RSS/Atom 网络请求失败；未取得可确认的 DNS、TLS 或 HTTP 错误信息");
}

export function parseFeedXml(xml: string, sourceUrl = "fixture://feed"): FeedDocument {
  if (!xml.trim()) throw new FeedProviderError("invalid_response", "Feed 内容为空");
  if (XMLValidator.validate(xml) !== true) throw new FeedProviderError("invalid_response", "Feed XML 格式无效");
  let parsed: Record<string, unknown>;
  try {
    parsed = XML_PARSER.parse(xml) as Record<string, unknown>;
  } catch {
    throw new FeedProviderError("invalid_response", "Feed XML 格式无效");
  }

  if (isRecord(parsed.rss) && isRecord(parsed.rss.channel)) {
    return parseRss(parsed.rss.channel, sourceUrl);
  }
  if (isRecord(parsed.feed)) {
    return parseAtom(parsed.feed, sourceUrl);
  }
  throw new FeedProviderError("invalid_response", "不支持的 Feed 格式，仅支持 RSS 2.0 和 Atom");
}

function parseRss(channel: Record<string, unknown>, sourceUrl: string): FeedDocument {
  const items = asArray(channel.item).filter(isRecord).map((item) => {
    const link = textValue(item.link);
    const guid = textValue(item.guid);
    const description = textValue(item["content:encoded"]) || textValue(item.description);
    const enclosure = parseRssEnclosure(item.enclosure);
    return createItem({
      sourceUrl,
      rawId: guid,
      title: textValue(item.title) || link || "未命名条目",
      url: link,
      publishedAt: normalizeDate(textValue(item.pubDate) || textValue(item["dc:date"])),
      description,
      author: textValue(item.author) || textValue(item["dc:creator"]),
      categories: asArray(item.category).map(textValue).filter(isString),
      enclosure,
      metadata: item,
    });
  });
  return {
    title: textValue(channel.title) || sourceUrl,
    sourceUrl,
    format: "rss2",
    url: textValue(channel.link),
    description: textValue(channel.description),
    items,
    fetchedAt: new Date().toISOString(),
  };
}

function parseAtom(feed: Record<string, unknown>, sourceUrl: string): FeedDocument {
  const items = asArray(feed.entry).filter(isRecord).map((entry) => {
    const links = asArray(entry.link);
    const url = findLink(links, "alternate") || findLink(links);
    const enclosure = parseAtomEnclosure(links);
    const author = isRecord(entry.author) ? textValue(entry.author.name) : textValue(entry.author);
    return createItem({
      sourceUrl,
      rawId: textValue(entry.id),
      title: textValue(entry.title) || url || "未命名条目",
      url,
      publishedAt: normalizeDate(textValue(entry.published)),
      updatedAt: normalizeDate(textValue(entry.updated)),
      description: textValue(entry.content) || textValue(entry.summary),
      author,
      categories: asArray(entry.category)
        .map((category) => (isRecord(category) ? textValue(category["@_term"]) : textValue(category)))
        .filter(isString),
      enclosure,
      metadata: entry,
    });
  });
  return {
    title: textValue(feed.title) || sourceUrl,
    sourceUrl,
    format: "atom",
    url: findLink(asArray(feed.link), "alternate") || findLink(asArray(feed.link)),
    description: textValue(feed.subtitle),
    items,
    fetchedAt: new Date().toISOString(),
  };
}

function parseRssEnclosure(value: unknown): FeedEnclosure | undefined {
  if (!isRecord(value)) return undefined;
  const url = textValue(value["@_url"]);
  if (!url || !isAllowedEnclosureUrl(url)) return undefined;
  const length = Number(textValue(value["@_length"]));
  return {
    url,
    ...(textValue(value["@_type"]) ? { type: textValue(value["@_type"]) } : {}),
    ...(Number.isFinite(length) && length >= 0 ? { length } : {}),
  };
}

function parseAtomEnclosure(links: unknown[]): FeedEnclosure | undefined {
  const link = links.find((value) => isRecord(value) && value["@_rel"] === "enclosure");
  if (!isRecord(link)) return undefined;
  const url = textValue(link["@_href"]);
  if (!url || !isAllowedEnclosureUrl(url)) return undefined;
  const length = Number(textValue(link["@_length"]));
  return {
    url,
    ...(textValue(link["@_type"]) ? { type: textValue(link["@_type"]) } : {}),
    ...(Number.isFinite(length) && length >= 0 ? { length } : {}),
  };
}

function createItem(input: {
  sourceUrl: string;
  rawId?: string;
  title: string;
  url?: string;
  publishedAt?: string;
  updatedAt?: string;
  description?: string;
  author?: string;
  categories: string[];
  enclosure?: FeedEnclosure;
  metadata: Record<string, unknown>;
}): FeedItem {
  const identity = input.rawId || input.url || input.title;
  return {
    id: `${input.sourceUrl}::${identity}`,
    title: input.title,
    sourceUrl: input.sourceUrl,
    ...(input.url ? { url: input.url } : {}),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.author ? { author: input.author } : {}),
    categories: [...new Set(input.categories)],
    ...(input.enclosure ? { enclosure: input.enclosure } : {}),
    metadata: input.metadata,
  };
}

function findLink(values: unknown[], rel?: string): string | undefined {
  const link = values.find((value) => isRecord(value) && (rel === undefined || value["@_rel"] === rel));
  if (isRecord(link)) return textValue(link["@_href"]) || textValue(link);
  return textValue(values.find((value) => typeof value === "string"));
}

function validateFeedUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new FeedProviderError("bad_request", "Feed 地址无效");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new FeedProviderError("bad_request", "Feed 只允许不带认证信息的 HTTP/HTTPS 地址");
  }
  return parsed.toString();
}

function isAllowedEnclosureUrl(rawUrl: string): boolean {
  try {
    parseDownloadTarget(rawUrl);
    return true;
  } catch {
    return false;
  }
}

function errorForStatus(status: number): FeedProviderError {
  if (status === 401) return new FeedProviderError("unauthorized", "Feed 需要认证（HTTP 401）", status);
  if (status === 403) return new FeedProviderError("forbidden", "Feed 拒绝访问（HTTP 403），请检查站点访问限制", status);
  if (status === 400) return new FeedProviderError("bad_request", "Feed 请求参数无效（HTTP 400）", status);
  if (status === 404) return new FeedProviderError("not_found", "Feed 地址不存在（HTTP 404）", status);
  if (status === 429) return new FeedProviderError("rate_limited", "Feed 请求过于频繁（HTTP 429）", status);
  if (status >= 500) return new FeedProviderError("server_error", `Feed 服务暂时不可用（HTTP ${status}）`, status);
  return new FeedProviderError("network", `Feed HTTP ${status}`, status);
}

function asArray(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text || undefined;
  }
  if (isRecord(value)) {
    return textValue(value["#text"] ?? value["#cdata"]);
  }
  return undefined;
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString();
}
