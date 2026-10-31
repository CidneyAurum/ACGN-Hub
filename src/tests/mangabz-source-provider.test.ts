import { describe, expect, it, vi } from "vitest";
import type { TextFetcher } from "@/application/feed-ports";
import type { ResourceItem } from "@/domain/resource";
import { MangabzSourceProvider } from "@/infrastructure/sources/mangabz-source-provider";

const searchHtml = `<html><head><title>搜索</title></head><body><ul class="mh-list">
  <li><a href="/7020bz/"><img src="https://image.mangabz.com/covers/7020.jpg"></a><h2><a href="/7020bz/">葬送的芙莉蓮</a></h2></li>
  <li><a href="https://untrusted.example/999bz/"><img src="https://untrusted.example/x.jpg"></a><h2><a href="https://untrusted.example/999bz/">葬送的芙莉蓮</a></h2></li>
  <li><a href="/33bz/"><img src="https://image.mangabz.com/33.jpg"></a><h2><a href="/33bz/">葬送的芙莉蓮 同人合集</a></h2></li>
</ul></body></html>`;
const detailHtml = `<p class="detail-info-title">葬送的芙莉蓮 <span>连载中</span></p><div id="chapterlistload">
  <a class="detail-list-form-item" href="/m117619/">第2話 <span>（2P）</span></a>
  <a class="detail-list-form-item" href="/m117618/">第1話 <span>（39P）</span></a>
  <a class="detail-list-form-item" href="https://untrusted.example/m117617/">第0話 <span>（5P）</span></a>
  <a class="detail-list-form-item" href="/m117616/">预告 <span>（0P）</span></a>
</div>`;
const chapterHtml = `var isVip = "False"; var MANGABZ_MID = 7020; var MANGABZ_CID = 117618; var MANGABZ_IMAGE_COUNT = 39;`;
const response = (body: string, status = 200) => ({ status, text: async () => body });

// A string-table envelope is decoded as data. Even its function body is never run.
function packedBatch(page: number, options: { prefix?: string; id?: string; key?: string; paths?: string[]; wrapper?: string } = {}): string {
  const id = options.id ?? "117618";
  const paths = options.paths ?? [`/${page}_page.jpg`, `/${page + 1}_page.jpg`];
  const body = `function dm5imagefun(){var cid=${id};var key='${options.key ?? "0123456789abcdef0123456789abcdef"}';var pix="${options.prefix ?? "https://image.mangabz.com/8/7020/117618"}";var pvalue=${JSON.stringify(paths)};return pvalue}`;
  const literal = "'" + body.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  return `eval(function(p,a,c,k,e,d){${options.wrapper ?? "return p;"}}(${literal},10,1,''.split('|'),0,{}))`;
}

function savedResource(provider: MangabzSourceProvider): ResourceItem {
  return { id: "saved", sourceId: provider.id, sourceItemId: "7020", title: "葬送的芙莉蓮 · 第1話", protocol: "http",
    targetUrl: "https://mangabz.com/m117618/", createdAt: "2026-01-01",
    metadata: { provider: "MangaBZ", chapterId: "117618", seriesTitle: "葬送的芙莉蓮", chapterName: "第1話", downloadMode: "manga_cbz", pages: 39 } };
}

