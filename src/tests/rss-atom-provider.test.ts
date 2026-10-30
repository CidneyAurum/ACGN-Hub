import { describe, expect, it, vi, type MockedFunction } from "vitest";
import type { TextFetcher } from "@/application/feed-ports";
import { FeedProviderError, RssAtomProvider, parseFeedXml } from "@/infrastructure/feeds/rss-atom-provider";
import { RssSourceProvider, toResource } from "@/infrastructure/feeds/rss-source-provider";
import type { FeedItem } from "@/domain/feed";
import { atomFixture, rssFixture } from "@/tests/fixtures/feeds";

function response(status: number, body: string) {
  return { status, text: async () => body };
}

function fetcher(...responses: Array<ReturnType<typeof response>>): MockedFunction<TextFetcher> {
  const mock = vi.fn() as MockedFunction<TextFetcher>;
  for (const item of responses) mock.mockResolvedValueOnce(item);
  return mock;
}

describe("RSS/Atom provider", () => {
  it("parses RSS 2.0 items and enclosures", () => {
    const feed = parseFeedXml(rssFixture, "https://example.com/feed.xml");

    expect(feed).toMatchObject({ format: "rss2", title: "ACGN Updates", url: "https://example.com/updates" });
    expect(feed.items[0]).toMatchObject({
      title: "Episode 01",
      author: "ACGN Team",
      categories: ["Anime", "1080p"],
      enclosure: {
        url: "https://downloads.example.com/episode-01.mkv",
        type: "video/x-matroska",
        length: 2048,
      },
    });
  });

  it("accepts private enclosure URLs", () => {
    const unsafe = rssFixture.replace("https://downloads.example.com/episode-01.mkv", "http://127.0.0.1:1420/episode-01.mkv");

    expect(parseFeedXml(unsafe).items[0].enclosure?.url).toBe("http://127.0.0.1:1420/episode-01.mkv");
  });

  it("parses Atom alternate links and enclosures", () => {
    const feed = parseFeedXml(atomFixture, "https://example.com/atom.xml");

    expect(feed).toMatchObject({ format: "atom", title: "Visual Novel Releases" });
    expect(feed.items[0]).toMatchObject({
      title: "Release 01",
      url: "https://example.com/release-01",
      author: "VN Team",
      categories: ["visual-novel"],
      enclosure: { url: "https://downloads.example.com/release-01.zip", length: 4096 },
    });
  });

  it("caches feed reads and accepts private URLs", async () => {
    const request = fetcher(response(200, rssFixture), response(200, rssFixture));
    const provider = new RssAtomProvider({ fetcher: request, minIntervalMs: 0, sleep: async () => {} });

    await provider.read("https://example.com/feed.xml");
    await provider.read("https://example.com/feed.xml");

    expect(request).toHaveBeenCalledTimes(1);
    await expect(provider.read("http://127.0.0.1:1420/feed.xml")).resolves.toMatchObject({ sourceUrl: "http://127.0.0.1:1420/feed.xml" });
  });

  it("retries rate-limited feeds", async () => {
    const request = fetcher(response(429, ""), response(200, atomFixture));
    const provider = new RssAtomProvider({ fetcher: request, minIntervalMs: 0, maxRetries: 1, sleep: async () => {} });

    await expect(provider.read("https://example.com/atom.xml")).resolves.toMatchObject({ format: "atom" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported XML", () => {
    expect(() => parseFeedXml("<html><body>not a feed</body></html>")).toThrowError(FeedProviderError);
    expect(() => parseFeedXml("<html><body>not a feed</body></html>")).toThrow(/不支持的 Feed 格式/);
  });

  it("exposes RSS items through the SourceProvider contract", async () => {
    const source = new RssSourceProvider("https://example.com/feed.xml", {
      id: "fixture-feed",
      read: async () => parseFeedXml(rssFixture, "https://example.com/feed.xml"),
    });

    const results = await source.search({ keyword: "Episode", aliases: [], mediaType: "anime" });
    const resources = await source.listResources(results[0].sourceItemId);

    expect(results[0]).toMatchObject({ sourceId: "rss:https://example.com/feed.xml", title: "Episode 01" });
    expect(resources[0]).toMatchObject({ protocol: "http", sizeBytes: 2048 });
    await expect(source.resolve(resources[0].id)).resolves.toMatchObject({ url: "https://downloads.example.com/episode-01.mkv" });
  });

  it("searches Mikan's HTML catalog and exposes torrent and magnet resources", async () => {
    const html = `
      <table><tr class="js-search-results-row">
        <input data-magnet="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;tr=udp%3A%2F%2Ftracker.example%2Fannounce" />
        <a class="magnet-link-wrap">&#x8FDB;&#x51FB;&#x7684;&#x5DE8;&#x4EBA; [&#x7B80;&#x4F53;]</a>
        <td>1.2GB</td><td>2026/08/11 18:47</td>
        <a href="/Download/20260811/abc.torrent">download</a>
      </tr></table>`;
    const textFetcher: TextFetcher = async () => response(200, html);
    const source = new RssSourceProvider(
      "https://mikanani.me/RSS/Bangumi?bangumiId=1",
      { id: "fixture-feed", read: async () => parseFeedXml(rssFixture) },
      textFetcher,
    );

    const results = await source.search({ keyword: "进击的巨人", aliases: [], mediaType: "anime" });
    const resources = await source.listResources(results[0].sourceItemId);

    expect(results[0].title).toContain("进击的巨人");
    expect(resources.map((item) => item.protocol)).toEqual(["torrent", "magnet"]);
    expect(resources[0].targetUrl).toBe("https://mikanani.me/Download/20260811/abc.torrent");
    expect(resources[1].targetUrl).toContain("tr=udp%3A%2F%2Ftracker.example%2Fannounce");
  });

  it("uses AcgnX keyword RSS and derives a downloadable magnet resource", async () => {
    const read = vi.fn(async (url: string) => parseFeedXml(
      rssFixture.replace("https://downloads.example.com/episode-01.mkv", "https://share.acgnx.se/show-0123456789abcdef0123456789abcdef01234567.html")
        .replace("Episode 01", "进击的巨人 01")
        .replace(/\s*<enclosure[^>]*\/>/, "")
        .replace("<description><![CDATA[Episode description]]></description>", "<description><![CDATA[0123456789abcdef0123456789abcdef01234567]]></description>"),
      url,
    ));
    const source = new RssSourceProvider("https://share.acgnx.se/rss.xml", { id: "fixture-feed", read });

    const results = await source.search({ keyword: "进击的巨人", aliases: [], mediaType: "anime" });
    const resources = await source.listResources(results[0].sourceItemId);

    expect(read).toHaveBeenCalledWith("https://share.acgnx.se/rss.xml?keyword=%E8%BF%9B%E5%87%BB%E7%9A%84%E5%B7%A8%E4%BA%BA");
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ protocol: "magnet", targetUrl: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" });
  });

  it("keeps torrent and magnet enclosures while rejecting malformed XML", () => {
    const torrent = rssFixture.replace("https://downloads.example.com/episode-01.mkv", "https://example.com/episode.torrent");
    expect(parseFeedXml(torrent).items[0].enclosure?.url).toBe("https://example.com/episode.torrent");
    const magnet = rssFixture.replace("https://downloads.example.com/episode-01.mkv", "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567");
    expect(parseFeedXml(magnet).items[0].enclosure?.url).toContain("magnet:");
    expect(() => parseFeedXml("<rss><channel><title>broken</channel></rss>")).toThrow("XML 格式无效");
  });

  it.each([["394.3MB", 394_300_000], ["413.49 MiB", Math.round(413.49 * 1024 ** 2)], ["1.2GB", 1_200_000_000], ["2 GiB", 2 * 1024 ** 3]])
    ("reads AcgnX's explicit %s payload size instead of its one-byte magnet placeholder", (label, expected) => {
      const magnet = "magnet:?xt=urn:btih:f8596eb21dbe24702cb372294f0281229861d83a";
      const xml = `<rss version="2.0"><channel><title>AcgnX</title><item><title><![CDATA[[北宇治字幕组] 学生会也有洞！ [02][1080p]]]></title><link>https://share.acgnx.se/show-f8596eb21dbe24702cb372294f0281229861d83a.html</link><description><![CDATA[<a href="https://share.acgnx.se/show-f8596eb21dbe24702cb372294f0281229861d83a.html">北宇治字幕组 | 学生会也有洞！ [02][1080p]</a> | ${label} | 動畫 | <a href="${magnet}">f8596eb21dbe24702cb372294f0281229861d83a</a>]]></description><enclosure url="${magnet}" length="1" type="application/x-bittorrent" /></item></channel></rss>`;
      const feed = parseFeedXml(xml, "https://share.acgnx.se/rss.xml?keyword=学生会");
      const resource = toResource("rss:acgnx", feed.items[0], { protocol: "magnet", url: magnet });
      expect(resource.sizeBytes).toBe(expected);
      expect(resource.protocol).toBe("magnet");
    });

  it("does not invent AcgnX sizes from titles, episode or resolution numbers, and preserves other feeds' byte counts", () => {
    const target = { protocol: "magnet" as const, url: "magnet:?xt=urn:btih:f8596eb21dbe24702cb372294f0281229861d83a" };
    const item: FeedItem = { id: "sample", title: "1.2GB", sourceUrl: "https://share.acgnx.se/rss.xml", description: '<a href="https://example.test">学生会 [02] [1080p] [1.2GB]</a> | 02 | 1080p | 動畫', categories: [], enclosure: { url: target.url, length: 1 }, metadata: {} };
    expect(toResource("acgnx", item, target).sizeBytes).toBeUndefined();
    expect(toResource("acgnx", { ...item, description: "1.2GB" }, target).sizeBytes).toBeUndefined();
    expect(toResource("acgnx", { ...item, enclosure: { url: target.url, length: 2048 } }, target).sizeBytes).toBe(2048);
    expect(toResource("mikan", { ...item, sourceUrl: "https://mikanani.me/RSS/Search", description: "394.3MB" }, target).sizeBytes).toBe(1);
    expect(toResource("generic", { ...item, sourceUrl: "https://example.test/feed" }, target).sizeBytes).toBe(1);
  });
});
