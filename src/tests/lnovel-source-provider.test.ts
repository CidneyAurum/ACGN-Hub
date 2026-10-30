import { describe, expect, it } from "vitest";
import { LNovelSourceProvider } from "@/infrastructure/sources/lnovel-source-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

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
});
