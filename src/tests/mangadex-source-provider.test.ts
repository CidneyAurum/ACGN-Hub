import { describe, expect, it } from "vitest";
import { MangaDexSourceProvider } from "@/infrastructure/sources/mangadex-source-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

function response(body: unknown): { status: number; json: () => Promise<unknown> } {
  return { status: 200, json: async () => body };
}

describe("MangaDexSourceProvider", () => {
  it("reports a real-world empty chapter feed instead of implying the title is downloadable", async () => {
    const provider = new MangaDexSourceProvider("https://api.example", { fetcher: async (url) => url.includes("/feed?")
      ? response({ result: "ok", total: 0, data: [] })
      : response({ result: "ok", data: { id: "b0b721ff-c388-4486-aa0f-c2b0bb321512", attributes: { title: { en: "Sousou no Frieren" } } } }) });
    await expect(provider.listResources("b0b721ff-c388-4486-aa0f-c2b0bb321512")).rejects.toThrow("没有可下载图片章节");
  });

  it("restores a saved chapter without requiring another title search", async () => {
    const provider = new MangaDexSourceProvider("https://api.example", { fetcher: async () => response({ result: "ok", baseUrl: "https://images.example", chapter: { hash: "saved", data: ["one.jpg"] } }) });
    provider.restoreResource({
      id: "saved-chapter", sourceId: provider.id, sourceItemId: "manga-1", title: "测试漫画 · 第1话", protocol: "http", targetUrl: "https://mangadex.org/chapter/chapter-1", createdAt: "2026-01-01",
      metadata: { provider: "MangaDex", chapterId: "chapter-1", seriesTitle: "测试漫画", chapterName: "第1话", downloadMode: "manga_cbz" },
    });
    await expect(provider.prepareMangaDownload("saved-chapter")).resolves.toMatchObject({ title: "测试漫画", chapter: "第1话", imageUrls: ["https://images.example/data/saved/one.jpg"] });
  });

  it("lists later chapter pages without probing or silently limiting the list to 30", async () => {
    const requested: string[] = [];
    const fetcher: JsonFetcher = async (url) => {
      requested.push(url);
      if (url.includes("/manga?")) return response({ result: "ok", data: [{ id: "manga-1", attributes: { title: { zh: "测试漫画" } } }] });
      if (!url.includes("/feed?")) throw new Error("Chapter images must not be probed during listing");
      const offset = Number(new URL(url).searchParams.get("offset"));
      return response({ result: "ok", total: 101, data: Array.from({ length: offset ? 1 : 100 }, (_, index) => ({ id: `chapter-${offset + index}`, attributes: { chapter: String(offset + index), translatedLanguage: "zh", pages: 1 } })) });
    };
    const provider = new MangaDexSourceProvider("https://api.example", { fetcher });
    await provider.search({ keyword: "测试漫画", aliases: [], mediaType: "manga" });
    const resources = await provider.listResources("manga-1");
    expect(resources).toHaveLength(101);
    expect(requested).toHaveLength(3);
  });

  it("searches titles, lists chapters and resolves @Home images", async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.includes("/manga?")) {
        return response({
          result: "ok",
          data: [{
            id: "manga-1",
            attributes: { title: { en: "Test Manga" }, altTitles: [{ zh: "测试漫画" }], year: 2024 },
            relationships: [{ type: "cover_art", attributes: { fileName: "cover.png" } }],
          }],
        });
      }
      if (url.includes("/feed?")) {
        return response({
          result: "ok",
          data: [{ id: "chapter-1", attributes: { chapter: "1", title: "开始", translatedLanguage: "zh", pages: 2 } }],
        });
      }
      return response({
        result: "ok",
        baseUrl: "https://uploads.example",
        chapter: { hash: "hash-1", data: ["page 1.jpg", "page 2.jpg"] },
      });
    };
    const provider = new MangaDexSourceProvider("https://api.example", { fetcher });
    const matches = await provider.search({ keyword: "测试漫画", aliases: [], mediaType: "manga" });
    const resources = await provider.listResources(matches[0].sourceItemId);
    const descriptor = await provider.prepareMangaDownload(resources[0].id);

    expect(matches[0].title).toBe("Test Manga");
    expect(matches[0].coverUrl).toContain("cover.png");
    expect(resources[0].metadata.downloadMode).toBe("manga_cbz");
    expect(descriptor.imageUrls).toEqual([
      "https://uploads.example/data/hash-1/page%201.jpg",
      "https://uploads.example/data/hash-1/page%202.jpg",
    ]);
  });
});
