import { describe, expect, it, vi } from "vitest";
import { Wenku8EpubSourceProvider, WENKU8_EPUB_CATALOG_BASE } from "@/infrastructure/sources/wenku8-source-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

const volume = (index = 1) => ({ index, title: `第${index}卷`, file: `v${String(index).padStart(2, "0")}.epub`, size: 2_856_332, chapters: 10, images: 14 });
const book = (aid: number, title = "文学少女", author = "野村美月") => ({
  title, author, repo: "mojimoon/wenku8-epub", tag: `book-${aid}`, src_update: "2022-02-27", built_at: "2026-10-01T21:10:32", volumes: [volume()],
});
const response = (body: unknown, status = 200) => ({ status, json: async () => body });
const query = { keyword: "文学少女", aliases: [], mediaType: "novel" as const };

describe("Wenku8EpubSourceProvider", () => {
  it("resolves a complete per-volume EPUB with the real aid-prefixed attachment name and reader metadata", async () => {
    const fetcher = vi.fn<JsonFetcher>(async () => response({ "1": { ...book(1), volumes: [volume(), volume(2)] } }));
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher });
    const [candidate] = await provider.search(query);
    expect(candidate).toMatchObject({ sourceItemId: "1", title: "文学少女", raw: { authors: ["野村美月"], catalogStatus: "available", chapterCount: 20 } });
    const resources = await provider.listResources("1");
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      format: "EPUB", protocol: "http", volume: 1, language: "简体中文", sizeBytes: 2_856_332,
      targetUrl: "https://github.com/mojimoon/wenku8-epub/releases/download/book-1/1-v01.epub",
      metadata: { downloadMode: "direct", seriesTitle: "文学少女", volumeTitle: "第1卷", volumeOrder: 1, chapterCount: 10, imageCount: 14 },
    });
    expect(await provider.resolve(resources[0].id)).toMatchObject({ protocol: "http", url: resources[0].targetUrl, filename: "文学少女 - 第1卷.epub" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(WENKU8_EPUB_CATALOG_BASE + "/out/epub_index.json");
  });

  it("finds an author's actual works with traditional name variants and keeps every page reachable", async () => {
    const catalog = Object.fromEntries(Array.from({ length: 43 }, (_, index) => [String(index + 1), book(index + 1, `作品${index + 1}`, "入间人间")]));
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher: async () => response(catalog) });
    const authorQuery = { ...query, keyword: "入間人間" };
    const first = await provider.search(authorQuery);
    const second = await provider.search({ ...authorQuery, page: 2 });
    expect(first).toHaveLength(40);
    expect(second).toHaveLength(3);
    expect(new Set([...first, ...second].map((item) => item.sourceItemId)).size).toBe(43);
    expect(first.every((item) => (item.raw?.authors as string[]).includes("入间人间"))).toBe(true);
    // Short prefixes and a character merely contained in an author's name are not authorship.
    expect(await provider.search({ ...query, keyword: "入间" })).toEqual([]);
  });

  it("does not turn a withdrawn original into a downloadable spin-off, even if obsolete volumes remain", async () => {
    const catalog = {
      "1587": { ...book(1587, "无职转生～到了异世界就拿出真本事～", "理不尽な孙の手"), blocked: "copyright" },
      "3765": book(3765, "无职转生～蛇足篇～", "理不尽な孙の手"),
    };
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher: async () => response(catalog) });
    const matches = await provider.search({ ...query, keyword: "无职转生" });
    expect(matches[0]).toMatchObject({ sourceItemId: "1587", raw: { catalogStatus: "blocked", chapterCount: 0, status: expect.stringContaining("版权下架") } });
    await expect(provider.listResources("1587")).rejects.toThrow("版权下架");
    await expect(provider.resolve(provider.id + ":1587:1")).rejects.toThrow("版权下架");
    const resources = await provider.listResources("3765");
    expect(resources[0].metadata.seriesTitle).toBe("无职转生～蛇足篇～");
    expect(resources[0].sourceItemId).toBe("3765");
  });

  it("restores a stable aid:volume identity in a fresh instance without trusting a stored URL", async () => {
    const provider = new Wenku8EpubSourceProvider("https://catalog.example/repo/main", { fetcher: async () => response({ "1": book(1) }) });
    const id = provider.id + ":1:1";
    expect(await provider.resolve(id)).toMatchObject({ url: "https://github.com/mojimoon/wenku8-epub/releases/download/book-1/1-v01.epub" });
    await expect(provider.resolve("other:" + id)).rejects.toThrow("身份无效");
    await expect(provider.resolve(provider.id + ":1:2")).rejects.toThrow("分卷已不在");
    await expect(provider.resolve(provider.id + ":2:1")).rejects.toThrow("不在当前");
  });

  it("does not cache a failed catalogue and can retry without a restart", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response({ "1": book(1) }));
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher });
    await expect(provider.search(query)).rejects.toThrow("HTTP 503");
    expect(await provider.search(query)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous catalogue requests and refreshes on a health check", async () => {
    const fetcher = vi.fn<JsonFetcher>(async () => response({ "1": book(1) }));
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher });
    await Promise.all([provider.search(query), provider.listResources("1")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await provider.healthCheck()).toMatchObject({ ok: true, message: expect.stringContaining("1 部") });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched books, duplicate volume identities, traversal filenames and malformed entries", async () => {
    const catalog = {
      "1": book(1),
      "2": { ...book(2), tag: "book-1" },
      "3": { ...book(3), volumes: [volume(), volume()] },
      "4": { ...book(4), volumes: [{ ...volume(), file: "../v01.epub" }] },
      "5": { ...book(5), volumes: [{ ...volume(), index: 2 }] },
      "6": { ...book(6), repo: "https://evil.example/repo" },
      "7": { ...book(7), volumes: [{ ...volume(), chapters: 0 }] },
      "8": { ...book(8), volumes: [volume(), { ...volume(2), size: -1 }] },
      "../9": book(9),
    };
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher: async () => response(catalog) });
    expect((await provider.search(query)).map((item) => item.sourceItemId)).toEqual(["1"]);
    for (const aid of ["2", "3", "4", "5", "6", "7", "8", "../9"]) expect(await provider.listResources(aid)).toEqual([]);
  });

  it("reports pending builds without constructing an empty ebook download", async () => {
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher: async () => response({ "1": { title: "文学少女", volumes: [] } }) });
    expect((await provider.search(query))[0].raw?.catalogStatus).toBe("pending");
    await expect(provider.listResources("1")).rejects.toThrow("尚无已生成");
  });

  it("prefers available original illustration editions per volume without losing default-only volumes or changing saved identities", async () => {
    const original = { ...book(1), volumes: [{ ...volume(), file: "orig-v01.epub", size: 4_218_271 }] };
    const scaled = { ...book(1), volumes: [{ ...volume(), file: "1600-v01.epub" }] };
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher: async () => response({ "1": {
      ...book(1), volumes: [volume(), volume(2)], variants: { orig: original, "1600": scaled },
    } }) });
    const resources = await provider.listResources("1");
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ id: provider.id + ":1:1:orig", sizeBytes: 4_218_271, metadata: { imageQuality: "orig", volumeOrder: 1 } });
    expect(resources[0].targetUrl).toMatch(/\/1-orig-v01\.epub$/);
    expect(resources[1]).toMatchObject({ id: provider.id + ":1:2", metadata: { imageQuality: "default", volumeOrder: 2 } });
    // A previously selected default/1600 version remains that exact asset after orig becomes available.
    expect((await provider.resolve(provider.id + ":1:1")).url).toMatch(/\/1-v01\.epub$/);
    expect((await provider.resolve(provider.id + ":1:1:1600")).url).toMatch(/\/1-1600-v01\.epub$/);
    expect((await provider.resolve(resources[0].id)).url).toBe(resources[0].targetUrl);
  });

  it("includes works with only nondefault editions and ignores mismatched or unknown variant attachments", async () => {
    const provider = new Wenku8EpubSourceProvider(undefined, { fetcher: async () => response({ "1": {
      title: "文学少女", variants: {
        orig: { ...book(1), volumes: [{ ...volume(), file: "orig-v01.epub" }] },
        "1600": { ...book(1), tag: "book-2", volumes: [{ ...volume(), file: "1600-v01.epub" }] },
        "600": { ...book(1), volumes: [volume()] },
        invented: book(1),
      },
    } }) });
    expect((await provider.search(query))[0].raw?.catalogStatus).toBe("available");
    const resources = await provider.listResources("1");
    expect(resources).toHaveLength(1);
    expect(resources[0].targetUrl).toMatch(/\/1-orig-v01\.epub$/);
    await expect(provider.resolve(provider.id + ":1:1:1600")).rejects.toThrow("分卷已不在");
    await expect(provider.resolve(provider.id + ":1:1")).rejects.toThrow("分卷已不在");
  });

  it("bounds page size, preserves a repository base path, and ignores unrelated media types", async () => {
    const fetcher = vi.fn<JsonFetcher>(async () => response({ "1": book(1), "2": book(2) }));
    const provider = new Wenku8EpubSourceProvider("https://catalog.example/owner/repo/main/", { fetcher, pageSize: 1 });
    expect(await provider.search({ ...query, mediaType: "anime" })).toEqual([]);
    expect(await provider.search({ ...query, keyword: " " })).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await provider.search({ ...query, page: 2 }))[0].sourceItemId).toBe("2");
    expect(fetcher.mock.calls[0][0]).toBe("https://catalog.example/owner/repo/main/out/epub_index.json");
    for (const address of ["file:///tmp/catalog", "https://user:secret@example.test", "https://example.test/?token=abc", "https://example.test/#fragment"]) {
      expect(() => new Wenku8EpubSourceProvider(address)).toThrow("目录地址");
    }
  });

  it("never describes an invalid HTML/API response as a healthy source", async () => {
    for (const body of ["<html>verification required</html>", [], {}, { error: "blocked" }]) {
      const provider = new Wenku8EpubSourceProvider(undefined, { fetcher: async () => response(body) });
      expect(await provider.healthCheck()).toMatchObject({ ok: false });
    }
  });
});
