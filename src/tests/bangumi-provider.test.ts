import { describe, expect, it, vi, type MockedFunction } from "vitest";
import { BangumiProvider, BangumiProviderError } from "@/infrastructure/metadata/bangumi-provider";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";
import {
  bangumiCharactersFixture,
  bangumiDetailFixture,
  bangumiDetailsFixture,
  bangumiPersonsFixture,
  bangumiSearchFixture,
} from "@/tests/fixtures/bangumi";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

function response(status: number, body: unknown) {
  return { status, json: async () => body };
}

function fetcher(...responses: Array<ReturnType<typeof response>>): MockedFunction<JsonFetcher> {
  const mock = vi.fn() as MockedFunction<JsonFetcher>;
  for (const item of responses) mock.mockResolvedValueOnce(item);
  return mock;
}

describe("BangumiProvider", () => {
  it("searches anime and maps Bangumi subjects to Media", async () => {
    const request = fetcher(response(200, bangumiSearchFixture));
    const provider = new BangumiProvider({ fetcher: request, minIntervalMs: 0, sleep: async () => {} });

    const result = await provider.search({ keyword: "芙莉莲", type: "anime" });

    expect(result[0]).toMatchObject({
      id: "bangumi:12345",
      type: "anime",
      title: "葬送的芙莉莲",
      originalTitle: "葬送のフリーレン",
      releaseYear: 2023,
      coverUrl: "https://lain.bgm.tv/pic/cover/l/aa/bb/12345_abc.jpg",
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.bgm.tv/v0/search/subjects?limit=20&offset=0",
      expect.objectContaining({ method: "POST" }),
    );
    const init = request.mock.calls[0][1];
    expect(JSON.parse(String(init.body))).toMatchObject({ keyword: "芙莉莲", filter: { type: [2], nsfw: false } });
  });

  it("caches detail requests", async () => {
    const request = fetcher(response(200, bangumiDetailFixture));
    const provider = new BangumiProvider({ fetcher: request, cache: new MemoryCache(), minIntervalMs: 0 });

    await provider.getById("bangumi:12345");
    await provider.getById("12345");

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limited request", async () => {
    const request = fetcher(response(429, {}), response(200, bangumiSearchFixture));
    const provider = new BangumiProvider({ fetcher: request, minIntervalMs: 0, maxRetries: 1, sleep: async () => {} });

    await expect(provider.search({ keyword: "芙莉莲" })).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed responses", async () => {
    const provider = new BangumiProvider({ fetcher: fetcher(response(200, { data: [{}] })), minIntervalMs: 0 });

    await expect(provider.search({ keyword: "bad fixture" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("keeps Bangumi books isolated between manga and novels", async () => {
    const books = {
      total: 2,
      limit: 20,
      offset: 0,
      data: [
        { id: 1, type: 1, name: "Manga", name_cn: "漫画作品", platform: "漫画", tags: [] },
        { id: 2, type: 1, name: "Novel", name_cn: "小说作品", platform: "小说", tags: [] },
      ],
    };
    const request = fetcher(response(200, books), response(200, books));
    const provider = new BangumiProvider({ fetcher: request, minIntervalMs: 0, sleep: async () => {} });

    await expect(provider.search({ keyword: "作品", type: "manga" })).resolves.toMatchObject([{ id: "bangumi:1", type: "manga" }]);
    await expect(provider.search({ keyword: "作品", type: "novel" })).resolves.toMatchObject([{ id: "bangumi:2", type: "novel" }]);
  });

  it("keeps infobox aliases for source matching", async () => {
    const request = fetcher(response(200, {
      id: 55770,
      type: 2,
      name: "進撃の巨人",
      name_cn: "进击的巨人",
      infobox: [{ key: "别名", value: [{ v: "Attack on Titan" }, { v: "Shingeki no Kyojin" }] }],
    }));
    const provider = new BangumiProvider({ fetcher: request, minIntervalMs: 0 });

    await expect(provider.getById("55770")).resolves.toMatchObject({
      aliases: ["進撃の巨人", "进击的巨人", "Attack on Titan", "Shingeki no Kyojin"],
    });
  });

  it("keeps an authoritative novel platform despite manga adaptation tags in search and detail", async () => {
    const novel = { id: 613150, type: 1, name: "Novel with a manga adaptation", platform: "小说", tags: [{ name: "漫画", count: 4 }, { name: "轻小说", count: 50 }], rating: { score: 8.2, total: 120 } };
    const manga = { id: 100, type: 1, name: "Manga adapted from prose", platform: "漫画", tags: [{ name: "小说", count: 100 }] };
    const mixed = { id: 200, type: 1, name: "Unknown book", tags: [{ name: "漫画" }, { name: "小说" }] };
    const artbook = { id: 300, type: 1, name: "Illustrations", platform: "画集", tags: [{ name: "漫画" }] };
    const page = { data: [novel, manga, mixed, artbook] };
    const request = fetcher(response(200, page), response(200, page), response(200, novel));
    const provider = new BangumiProvider({ fetcher: request, minIntervalMs: 0 });
    await expect(provider.search({ keyword: "adaptation", type: "novel" })).resolves.toMatchObject([{ id: "bangumi:613150", type: "novel" }]);
    await expect(provider.search({ keyword: "adaptation", type: "manga" })).resolves.toMatchObject([{ id: "bangumi:100", type: "manga" }]);
    await expect(provider.getById("bangumi:613150")).resolves.toMatchObject({ type: "novel", metadata: { rating: 8.2, ratingCount: 120 } });
  });

  it("builds structured details from subject, characters and persons", async () => {
    const request = fetcher(
      response(200, bangumiDetailsFixture),
      response(200, bangumiCharactersFixture),
      response(200, bangumiPersonsFixture),
    );
    const provider = new BangumiProvider({ fetcher: request, minIntervalMs: 0 });

    const details = await provider.getDetails!("bangumi:12345");

    expect(details).toMatchObject({
      providerId: "bangumi",
      externalId: "12345",
      summary: "魔法使芙莉莲的旅途。",
      episodes: 28,
      airDate: "2023-09-29",
      studios: ["MADHOUSE"],
      rating: { score: 8.8, count: 4200 },
    });
    // Tags sorted by count descending.
    expect(details.tags.slice(0, 2)).toEqual(["奇幻", "冒险"]);
    expect(details.characters).toMatchObject([
      { name: "芙莉莲", role: "主角", actors: [{ name: "种崎敦美" }] },
      { name: "菲伦", role: "配角", actors: [{ name: "市之濑加那" }] },
    ]);
    expect(details.staff).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "斋藤圭一郎", role: "导演" }),
    ]));
  });

  it("degrades to subject-only details when character or person endpoints fail", async () => {
    const request = fetcher(
      response(200, bangumiDetailsFixture),
      response(500, {}),
      response(404, {}),
    );
    const provider = new BangumiProvider({ fetcher: request, minIntervalMs: 0, maxRetries: 0 });

    const details = await provider.getDetails!("12345");

    expect(details.characters).toEqual([]);
    expect(details.staff).toEqual([]);
    expect(details.tags.length).toBeGreaterThan(0);
  });
});
