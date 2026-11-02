import { timeoutSignal } from "@/shared/abort-signals";
import type { SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import { parseDownloadTarget } from "@/shared/validation";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import type { FeedDocument, FeedEnclosure, FeedItem } from "@/domain/feed";
import type { FeedProvider } from "@/application/feed-ports";
import { feedRequestError, RssAtomProvider } from "./rss-atom-provider";
import { createTextFetcher } from "./text-transport";
import type { TextFetcher } from "@/application/feed-ports";
import { normalizeSourceTitle, rankSourceCandidates, resourceTitleLabels, seasonNumber, sourceSearchTerms } from "@/infrastructure/sources/source-matching";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";

const mikanSubjectFeedCache = new MemoryCache(128);

export class RssSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "Generic RSS/Atom";
  readonly supportedTypes: MediaType[] = ["anime", "manga", "novel", "visual_novel"];
  private readonly items = new Map<string, FeedItem>();
  private readonly resources = new Map<string, ResourceItem>();
  private readonly mikanSubjects = new Map<string, string[]>();

  constructor(
    private readonly feedUrl: string,
    private readonly feedProvider: FeedProvider = new RssAtomProvider({ timeoutMs: isMikanSource(feedUrl) ? 20_000 : 10_000, maxRetries: isMikanSource(feedUrl) ? 1 : 2 }),
    private readonly textFetcher: TextFetcher = createTextFetcher(),
  ) {
    this.id = `rss:${feedUrl}`;
  }

  async search(query: SourceSearchQuery & { subjectId?: string; episodeCount?: number }): Promise<SourceSearchResult[]> {
    const feed = await this.readSearchFeed(query);
    this.items.clear();
    const terms = [query.keyword, ...query.aliases].map(normalize).filter(Boolean);
    const candidates = feed.items
      .filter((item) => {
        if (!terms.length) return true;
        const haystack = normalize([
          item.title,
          item.description,
          item.author,
          ...item.categories,
          item.url,
        ].filter(Boolean).join(" "));
        return terms.some((term) => matchesSearchText(haystack, term));
      })
      .map((item) => {
        this.items.set(item.id, item);
        return {
          sourceId: this.id,
          sourceItemId: item.id,
          title: item.title,
          ...(item.metadata.coverUrl && typeof item.metadata.coverUrl === "string" ? { coverUrl: item.metadata.coverUrl } : {}),
          raw: item.metadata,
        };
      });
    const ranked = rankSourceCandidates(candidates, query.keyword, query.aliases, 80);
    const expectedSeason = seasonNumber(query.keyword) ?? 1;
    return ranked.sort((left, right) => {
      const leftSeason = seasonNumber(left.candidate.title) ?? 1;
      const rightSeason = seasonNumber(right.candidate.title) ?? 1;
      const leftScore = left.score - (leftSeason !== expectedSeason ? 50 : 0) - (resourceTitleLabels(left.candidate.title, query.keyword, query.episodeCount).warnings.some((warning) => warning.startsWith("集数")) ? 50 : 0);
      const rightScore = right.score - (rightSeason !== expectedSeason ? 50 : 0) - (resourceTitleLabels(right.candidate.title, query.keyword, query.episodeCount).warnings.some((warning) => warning.startsWith("集数")) ? 50 : 0);
      return rightScore - leftScore;
    }).map(({ candidate }) => candidate);
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    let item = this.items.get(sourceItemId);
    if (!item) {
      const storedSource = sourceItemId.split("::")[0];
      if (isMikanSource(storedSource) && new URL(storedSource).pathname === "/Home/Search") {
        const keyword = new URL(storedSource).searchParams.get("searchstr") ?? "";
        item = (await this.readMikanSearch(keyword)).find((candidate) => candidate.id === sourceItemId);
      } else {
        const feed = await this.feedProvider.read(storedSource.startsWith("http") ? storedSource : this.feedUrl);
        item = feed.items.find((candidate) => candidate.id === sourceItemId);
      }
      if (item) this.items.set(item.id, item);
    }
    if (!item) return [];
    const resources = resourceTargetUrls(item).flatMap((targetUrl) => {
      try {
        return [toResource(this.id, item, parseDownloadTarget(targetUrl))];
      } catch {
        return [];
      }
    });
    for (const resource of resources) this.resources.set(resource.id, resource);
    return resources;
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("RSS 资源已过期，请重新刷新来源");
      return parseDownloadTarget(resource.targetUrl);
  }

  async healthCheck(): Promise<{ ok: boolean; checkedAt: string; message?: string }> {
    const checkedAt = new Date().toISOString();
    try {
      const feed = await this.feedProvider.read(this.feedUrl);
      const downloadable = feed.items.filter((item) => {
        return resourceTargetUrls(item).some((targetUrl) => {
          try {
            parseDownloadTarget(targetUrl);
            return true;
          } catch {
            return false;
          }
        });
      }).length;
      if (!downloadable) return { ok: false, checkedAt, message: `Feed 可读取，但没有可下载条目（共 ${feed.items.length} 条）` };
      return { ok: true, checkedAt, message: `Feed 正常，发现 ${downloadable} 个可下载条目` };
    } catch (cause) {
      return { ok: false, checkedAt, message: feedRequestError(cause).message };
    }
  }

  private async readSearchFeed(query: SourceSearchQuery & { subjectId?: string; episodeCount?: number }): Promise<FeedDocument> {
    if (isMikanSource(this.feedUrl)) {
      const cachedFeed = query.subjectId ? mikanSubjectFeedCache.get<string>(query.subjectId) : undefined;
      if (cachedFeed) {
        try { return await this.feedProvider.read(cachedFeed); } catch { /* Retry discovery while keyword search remains usable. */ }
      }
      const keywords = sourceSearchTerms(query.keyword, query.aliases, 3);
      const items: FeedItem[] = [];
      const responses: PromiseSettledResult<FeedItem[]>[] = [];
      for (const keyword of keywords) {
        // RSS/Search is around 100 entries; Home/Search can return several MB
        // and a thousand rows. Use the lightweight public endpoint first.
        try {
          const url = new URL("https://mikanani.me/RSS/Search");
          url.searchParams.set("searchstr", keyword);
          const feed = await this.feedProvider.read(url.toString());
          const matching = feed.items.filter((item) => matchesSearchText(normalize(item.title), normalize(keyword)));
          if (matching.length) {
            if (query.subjectId) {
              const expectedSeason = seasonNumber(query.keyword) ?? 1;
              const ordered = [...matching].sort((left, right) => {
                const penalty = (item: FeedItem) => (seasonNumber(item.title) ?? 1) !== expectedSeason ? 2 :
                  resourceTitleLabels(item.title, query.keyword, query.episodeCount).warnings.some((warning) => warning.startsWith("集数")) ? 1 : 0;
                return penalty(left) - penalty(right);
              });
              const exact = await this.findMikanFeedFromEpisodes(keyword, query.subjectId, ordered.slice(0, 2));
              if (exact) return exact;
            }
            return feed;
          }
        } catch { /* Fall back to the catalog HTML if the RSS endpoint is unavailable. */ }
        try {
          const found = await this.readMikanSearch(keyword);
          if (query.subjectId) {
            const exactFeed = await this.findMikanSubjectFeed(keyword, query.subjectId);
            if (exactFeed) return exactFeed;
          }
          responses.push({ status: "fulfilled", value: found }); items.push(...found); if (found.length) break;
        }
        catch (reason) { responses.push({ status: "rejected", reason }); }
      }
      if (!items.length && responses.some((result) => result.status === "rejected")) {
        const failure = responses.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
        throw failure instanceof Error ? failure : new Error("蜜柑计划搜索失败");
      }
      return mergeFeed(this.feedUrl, "蜜柑计划搜索", items);
    }

    if (isAcgnxSource(this.feedUrl)) {
      const keywords = sourceSearchTerms(query.keyword, query.aliases, 2);
      const responses: PromiseSettledResult<FeedDocument>[] = [];
      for (const keyword of keywords) {
        try { const found = await this.feedProvider.read(this.keywordFeedUrl(keyword)); responses.push({ status: "fulfilled", value: found }); if (found.items.length) break; }
        catch (reason) { responses.push({ status: "rejected", reason }); }
      }
      const feeds = responses.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (!feeds.length && responses.some((result) => result.status === "rejected")) {
        const failure = responses.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
        throw failure instanceof Error ? failure : new Error("末日动漫 RSS 搜索失败");
      }
      return mergeFeed(this.feedUrl, "末日动漫关键词搜索", feeds.flatMap((feed) => feed.items));
    }

    return this.feedProvider.read(this.feedUrl);
  }

  private async findMikanFeedFromEpisodes(keyword: string, subjectId: string, items: FeedItem[]): Promise<FeedDocument | undefined> {
    for (const item of items) {
      if (!item.url || !/^https:\/\/mikanani\.me\/Home\/Episode\//i.test(item.url)) continue;
      try {
        const init = { method: "GET", signal: timeoutSignal(20_000), timeoutMs: 20_000 };
        const response = await this.textFetcher(item.url, init);
        if (response.status < 200 || response.status >= 300) continue;
        const html = await response.text();
        const ids = [...new Set([...html.matchAll(/\/Home\/Bangumi\/(\d+)/gi)].map((match) => match[1]))].slice(0, 2);
        this.mikanSubjects.set(keyword, ids);
        const exact = await this.findMikanSubjectFeed(keyword, subjectId);
        if (exact) return exact;
      } catch { /* The reviewed RSS result remains usable with season warnings. */ }
    }
    return undefined;
  }

  private async readMikanSearch(keyword: string): Promise<FeedItem[]> {
    const url = new URL("https://mikanani.me/Home/Search");
    url.searchParams.set("searchstr", keyword);
    const init = {
      method: "GET",
      headers: { Accept: "text/html, application/xhtml+xml" },
      signal: timeoutSignal(20_000),
      timeoutMs: 20_000,
    };
    const response = await this.textFetcher(url.toString(), init);
    if (response.status < 200 || response.status >= 300) throw new Error(`蜜柑计划搜索 HTTP ${response.status}`);
    const html = await response.text();
    this.mikanSubjects.set(keyword, [...new Set([...html.matchAll(/href=["'](?:https:\/\/mikanani\.me)?\/Home\/Bangumi\/(\d+)["'/?]/gi)].map((match) => match[1]))].slice(0, 4));
    return parseMikanSearchHtml(html, url.toString());
  }

  private async findMikanSubjectFeed(keyword: string, subjectId: string): Promise<FeedDocument | undefined> {
    if (!/^\d+$/.test(subjectId)) return undefined;
    for (const id of this.mikanSubjects.get(keyword) ?? []) {
      try {
        const init = { method: "GET", signal: timeoutSignal(20_000), timeoutMs: 20_000 };
        const response = await this.textFetcher("https://mikanani.me/Home/Bangumi/" + id, init);
        if (response.status < 200 || response.status >= 300) continue;
        const html = await response.text();
        const matches = [...html.matchAll(/(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)/gi)];
        if (!matches.some((match) => match[1] === subjectId)) continue;
        const feedUrl = "https://mikanani.me/RSS/Bangumi?bangumiId=" + id;
        const feed = await this.feedProvider.read(feedUrl);
        mikanSubjectFeedCache.set(subjectId, feedUrl, 24 * 60 * 60 * 1000);
        return feed;
      } catch { /* An index page may fail while keyword RSS still works. */ }
    }
    return undefined;
  }

  private keywordFeedUrl(keyword: string): string {
    const url = new URL(this.feedUrl);
    url.searchParams.set("keyword", keyword);
    return url.toString();
  }
}

export function toResource(sourceId: string, item: FeedItem, target: DownloadTarget): ResourceItem {
  const labels = resourceTitleLabels(item.title);
  const sizeBytes = resourceSizeBytes(item);
  return {
    // A Mikan result can expose both a tracker-rich magnet and a .torrent
    // file. Keep both resources selectable instead of silently discarding
    // the magnet when the enclosure points at the .torrent.
    id: `${sourceId}:${item.id}:${target.protocol}:${target.url}`,
    sourceId,
    sourceItemId: item.id,
    title: item.title,
    protocol: target.protocol,
    targetUrl: target.url,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(labels.resolution ? { resolution: labels.resolution } : {}),
    metadata: { ...item.metadata, ...(labels.seasonLabel ? { seasonLabel: labels.seasonLabel } : {}), matchWarnings: labels.warnings },
    createdAt: new Date().toISOString(),
  };
}

function resourceSizeBytes(item: FeedItem): number | undefined {
  const declared = item.enclosure?.length;
  // AcgnX publishes length="1" on magnet enclosures as a placeholder. It is
  // not the payload size. Preserve real byte counts and all other feed types.
  if (!isAcgnxSource(item.sourceUrl) || (declared !== undefined && declared > 1)) return declared;
  const description = cleanHtml((item.description ?? "").replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " "));
  const title = cleanHtml(item.title);
  for (const field of description.split(/[|｜]/)) {
    const value = field.trim().replace(/^(?:文件大小|大小|size)\s*[:：]\s*/i, "");
    if (value === title) continue;
    const match = value.match(/^(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)$/i);
    if (!match) continue;
    const unit = match[2].toLowerCase();
    const exponent = { k: 1, m: 2, g: 3, t: 4 }[unit[0] as "k" | "m" | "g" | "t"];
    const bytes = Math.round(Number(match[1]) * (unit.includes("i") ? 1024 : 1000) ** exponent);
    if (Number.isSafeInteger(bytes) && bytes > 0) return bytes;
  }
  return undefined;
}

function normalize(value: string): string {
  return normalizeSourceTitle(value);
}

function directDownloadLink(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "magnet:" || /\.(?:torrent|zip|7z|rar|pdf|epub|mobi|mp4|mkv)(?:$|[?#])/i.test(parsed.pathname)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function resourceTargetUrls(item: FeedItem): string[] {
  const candidates: Array<unknown> = [];
  if (isMikanSource(item.sourceUrl)) {
    // Mikan's HTML contains both values. Prefer the .torrent: it carries the
    // complete announce-list and avoids getting stuck in Magnet metadata
    // discovery when an old release has no active DHT peers. Keep the magnet
    // as a fallback for entries without a usable torrent file.
    candidates.push(item.metadata.torrent, item.metadata.magnet);
  }
  candidates.push(item.enclosure?.url, acgnxMagnet(item), directDownloadLink(item.url));
  const seen = new Set<string>();
  return candidates.filter((value): value is string => {
    if (typeof value !== "string" || !value.trim()) return false;
    let key = value;
    try {
      const url = new URL(value);
      if (url.protocol === "magnet:") key = "magnet:" + (url.searchParams.get("xt")?.toLowerCase() ?? value);
    } catch { return false; }
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function acgnxMagnet(item: FeedItem): string | undefined {
  if (!isAcgnxSource(item.sourceUrl)) return undefined;
  const haystack = [item.description, item.url, item.metadata["guid"]].filter(Boolean).join(" ");
  const hash = haystack.match(/\b[a-f0-9]{40}\b/i)?.[0];
  return hash ? `magnet:?xt=urn:btih:${hash}` : undefined;
}

function isMikanSource(value: string): boolean {
  try { return new URL(value).hostname.toLowerCase().endsWith("mikanani.me"); } catch { return false; }
}

function isAcgnxSource(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "share.acgnx.se" || hostname.endsWith(".acgnx.se");
  } catch { return false; }
}

function matchesSearchText(haystack: string, term: string): boolean {
  return haystack.includes(term) || (haystack.length >= 3 && term.includes(haystack));
}

function mergeFeed(sourceUrl: string, title: string, items: FeedItem[]): FeedDocument {
  const unique = [...new Map(items.map((item) => [item.url || item.enclosure?.url || item.id, item])).values()];
  return {
    title,
    sourceUrl,
    format: "rss2",
    items: unique,
    fetchedAt: new Date().toISOString(),
  };
}

function parseMikanSearchHtml(html: string, sourceUrl: string): FeedItem[] {
  const rows = html.match(/<tr\b[^>]*class=["'][^"']*js-search-results-row[^"']*["'][\s\S]*?<\/tr>/gi) ?? [];
  return rows.slice(0, 160).flatMap((row, index) => {
    const magnet = attributeValue(row, "data-magnet");
    const titleMatch = row.match(/class=["'][^"']*magnet-link-wrap[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const title = cleanHtml(titleMatch?.[1] ?? "");
    if (!title) return [];
    const torrentMatch = row.match(/href=["']([^"']+\.torrent(?:\?[^"']*)?)["']/i);
    const torrentUrl = torrentMatch?.[1] ? new URL(decodeHtmlEntities(torrentMatch[1]), sourceUrl).toString() : undefined;
    const magnetUrl = magnet ? decodeHtmlEntities(magnet) : undefined;
    // Preserve the tracker-bearing magnet and the torrent as separate choices.
    const targetUrl = magnetUrl || torrentUrl;
    if (!targetUrl) return [];
    const size = parseHumanSize(cleanHtml(row.match(/<td[^>]*>\s*([\d.]+\s*(?:KB|MB|GB|TB))\s*<\/td>/i)?.[1] ?? ""));
    const dateText = cleanHtml(row.match(/<td[^>]*>\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2})\s*<\/td>/i)?.[1] ?? "");
    const episodePath = row.match(/href=["']([^"']*\/Home\/Episode\/[^"']+)["']/i)?.[1];
    const id = episodePath ? new URL(episodePath, sourceUrl).toString() : `${targetUrl}:${index}`;
    const enclosure: FeedEnclosure = {
      url: targetUrl,
      type: /.torrent(?:$|[?#])/i.test(targetUrl) ? "application/x-bittorrent" : "application/x-magnet",
      ...(size !== undefined ? { length: size } : {}),
    };
    return [{
      id: `${sourceUrl}::${id}`,
      title,
      sourceUrl,
      ...(episodePath ? { url: new URL(episodePath, sourceUrl).toString() } : {}),
      ...(dateText ? { publishedAt: normalizeDateText(dateText) } : {}),
      ...(size !== undefined ? { description: `${size} bytes` } : {}),
      categories: ["动画", "蜜柑计划"],
      enclosure,
      metadata: { source: "Mikan Project", magnet: magnetUrl, torrent: torrentUrl },
    }];
  });
}

function attributeValue(html: string, name: string): string | undefined {
  return html.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
}

function cleanHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)));
}

function parseHumanSize(value: string): number | undefined {
  const match = value.match(/^([\d.]+)\s*(KB|MB|GB|TB)$/i);
  if (!match) return undefined;
  const unit = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2].toUpperCase() as "KB" | "MB" | "GB" | "TB"];
  return Math.round(Number(match[1]) * unit);
}

function normalizeDateText(value: string): string {
  const timestamp = Date.parse(value.replace(/\//g, "-"));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}
