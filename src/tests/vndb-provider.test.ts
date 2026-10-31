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
      metadata: { rating: 8.8, vndbRating: 88 },
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
      rating: { score: 8.8, count: 1000 },
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

  it("discovers Chinese-available rated works through the official anonymous catalog with real pagination", async () => {
    const request = fetcher(response(200, { ...vndbSearchFixture, more: true }), response(200, vndbSearchFixture));
    const provider = new VndbProvider({ fetcher: request, minIntervalMs: 0 });
    const now = new Date(2026, 9, 31, 12);
    const first = await provider.discover({ now });
    const second = await provider.discover({ now, page: 2 });
    expect(first).toMatchObject({ page: 1, hasMore: true, sort: "rating", cached: false, items: [{ metadata: { rating: 8.8 } }] });
    expect(second).toMatchObject({ page: 2, hasMore: false });
    const init = request.mock.calls[0][1];
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(init.body))).toMatchObject({ filters: ["and", ["or", ["lang", "=", "zh-Hans"], ["lang", "=", "zh-Hant"]],
      ["votecount", ">=", 50], ["released", "<=", "2026-10-31"]], sort: "rating", reverse: true, results: 24, page: 1 });
    expect(JSON.parse(String(request.mock.calls[1][1].body)).page).toBe(2);
    expect(JSON.parse(String(init.body)).fields).toContain("sexual,violence");
  });

  it("updates the near-two-year original-release window on date changes and handles leap days", async () => {
    const request = vi.fn<JsonFetcher>().mockResolvedValue(response(200, vndbSearchFixture));
    const provider = new VndbProvider({ fetcher: request, minIntervalMs: 0 });
    await provider.discover({ sort: "recent", now: new Date(2026, 9, 31, 12) });
    await provider.discover({ sort: "recent", now: new Date(2026, 10, 1, 12) });
    await provider.discover({ sort: "recent", now: new Date(2028, 1, 29, 12) });
    const bodies = request.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0]).toMatchObject({ sort: "released", reverse: true, filters: ["and", expect.anything(), ["votecount", ">=", 5], ["released", "<=", "2026-10-31"], ["released", ">=", "2024-10-31"]] });
    expect(bodies[1].filters).toContainEqual(["released", ">=", "2024-11-01"]);
    expect(bodies[2].filters).toContainEqual(["released", ">=", "2026-02-28"]);
  });

  it("caches a matching discovery page, refreshes on demand, and does not reuse another sort's cache", async () => {
    const request = vi.fn<JsonFetcher>().mockResolvedValue(response(200, vndbSearchFixture));
    const provider = new VndbProvider({ fetcher: request, minIntervalMs: 0 });
    const now = new Date(2026, 9, 31, 12);
    await provider.discover({ now });
    await expect(provider.discover({ now })).resolves.toMatchObject({ cached: true });
    expect(request).toHaveBeenCalledTimes(1);
    await provider.discover({ now, refresh: true });
    await provider.discover({ now, sort: "recent" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("uses neutral placeholders for flagged covers and rejects invalid scores instead of showing them as valid", async () => {
    const request = fetcher(response(200, { results: [
      { ...vndbDetailFixture, image: { ...vndbDetailFixture.image, sexual: 1, violence: 0 } },
      { ...vndbDetailFixture, id: "v18", image: { ...vndbDetailFixture.image, sexual: 0, violence: 2 }, rating: 120 },
      { ...vndbDetailFixture, id: "v19", image: { ...vndbDetailFixture.image, sexual: 0, violence: 0 } },
    ], more: false }));
    const results = await new VndbProvider({ fetcher: request, minIntervalMs: 0 }).discover();
    expect(results.items[0].coverUrl).toBeUndefined();
    expect(results.items[1].coverUrl).toBeUndefined();
    expect(results.items[1].metadata.rating).toBeNull();
    expect(results.items[2].coverUrl).toBe(vndbDetailFixture.image.url);
  });

  it("rejects invalid discovery inputs before networking and exposes an upstream failure for a useful retry", async () => {
    const request = fetcher(response(503, {}));
    const provider = new VndbProvider({ fetcher: request, minIntervalMs: 0, maxRetries: 0 });
    await expect(provider.discover({ page: -1 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(provider.discover({ now: new Date("invalid") })).rejects.toMatchObject({ code: "bad_request" });
    expect(request).not.toHaveBeenCalled();
    await expect(provider.discover()).rejects.toMatchObject({ code: "server_error" });
  });
});
