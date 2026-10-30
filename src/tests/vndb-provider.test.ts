import { describe, expect, it, vi, type MockedFunction } from "vitest";
import { VndbProvider } from "@/infrastructure/metadata/vndb-provider";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";
import { vndbCharactersFixture, vndbDetailsFixture, vndbDetailFixture, vndbSearchFixture } from "@/tests/fixtures/vndb";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

function response(status: number, body: unknown) {
  return { status, json: async () => body };
}

function fetcher(...responses: Array<ReturnType<typeof response>>): MockedFunction<JsonFetcher> {
  const mock = vi.fn() as MockedFunction<JsonFetcher>;
  for (const item of responses) mock.mockResolvedValueOnce(item);
  return mock;
}

describe("VndbProvider", () => {
  it("searches visual novels and maps VNDB entries to Media", async () => {
    const request = fetcher(response(200, vndbSearchFixture));
    const provider = new VndbProvider({ fetcher: request, minIntervalMs: 0, sleep: async () => {} });

    const result = await provider.search({ keyword: "Fate", type: "visual_novel" });

    expect(result[0]).toMatchObject({
      id: "vndb:v17",
      type: "visual_novel",
      title: "Fate/stay night",
      originalTitle: "フェイト／ステイナイト",
      releaseYear: 2004,
      coverUrl: "https://s.vndb.org/v17/0f/17.jpg",
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.vndb.org/kana/vn",
      expect.objectContaining({ method: "POST" }),
    );
    const init = request.mock.calls[0][1];
    expect(JSON.parse(String(init.body))).toMatchObject({
      filters: ["search", "=", "Fate"],
      sort: "searchrank",
      results: 20,
      page: 1,
    });
  });

  it("caches detail requests and accepts prefixed or raw IDs", async () => {
    const request = fetcher(response(200, { results: [vndbDetailFixture], more: false }));
    const provider = new VndbProvider({ fetcher: request, cache: new MemoryCache(), minIntervalMs: 0 });

    await provider.getById("vndb:v17");
    await provider.getById("v17");

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limited request", async () => {
    const request = fetcher(response(429, {}), response(200, vndbSearchFixture));
    const provider = new VndbProvider({ fetcher: request, minIntervalMs: 0, maxRetries: 1, sleep: async () => {} });

    await expect(provider.search({ keyword: "Fate" })).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed responses", async () => {
    const provider = new VndbProvider({ fetcher: fetcher(response(200, { results: [{}] })), minIntervalMs: 0 });

    await expect(provider.search({ keyword: "bad fixture" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("builds structured details with spoiler-free tags, staff and cast", async () => {
    const request = fetcher(response(200, { results: [vndbDetailsFixture], more: false }), response(200, vndbCharactersFixture));
    const provider = new VndbProvider({ fetcher: request, minIntervalMs: 0 });

    const details = await provider.getDetails!("v17");

    expect(details).toMatchObject({
      providerId: "vndb",
      externalId: "v17",
      rating: { score: 88, count: 1000 },
      durationMinutes: 3000,
      airDate: "2004-01-30",
      developers: ["TYPE-MOON"],
      studios: ["TYPE-MOON"],
    });
    // Spoiler tags (spoiler > 0) are dropped; the rest sort by rating.
    expect(details.tags).toEqual(["Fantasy", "Holy Grail War"]);
    // BBCode is cleaned into plain text.
    expect(details.summary).not.toContain("[url=");
    expect(details.summary).not.toContain("[spoiler]");
    expect(details.staff).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Nasu Kinoko", originalName: "奈須きのこ", role: "剧本" }),
      expect.objectContaining({ name: "Takeuchi Takashi", role: "原画" }),
      // Unknown roles pass through untranslated.
      expect.objectContaining({ name: "Kate", role: "unknown_role" }),
    ]));
    expect(details.characters).toMatchObject([
      { name: "Saber", role: "主角" },
      { name: "Rin Tohsaka", role: "主角" },
      { name: "Shirou Emiya" },
    ]);
  });

  it("keeps details usable when the character endpoint fails", async () => {
    const request = fetcher(response(200, { results: [vndbDetailsFixture], more: false }), response(500, {}));
    const provider = new VndbProvider({ fetcher: request, minIntervalMs: 0, maxRetries: 0 });

    const details = await provider.getDetails!("vndb:v17");

    expect(details.characters).toEqual([]);
    expect(details.tags.length).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