describe("MangabzSourceProvider", () => {
  it("keeps same-title editions separate and reads authors and true chapter count from their directories", async () => {
    const search = `<ul class="mh-list"><li><h2><a href="/11470bz/">安達與島村</a></h2><p class="chapter"><span>最新</span><a href="/m133933/">第12.5話</a></p></li><li><h2><a href="/11469bz/">安達與島村</a></h2><p class="chapter"><span>完結</span><a href="/m133919/">第18話</a></p></li></ul>`;
    const detail = `<p class="detail-info-title">安達與島村</p><p class="detail-info-tip"><span>作者：<a>入間人間  柚原もけ</a></span><span>狀態：<span>連載中</span></span></p><div id="chapterlistload"><a href="/m133933/">第12.5話 <span>（22P）</span></a><a href="/m514187/">第60話 <span>（22P）</span></a><a href="/m521973/">番外篇2 <span>（17P）</span></a></div>`;
    const requests: string[] = [];
    const provider = new MangabzSourceProvider(undefined, { minIntervalMs: 0, fetcher: async (url) => { requests.push(url); return response(url.includes("/search?") ? search : detail); } });
    const candidates = await provider.search({ keyword: "安达与岛村", aliases: [], mediaType: "manga" });
    expect(candidates.map((item) => item.sourceItemId)).toEqual(["11470", "11469"]);
    expect(candidates[0].raw).toMatchObject({ editionLabel: "MangaBZ 版本 #11470", latestChapter: "第12.5話", status: "最新" });
    const resources = await provider.listResources("11470");
    expect(resources).toHaveLength(3);
    expect(resources.every((item) => item.metadata.chapterCount === 3 && item.metadata.latestChapter === "第60話")).toBe(true);
    expect(resources[0].metadata).toMatchObject({ authors: ["入間人間", "柚原もけ"], editionLabel: "入間人間 / 柚原もけ版" });
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => !url.includes("chapterimage"))).toBe(true);
  });
  it("queues concurrent requests at least 200 ms apart, including providers sharing the same transport", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: number[] = [];
      const fetcher: TextFetcher = async () => { starts.push(Date.now()); return response(searchHtml); };
      const first = new MangabzSourceProvider(undefined, { fetcher });
      const second = new MangabzSourceProvider(undefined, { fetcher });
      const pending = Promise.all([first.healthCheck(), first.healthCheck(), second.healthCheck()]);
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(199);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([0, 200]);
      await vi.advanceTimersByTimeAsync(200);
      expect(starts).toEqual([0, 200, 400]);
      expect((await pending).every((health) => health.ok)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("retains the request interval after a failed transport call without blocking later requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: number[] = [];
      const fetcher: TextFetcher = async () => {
        starts.push(Date.now());
        if (starts.length === 1) throw new Error("temporary network failure");
        return response(searchHtml);
      };
      const provider = new MangabzSourceProvider(undefined, { fetcher });
      const pending = Promise.all([provider.healthCheck(), provider.healthCheck()]);
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(200);
      const results = await pending;
      expect(starts).toEqual([0, 200]);
      expect(results.map((result) => result.ok)).toEqual([false, true]);
    } finally { vi.useRealTimers(); }
  });

  it("accepts only the public HTTPS source and rejects credentials, alternate hosts and paths", () => {
    expect(new MangabzSourceProvider("https://www.mangabz.com").id).toBe("mangabz:https://mangabz.com");
    for (const url of ["http://mangabz.com", "https://mangabz.com.evil.test", "https://localhost", "https://user:pass@mangabz.com", "https://mangabz.com:444", "https://mangabz.com/search", "https://mangabz.com/?q=x"]) {
      expect(() => new MangabzSourceProvider(url)).toThrow("MangaBZ 地址");
    }
  });

  it("parses real-site markup, prefers the exact work and lists stable chapters without requesting page images", async () => {
    const requests: string[] = [];
    const fetcher: TextFetcher = async (url) => { requests.push(url); return response(url.includes("/search?") ? searchHtml : detailHtml); };
    const provider = new MangabzSourceProvider(undefined, { fetcher, minIntervalMs: 0 });
    const matches = await provider.search({ keyword: "葬送的芙莉莲", aliases: [], mediaType: "manga" });
    expect(matches.map((item) => item.sourceItemId)).toEqual(["7020", "33"]);
    expect(matches[0].coverUrl).toBe("https://image.mangabz.com/covers/7020.jpg");
    const chapters = await provider.listResources(matches[0].sourceItemId);
    expect(chapters.map((item) => item.chapter)).toEqual([1, 2]);
    expect(chapters[0]).toMatchObject({ id: "mangabz:7020:117618", language: "zh", format: "CBZ", metadata: { pages: 39, downloadMode: "manga_cbz" } });
    expect(JSON.stringify(chapters)).not.toContain("key=");
    expect(requests).toHaveLength(2);
    await expect(provider.resolve(chapters[0].id)).resolves.toMatchObject({ protocol: "http", url: "https://mangabz.com/m117618/" });
  });

  it("prepares all 39 original page URLs in order and fetches fresh signatures on a restored record", async () => {
    const requestedPages: number[] = [];
    const fetcher: TextFetcher = async (url, init) => {
      expect(new Headers(init?.headers).get("Referer")).toMatch(/^https:\/\/mangabz\.com\//);
      if (!url.includes("chapterimage.ashx")) return response(chapterHtml);
      const page = Number(new URL(url).searchParams.get("page"));
      requestedPages.push(page);
      return response(packedBatch(page));
    };
    const provider = new MangabzSourceProvider(undefined, { fetcher, minIntervalMs: 0 });
    const record = savedResource(provider);
    provider.restoreResource(record);
    const descriptor = await provider.prepareMangaDownload(record.id);
    expect(descriptor.title).toBe("葬送的芙莉蓮");
    expect(descriptor.chapter).toBe("第1話");
    expect(descriptor.referer).toBe("https://mangabz.com/m117618/");
    expect(descriptor.imageUrls).toHaveLength(39);
    expect(descriptor.imageUrls.map((url) => new URL(url).pathname.split("/").at(-1))).toEqual(Array.from({ length: 39 }, (_, index) => `${index + 1}_page.jpg`));
    expect(requestedPages).toEqual(Array.from({ length: 20 }, (_, index) => index * 2 + 1));
    expect(new URL(descriptor.imageUrls[0]).searchParams.get("key")).toHaveLength(32);
    expect(record.metadata).not.toHaveProperty("imageUrls");
    await provider.prepareMangaDownload(record.id);
    expect(requestedPages).toHaveLength(40);
  });

  it("decodes the current real site's radix-25 string table without executing its script", async () => {
    const realBatch = `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?"":e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--)d[e(c)]=k[c]||e(c);k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1;};while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c]);return p;}('e 9(){1 5=3;1 4=\\'a\\';1 6="g://j.h.f/8/b/3";1 2=["/c.7","/k.7"];o(1 i=0;i<2.l;i++){2[i]=6+2[i]+\\'?5=3&4=a&m=\\'}n 2}1 d;d=9();',25,25,'|var|pvalue|117618|key|cid|pix|jpg||dm5imagefun|8e7952bc1ea30bed9f14df0aea8e9e6b|7020|1_9233||function|com|https|mangabz||image|2_5254|length|uk|return|for'.split('|'),0,{}))`;
    const provider = new MangabzSourceProvider(undefined, { minIntervalMs: 0, fetcher: async (url) => response(url.includes("chapterimage") ? realBatch : chapterHtml.replace("39", "2")) });
    provider.restoreResource(savedResource(provider));
    const result = await provider.prepareMangaDownload("saved");
    expect(result.imageUrls).toEqual([
      "https://image.mangabz.com/8/7020/117618/1_9233.jpg?cid=117618&key=8e7952bc1ea30bed9f14df0aea8e9e6b&uk=",
      "https://image.mangabz.com/8/7020/117618/2_5254.jpg?cid=117618&key=8e7952bc1ea30bed9f14df0aea8e9e6b&uk=",
    ]);
  });

  it("never executes downloaded JavaScript and rejects non-source image URLs and wrong chapter identities", async () => {
    const executableSpy = vi.fn();
    (globalThis as Record<string, unknown>).__mangabzUntrusted = executableSpy;
    try {
      for (const batch of [
        packedBatch(1, { prefix: "https://127.0.0.1/8/7020/117618", wrapper: "globalThis.__mangabzUntrusted();return p;" }),
        packedBatch(1, { prefix: "https://image.mangabz.com.evil.test/117618" }),
        packedBatch(1, { paths: ["/../../outside.jpg"] }), packedBatch(1, { id: "999" }),
        `globalThis.__mangabzUntrusted(); ["https://evil.test/image.jpg"]`,
      ]) {
        const provider = new MangabzSourceProvider(undefined, { minIntervalMs: 0, fetcher: async (url) => response(url.includes("chapterimage") ? batch : chapterHtml) });
        provider.restoreResource(savedResource(provider));
        await expect(provider.prepareMangaDownload("saved")).rejects.toThrow("MangaBZ");
      }
      expect(executableSpy).not.toHaveBeenCalled();
    } finally { delete (globalThis as Record<string, unknown>).__mangabzUntrusted; }
  });

  it("stops on a missing batch instead of returning an incomplete descriptor", async () => {
    const provider = new MangabzSourceProvider(undefined, { minIntervalMs: 0, fetcher: async (url) => response(!url.includes("chapterimage") ? chapterHtml : new URL(url).searchParams.get("page") === "1" ? packedBatch(1) : "") });
    provider.restoreResource(savedResource(provider));
    await expect(provider.prepareMangaDownload("saved")).rejects.toThrow("无法安全解析");
  });

  it("rejects manipulated saved URLs and invalid source IDs before networking", async () => {
    const fetcher = vi.fn(async () => response(""));
    const provider = new MangabzSourceProvider(undefined, { fetcher, minIntervalMs: 0 });
    const record = savedResource(provider);
    expect(() => provider.restoreResource({ ...record, targetUrl: "https://evil.test/m117618/" })).toThrow("地址与标识不一致");
    await expect(provider.listResources("../../secret")).rejects.toThrow("ID 无效");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports access checks and restricted chapters honestly", async () => {
    const blocked = new MangabzSourceProvider(undefined, { minIntervalMs: 0, fetcher: async () => response('<title>Just a moment...</title><div class="captcha-container">Verify</div>') });
    await expect(blocked.search({ keyword: "测试", aliases: [], mediaType: "manga" })).rejects.toThrow("不会绕过验证");
    expect(await blocked.healthCheck()).toMatchObject({ ok: false });
    const paid = new MangabzSourceProvider(undefined, { minIntervalMs: 0, fetcher: async () => response(chapterHtml.replace('"False"', '"True"')) });
    paid.restoreResource(savedResource(paid));
    await expect(paid.prepareMangaDownload("saved")).rejects.toThrow("不会绕过付费");
    const empty = new MangabzSourceProvider(undefined, { minIntervalMs: 0, fetcher: async () => response('<p class="detail-info-title">测试</p><div id="chapterlistload"></div>') });
    await expect(empty.listResources("7020")).rejects.toThrow("没有可下载图片章节");
  });
});
