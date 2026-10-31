import { describe, expect, it } from "vitest";
import { CopyMangaSourceProvider } from "@/infrastructure/sources/copymanga-source-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

function response(body: unknown): { status: number; json: () => Promise<unknown> } {
  return { status: 200, json: async () => body };
}

describe("CopyMangaSourceProvider", () => {
  it("retains same-title adaptation editions and exposes authors and actual latest chapter labels", async () => {
    const old = { name: "安達與島村", path_word: "andayudaocun", author: [{ name: "入间人间" }, { name: "まに" }] };
    const newer = { name: "安達與島村", path_word: "andayudaocunnew", author: [{ name: "入间人间" }, { name: "柚原もけ" }] };
    const fetcher: JsonFetcher = async (url) => {
      if (url.includes("/search/comic")) return response({ code: 200, results: { list: [old, newer] } });
      if (url.includes("/comic2/")) return response({ code: 200, results: { comic: newer, groups: { default: { path_word: "default" }, tankobon: { path_word: "tankobon" } } } });
      if (url.includes("/group/tankobon/")) return response({ code: 200, results: { total: 1, list: [{ uuid: "volume-1", name: "第1卷", index: 0 }] } });
      return response({ code: 200, results: { total: 3, list: [
        { uuid: "chapter-1", name: "第01话", index: 0 }, { uuid: "chapter-60", name: "第60话", index: 67 }, { uuid: "extra", name: "番外篇2", index: 68 },
      ] } });
    };
    const provider = new CopyMangaSourceProvider("https://configured.example", { fetcher });
    const candidates = await provider.search({ keyword: "安达与岛村", aliases: [], mediaType: "manga" });
    expect(candidates.map((item) => item.sourceItemId)).toEqual(["andayudaocun", "andayudaocunnew"]);
    expect(candidates[0].raw).toMatchObject({ authors: ["入间人间", "まに"], editionLabel: "入间人间 / まに版" });
    expect(candidates[1].raw).toMatchObject({ authors: ["入间人间", "柚原もけ"], editionLabel: "入间人间 / 柚原もけ版" });
    const resources = await provider.listResources("andayudaocunnew");
    expect(resources).toHaveLength(4);
    expect(resources[1].chapter).toBe(60);
    expect(resources[2].chapter).toBeUndefined();
    expect(resources[0].metadata).toMatchObject({ authors: ["入间人间", "柚原もけ"], editionLabel: "入间人间 / 柚原もけ版", latestChapter: "第60话", chapterCount: 4 });
    expect(resources.at(-1)?.metadata).toMatchObject({ chapterCount: 4, groupWord: "tankobon" });
  });
  it("restores the saved comic and chapter metadata for CBZ generation", async () => {
    const provider = new CopyMangaSourceProvider("https://configured.example", { fetcher: async () => response({ code: 200, results: { chapter: { contents: [{ url: "https://images.example/page.jpg" }] } } }) });
    provider.restoreResource({ id: "saved", sourceId: provider.id, sourceItemId: "comic-1", title: "测试漫画", protocol: "http", targetUrl: "https://configured.example/chapter", createdAt: "2026-01-01", metadata: { provider: "拷贝漫画", pathWord: "comic-1", chapterUuid: "chapter-1", seriesTitle: "测试漫画", chapterName: "第1话", downloadMode: "manga_cbz" } });
    await expect(provider.prepareMangaDownload("saved")).resolves.toMatchObject({ title: "测试漫画", chapter: "第1话", imageUrls: ["https://images.example/page.jpg"] });
  });

  it("does not send a configured token to unconfigured fallback hosts", async () => {
    const requested: string[] = [];
    const provider = new CopyMangaSourceProvider("https://configured.example", { token: "test-token", fetcher: async (url) => { requested.push(url); return { status: 503, json: async () => ({}) }; } });
    await expect(provider.search({ keyword: "测试漫画", aliases: [], mediaType: "manga" })).rejects.toThrow("503");
    expect(requested).toHaveLength(1);
    expect(requested.every((url) => new URL(url).origin === "https://configured.example")).toBe(true);
  });

  it("lists chapters and lazily prepares image URLs for CBZ packaging", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetcher: JsonFetcher = async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers) });
      if (url.includes("/search/comic")) {
        return response({ code: 200, results: { list: [{ name: "测试漫画", alias: "Test", path_word: "test-manga", cover: "https://img.example/cover.jpg" }] } });
      }
      if (url.includes("/comic2/")) return response({ code: 200, results: null });
      if (url.includes("/chapters")) {
        return response({ code: 200, results: { list: [{ uuid: "chapter-1", name: "第 1 话", index: 0 }], total: 1 } });
      }
      return response({ code: 200, results: { comic: { name: "测试漫画" }, chapter: { name: "第 1 话", contents: [{ url: "https://cdn.example/page-001-c800x.jpg" }] } } });
    };
    const provider = new CopyMangaSourceProvider("https://api.mangacopy.com", { fetcher });
    const matches = await provider.search({ keyword: "测试漫画", aliases: [], mediaType: "manga" });
    const resources = await provider.listResources(matches[0].sourceItemId);
    const descriptor = await provider.prepareMangaDownload!(resources[0].id);

    expect(resources).toHaveLength(1);
    expect(resources[0].format).toBe("CBZ");
    expect(resources[0].metadata.downloadMode).toBe("manga_cbz");
    expect(descriptor.imageUrls).toEqual(["https://cdn.example/page-001-c1500x.jpg"]);
    expect(requests[0].headers.get("version")).toBe("2024.4.28");
    expect(requests[0].headers.get("x-requested-with")).toBe("com.manga2020.app");
  });

  it("uses a locally configured token for chapter requests", async () => {
    let authorization = "";
    const fetcher: JsonFetcher = async (url, init) => {
      authorization = new Headers(init.headers).get("authorization") ?? "";
      if (url.includes("/search/comic")) return response({ code: 200, results: { list: [{ name: "测试漫画", path_word: "test-manga" }] } });
      if (url.includes("/comic2/")) return response({ code: 200, results: null });
      if (url.includes("/chapters")) return response({ code: 200, results: { list: [{ uuid: "chapter-1", name: "第 1 话", index: 0 }] } });
      return response({ code: 200, results: { comic: { name: "测试漫画" }, chapter: { name: "第 1 话", contents: [{ url: "https://cdn.example/page.jpg" }] } } });
    };
    const provider = new CopyMangaSourceProvider("https://api.mangacopy.com", { fetcher, token: "secret-token" });
    const matches = await provider.search({ keyword: "测试漫画", aliases: [], mediaType: "manga" });
    await provider.listResources(matches[0].sourceItemId);
    expect(authorization).toBe("Token secret-token");
  });
});
