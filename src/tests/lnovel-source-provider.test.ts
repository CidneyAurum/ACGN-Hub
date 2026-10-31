import { beforeEach, describe, expect, it, vi } from "vitest";
import { LNovelSourceProvider } from "@/infrastructure/sources/lnovel-source-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { novelHtmlToText } from "@/infrastructure/sources/novel-text";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args: Record<string, unknown>) => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/shared/runtime", () => ({ isTauriRuntime: () => true }));
beforeEach(() => invoke.mockClear());

function response(body: unknown): { status: number; json: () => Promise<unknown> } {
  return { status: 200, json: async () => body };
}

describe("LNovelSourceProvider", () => {
  it("shares and caches a slow catalogue request across provider instances", async () => {
    let calls = 0;
    let timeout: number | undefined;
    const fetcher: JsonFetcher = async (_url, init) => {
      calls += 1;
      timeout = init.timeoutMs;
      return response({ ok: true, data: [{ nid: 7, name: "测试轻小说" }] });
    };
    const first = new LNovelSourceProvider("https://cached.example", { fetcher });
    const second = new LNovelSourceProvider("https://cached.example", { fetcher });
    const query = { keyword: "测试", aliases: [], mediaType: "novel" as const };
    await Promise.all([first.search(query), second.search(query)]);
    await second.search(query);
    expect(calls).toBe(1);
    expect(timeout).toBe(35_000);
  });

  it("looks up an explicit LNovel ID or supported novel URL without loading the catalogue", async () => {
    const urls: string[] = [];
    const fetcher: JsonFetcher = async (url) => { urls.push(url); return response({ ok: true, data: { nid: 7, name: "测试轻小说", volumes: [] } }); };
    const provider = new LNovelSourceProvider("https://direct.example", { fetcher });
    const query = { aliases: [], mediaType: "novel" as const };
    await expect(provider.search({ ...query, keyword: "7" })).resolves.toMatchObject([{ sourceItemId: "7" }]);
    await expect(provider.search({ ...query, keyword: "https://www.linovelib.com/novel/7.html" })).resolves.toMatchObject([{ title: "测试轻小说" }]);
    expect(urls).toEqual(["https://direct.example/api/bili/novel/7"]);
  });

  it("does not generate an empty TXT when a volume has no chapters", async () => {
    const fetcher: JsonFetcher = async (url) => url.endsWith("/vol/70")
      ? response({ ok: true, data: { nid: 7, vid: 70, name: "空卷", chapters: [] } })
      : response({ ok: true, data: { nid: 7, name: "测试小说", volumes: [] } });
    const provider = new LNovelSourceProvider("https://lnovel.example", { fetcher });
    await expect(provider.prepareNovelDownload("lnovel:https://lnovel.example:7:70")).rejects.toThrow("没有可下载章节");
  });

  it("searches the Chinese catalogue and exposes volume TXT resources", async () => {
    const requested: string[] = [];
    const fetcher: JsonFetcher = async (url) => {
      requested.push(url);
      if (url.endsWith("/bili/novels")) return response({ ok: true, data: [{ nid: 7, name: "测试轻小说", description: "中文作品", labels: ["日本轻小说"] }] });
      if (url.endsWith("/bili/novel/7")) return response({ ok: true, data: { nid: 7, name: "测试轻小说", volumes: [{ nid: 7, vid: 70, title: "测试轻小说 1" }] } });
      if (url.endsWith("/bili/novel/7/vol/70")) return response({ ok: true, data: { nid: 7, vid: 70, name: "测试轻小说 1", chapters: [{ nid: 7, vid: 70, cid: 700, title: "第一章" }] } });
      return response({ ok: true, data: { cid: 700, title: "第一章", content: "<p>正文</p>" } });
    };
    const provider = new LNovelSourceProvider("https://lnovel.example", { fetcher });
    const matches = await provider.search({ keyword: "测试轻小说", aliases: [], mediaType: "novel" });
    const resources = await provider.listResources(matches[0].sourceItemId);

    expect(matches[0].title).toBe("测试轻小说");
    expect(resources).toHaveLength(1);
    expect(resources[0].format).toBe("TXT");
    expect(resources[0].metadata.downloadMode).toBe("novel_txt");
    expect(requested[0]).toBe("https://lnovel.example/api/bili/novels");
    expect(resources[0].targetUrl).toBe("https://lnovel.example/api/bili/novel/7/vol/70");
  });

  it("rebuilds a stored volume resource after the app restarts", async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.endsWith("/bili/novel/7")) return response({ ok: true, data: { nid: 7, name: "测试轻小说", volumes: [{ nid: 7, vid: 70, title: "测试轻小说 1" }] } });
      return response({ ok: true, data: { nid: 7, vid: 70, name: "测试轻小说 1", chapters: [{ nid: 7, vid: 70, cid: 700, title: "第一章" }] } });
    };
    const provider = new LNovelSourceProvider("https://lnovel.example", { fetcher });
    await expect(provider.prepareNovelDownload("lnovel:https://lnovel.example:7:70")).resolves.toEqual({
      title: "测试轻小说",
      volume: "测试轻小说 1",
      chapterCount: 1,
    });
  });

  it("matches author credits exactly and keeps two-character Chinese title searches usable", async () => {
    const fetcher: JsonFetcher = async () => response({ ok: true, data: [
      { nid: 7, name: "我的测试轻小说", authors: [{ name: "入間人間", position: "author" }, { name: "插画作者", position: "illustrator" }] },
      { nid: 8, name: "另一本书", description: "提到入间人间的简介", authors: [{ name: "其它作者", position: "author" }] },
    ] });
    const source = new LNovelSourceProvider("https://authors.example", { fetcher });
    expect(await source.search({ keyword: "入间人间", aliases: [], mediaType: "novel" })).toMatchObject([{ title: "我的测试轻小说", raw: { authors: ["入間人間"] } }]);
    expect(await source.search({ keyword: "入间人", aliases: [], mediaType: "novel" })).toEqual([]);
    expect(await source.search({ keyword: "插画作者", aliases: [], mediaType: "novel" })).toEqual([]);
    expect(await source.search({ keyword: "测试", aliases: [], mediaType: "novel" })).toHaveLength(1);
  });

  it("downloads image-only chapter placeholders without aborting the volume or losing escaped prose", async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.endsWith("/chapter/701")) return response({ ok: true, data: { nid: 7, vid: 70, cid: 701, title: "插图", content: "", images: [{ src: "https://images.example/one.jpg" }] } });
      if (url.endsWith("/chapter/702")) return response({ ok: true, data: { nid: 7, vid: 70, cid: 702, title: "序章", content: "<p>正文 &lt;请保留&gt; &#x4e2d;&#25991;</p>" } });
      if (url.endsWith("/vol/70")) return response({ ok: true, data: { nid: 7, vid: 70, name: "第一卷", chapters: [{ nid: 7, vid: 70, cid: 701, title: "插图" }, { nid: 7, vid: 70, cid: 702, title: "序章" }] } });
      return response({ ok: true, data: { nid: 7, name: "测试小说", volumes: [] } });
    };
    const source = new LNovelSourceProvider("https://chapters.example", { fetcher });
    const result = await source.downloadNovel("lnovel:https://chapters.example:7:70", { incomingRoot: "D:\\Incoming", outputRoot: "D:\\Library", outputPath: "D:\\Library\\第一卷.txt" });
    expect(result.chapterCount).toBe(2);
    const content = invoke.mock.calls[0][1].content;
    expect(content).toContain("[本章为图片，TXT 版本不含插图]");
    expect(content).toContain("正文 <请保留> 中文");
  });

  it("refuses a wrong chapter identity and leaves no apparently completed text file", async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.endsWith("/chapter/701")) return response({ ok: true, data: { nid: 8, vid: 70, cid: 701, title: "错书", content: "不属于该书" } });
      if (url.endsWith("/vol/70")) return response({ ok: true, data: { nid: 7, vid: 70, name: "第一卷", chapters: [{ nid: 7, vid: 70, cid: 701, title: "序章" }] } });
      return response({ ok: true, data: { nid: 7, name: "测试小说", volumes: [] } });
    };
    await expect(new LNovelSourceProvider("https://identity.example", { fetcher }).downloadNovel("lnovel:https://identity.example:7:70", { incomingRoot: "D:\\Incoming", outputRoot: "D:\\Library", outputPath: "D:\\Library\\第一卷.txt" })).rejects.toThrow("其它作品");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps literal escaped markup, strips active blocks and bounds malformed numeric entities", () => {
    expect(novelHtmlToText("<p>&lt;hello&gt; &#x1f338; &#999999999999; &amp;lt; text</p><script>bad()</script>"))
      .toBe("<hello> 🌸 &#999999999999; &lt; text");
  });

  it("finds an uncached original from the live indices when the chapter cache contains only its spin-off", async () => {
    const urls: string[] = [];
    const original = { nid: 2013, title: "无职转生 ～到了异世界就拿出真本事～", author: "理不尽な孙の手", latestChapter: "纪念短篇" };
    const fetcher: JsonFetcher = async (url) => {
      urls.push(url);
      return url.endsWith("/bili/novels")
        ? response({ ok: true, data: [{ nid: 4325, name: "无职转生 ～蛇足篇～" }] })
        : response({ ok: true, data: { items: [original] } });
    };
    const source = new LNovelSourceProvider("https://uncached.example", { fetcher });
    const query = { keyword: "无职转生", aliases: [], mediaType: "novel" as const };
    const candidates = await source.search(query);
    expect(candidates.map((candidate) => candidate.sourceItemId)).toEqual(["2013", "4325"]);
    expect(candidates[0].raw).toMatchObject({ authors: ["理不尽な孙の手"], catalogueScope: "popular-index", latestChapter: "纪念短篇" });
    expect(candidates[0].raw?.warnings).toEqual([expect.stringContaining("目录和正文需另行核实")]);
    await new LNovelSourceProvider("https://uncached.example", { fetcher }).search(query);
    expect(urls).toHaveLength(3);
    expect(urls).toEqual(expect.arrayContaining(["https://uncached.example/api/bili/top/monthvisit", "https://uncached.example/api/bili/top/weekvisit"]));
  });

  it("retains a successful supplementary index when another fails and matches formal authors on uncached entries", async () => {
    const fetcher: JsonFetcher = async (url) => url.endsWith("/bili/novels") ? response({ ok: true, data: [] })
      : url.endsWith("/weekvisit") ? { status: 503, json: async () => ({ error: "unavailable" }) }
      : response({ ok: true, data: { items: [{ nid: 600, title: "未缓存的日轻", author: "入間人間" }] } });
    const source = new LNovelSourceProvider("https://index-author.example", { fetcher });
    expect(await source.search({ keyword: "入间人间", aliases: [], mediaType: "novel" })).toMatchObject([{ sourceItemId: "600", raw: { authors: ["入間人間"] } }]);
  });

  it("explains upstream take-down and uncached retrieval failures without showing remote internals", async () => {
    for (const [status, message, expected] of [
      [500, "Failed updating novel chapter to database: This novel 2013 and chapter 72034 has been taken down. upstream secret=fixture-value", "来源已下架此作品或章节"],
      [500, "Scrapeless remote browser is disabled until 2026-10-31T14:08:25.955Z", "无法取得未缓存的目录或正文"],
      [408, "Request timeout after waiting 30 seconds", "无法取得未缓存的目录或正文"],
    ] as const) {
      const fetcher: JsonFetcher = async () => ({ status, json: async () => ({ ok: false, message }) });
      const source = new LNovelSourceProvider(`https://error-${status}-${expected.length}.example`, { fetcher });
      await expect(source.search({ keyword: "2013", aliases: [], mediaType: "novel" })).rejects.toThrow(expected);
      try { await source.search({ keyword: "2013", aliases: [], mediaType: "novel" }); }
      catch (error) { expect(String(error)).not.toMatch(/secret|Scrapeless|database|upstream/); }
    }
  });

  it("classifies a plain-text HTTP 408 response without requiring JSON from an error page", async () => {
    const fetcher: JsonFetcher = async () => ({ status: 408, json: async () => { throw new SyntaxError("Not JSON"); } });
    await expect(new LNovelSourceProvider("https://plain-timeout.example", { fetcher }).search({ keyword: "2013", aliases: [], mediaType: "novel" })).rejects.toThrow("无法取得未缓存的目录或正文");
  });

  it("reports tombstoned works, volumes and chapters as taken down rather than the wrong identity", async () => {
    for (const deleted of ["novel", "volume", "chapter"] as const) {
      const fetcher: JsonFetcher = async (url) => {
        if (url.endsWith("/chapter/701")) return response({ ok: true, data: { nid: 7, vid: 70, cid: 701, title: "序章", content: "正文", isDeleted: deleted === "chapter" } });
        if (url.endsWith("/vol/70")) return response({ ok: true, data: { nid: 7, vid: 70, name: "第一卷", isDeleted: deleted === "volume", chapters: [{ nid: 7, vid: 70, cid: 701, title: "序章" }] } });
        return response({ ok: true, data: { nid: 7, name: "测试小说", isDeleted: deleted === "novel", volumes: [] } });
      };
      const source = new LNovelSourceProvider(`https://deleted-${deleted}.example`, { fetcher });
      await expect(source.downloadNovel(`lnovel:https://deleted-${deleted}.example:7:70`, { incomingRoot: "D:\\Incoming", outputRoot: "D:\\Library", outputPath: "D:\\Library\\第一卷.txt" })).rejects.toThrow("来源已下架");
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
