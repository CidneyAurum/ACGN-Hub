import { describe, expect, it } from "vitest";
import { InternetArchiveSourceProvider } from "@/infrastructure/sources/internet-archive-source-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

function response(body: unknown): { status: number; json: () => Promise<unknown> } {
  return { status: 200, json: async () => body };
}

describe("InternetArchiveSourceProvider", () => {
  it("prefers a matching work over archived soundtrack covers and labels actual MP4 files", async () => {
    const provider = new InternetArchiveSourceProvider("https://archive.example", { fetcher: async (url) => url.includes("/advancedsearch.php")
      ? response({ response: { docs: [
        { identifier: "cover", title: "Frieren OST (HQ Cover) 葬送的芙莉莲 背景音乐" },
        { identifier: "work", title: "葬送的芙莉莲" },
      ] } })
      : response({ files: [{ name: "episode.mp4", size: "1234" }, { name: "work_meta.xml" }, { name: "thumb.jpg" }] }) });
    const matches = await provider.search({ keyword: "葬送的芙莉莲", aliases: [], mediaType: "anime" });
    expect(matches[0].sourceItemId).toBe("work");
    const resources = await provider.listResources("work");
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ protocol: "http", format: "MP4", metadata: { resourceLabel: "视频直链" } });
  });

  it("returns only direct public ebook files for a novel", async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.includes("/advancedsearch.php")) {
        return response({ response: { docs: [{ identifier: "book-1", title: "测试轻小说", year: 2025 }] } });
      }
      return response({
        metadata: { identifier: "book-1", title: "测试轻小说" },
        files: [
          { name: "book.epub", format: "EPUB", size: "1234" },
          { name: "book_meta.xml", format: "Metadata", size: "50" },
          { name: "cover.jpg", format: "JPEG", size: "100" },
        ],
      });
    };
    const provider = new InternetArchiveSourceProvider("https://archive.example", { fetcher });
    const matches = await provider.search({ keyword: "测试轻小说", aliases: [], mediaType: "novel" });
    const resources = await provider.listResources(matches[0].sourceItemId);

    expect(resources).toHaveLength(1);
    expect(resources[0].format).toBe("EPUB");
    expect(resources[0].targetUrl).toBe("https://archive.example/download/book-1/book.epub");
    expect(resources[0].protocol).toBe("http");
  });

  it("keeps ten-second video samples downloadable but warns about their content rather than presenting a confirmed full episode", async () => {
    const provider = new InternetArchiveSourceProvider("https://archive.example", { fetcher: async (url) => url.includes("/advancedsearch.php")
      ? response({ response: { docs: [{ identifier: "bunny", title: "Big Buck Bunny" }] } })
      : response({ files: [
        { name: "sample-1080p.mp4", format: "MPEG4", length: "10", size: "30704510" },
        { name: "full-short-film.mp4", length: "596.48" },
        { name: "unknown-duration.mp4" },
        { name: "notes.txt", length: "10" },
      ] }) });
    await provider.search({ keyword: "Big Buck Bunny", aliases: [], mediaType: "anime" });
    const resources = await provider.listResources("bunny");
    expect(resources).toHaveLength(4);
    expect(resources[0]).toMatchObject({ protocol: "http", sizeBytes: 30704510, metadata: { durationSeconds: 10, resourceLabel: "短视频直链 · 片段/样片待核对" } });
    expect(resources[0].metadata.warnings).toEqual([expect.stringContaining("不能据此认定完整正片")]);
    for (const resource of resources.slice(1)) expect(resource.metadata.warnings).toBeUndefined();
    expect(resources[1].metadata.resourceLabel).toBe("视频直链");
    expect(resources[3].metadata.resourceLabel).toBe("电子书直链");
  });
});
