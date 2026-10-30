import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnimeSeason } from "@/domain/anime-season";
import type { JsonFetcher, JsonRequestInit } from "@/infrastructure/metadata/json-transport";
import { getSeasonDiscovery } from "@/infrastructure/metadata/season-discovery-provider";

const autumn: AnimeSeason = { year: 2026, quarter: 4 };
const winter: AnimeSeason = { year: 2027, quarter: 1 };
const timestamp = Date.parse("2026-10-30T04:00:00.000Z");
function cache() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function subject(id: number, date = "2026-10-03", extra: Record<string, unknown> = {}) {
  return { id, type: 2, name: `Original ${id}`, name_cn: `作品 ${id}`, date, summary: "来源简介", images: { large: "http://lain.bgm.tv/actual-cover.jpg" }, rating: { score: 7.6, total: 2489 }, collection: { doing: 14932, wish: 3302, collect: 378 }, ...extra };
}
function fetchPage(data: unknown[], total = data.length, offset = 0): JsonFetcher {
  return vi.fn(async (url) => {
    const params = new URL(url).searchParams;
    const limit = Math.min(20, Number(params.get("limit")));
    const requestOffset = Number(params.get("offset"));
    return { status: 200, json: async () => ({ data: data.slice(requestOffset - offset, requestOffset - offset + limit), total, limit, offset: requestOffset }) };
  });
}
const offline: JsonFetcher = async () => { throw new Error("offline"); };

describe("seasonal Bangumi discovery", () => {
  afterEach(() => vi.useRealTimers());

  it("queries the official date filter and heat order, retaining genuine metadata and more than 24 hits", async () => {
    const fetcher = fetchPage(Array.from({ length: 24 }, (_, index) => subject(index + 1)), 158);
    const result = await getSeasonDiscovery(autumn, { fetcher, storage: cache(), now: () => timestamp });
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe("https://api.bgm.tv/v0/search/subjects?limit=20&offset=0");
    expect(vi.mocked(fetcher).mock.calls[1][0]).toBe("https://api.bgm.tv/v0/search/subjects?limit=4&offset=20");
    expect(init).toMatchObject({ method: "POST", timeoutMs: 12000 });
    expect(JSON.parse(String(init.body))).toEqual({ keyword: "", sort: "heat", filter: { type: [2], air_date: [">=2026-10-01", "<2027-01-01"], nsfw: false } });
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(result).toMatchObject({ total: 158, page: 1, pageSize: 24, hasMore: true, cached: false, stale: false, updatedAt: "2026-10-30T04:00:00.000Z" });
    expect(result.items).toHaveLength(24);
    expect(result.items[0]).toMatchObject({ id: "bangumi:1", title: "作品 1", originalTitle: "Original 1", coverUrl: "https://lain.bgm.tv/actual-cover.jpg", description: "来源简介", releaseYear: 2026, metadata: { date: "2026-10-03", rating: 7.6, voteCount: 2489, watching: 14932, collectionCount: 18612 } });
  });

  it("paginates with the requested offset and stops at the actual final page", async () => {
    const fetcher = fetchPage([subject(25), subject(26)], 26, 24);
    const result = await getSeasonDiscovery(autumn, { page: 2, fetcher, storage: null });
    expect(vi.mocked(fetcher).mock.calls[0][0]).toContain("offset=24");
    expect(result).toMatchObject({ page: 2, total: 26, hasMore: false });
    expect(result.items.map((item) => item.id)).toEqual(["bangumi:25", "bangumi:26"]);
  });

  it("aggregates the live API's twenty-hit cap into 24 + 24 + 1 without skipped records", async () => {
    const fetcher = fetchPage(Array.from({ length: 49 }, (_, index) => subject(index + 1)), 49);
    const storage = cache();
    const results = [];
    for (const page of [1, 2, 3]) results.push(await getSeasonDiscovery(autumn, { page, fetcher, storage }));
    expect(results.map((result) => result.items.length)).toEqual([24, 24, 1]);
    expect(results.map((result) => result.hasMore)).toEqual([true, true, false]);
    expect(results.flatMap((result) => result.items.map((item) => item.id))).toEqual(Array.from({ length: 49 }, (_, index) => `bangumi:${index + 1}`));
    expect(vi.mocked(fetcher).mock.calls.map(([url]) => new URL(url).search)).toEqual(["?limit=20&offset=0", "?limit=4&offset=20", "?limit=20&offset=24", "?limit=4&offset=44", "?limit=20&offset=48"]);
  });

  it("defends against cross-season dates, invalid dates, other subject types and duplicate hits", async () => {
    const data = [subject(1, "2026-09-30"), subject(2, "2026-10-01"), subject(3, "2026-12-31"), subject(4, "2027-01-01"), subject(5, "2026-11-31"), subject(6, "2026-10"), subject(7, "2026-10-03", { type: 1 }), subject(2)];
    const result = await getSeasonDiscovery(autumn, { fetcher: fetchPage(data), storage: null });
    expect(result.items.map((item) => item.id)).toEqual(["bangumi:2", "bangumi:3"]);
    expect(result.total).toBe(8);
  });

  it("keeps year, quarter and page caches separate; fresh data expires after exactly thirty minutes", async () => {
    const storage = cache();
    await getSeasonDiscovery(autumn, { fetcher: fetchPage([subject(1)]), storage, now: () => timestamp });
    await getSeasonDiscovery(autumn, { page: 2, fetcher: fetchPage([subject(25)], 25, 24), storage, now: () => timestamp });
    await getSeasonDiscovery(winter, { fetcher: fetchPage([subject(100, "2027-01-01")]), storage, now: () => timestamp });
    expect(storage.values.size).toBe(3);
    const unused = vi.fn(offline);
    const fresh = await getSeasonDiscovery(autumn, { fetcher: unused, storage, now: () => timestamp + 30 * 60000 - 1 });
    expect(unused).not.toHaveBeenCalled();
    expect(fresh).toMatchObject({ cached: true, stale: false, updatedAt: "2026-10-30T04:00:00.000Z" });
    const load = fetchPage([subject(2)]);
    const expired = await getSeasonDiscovery(autumn, { fetcher: load, storage, now: () => timestamp + 30 * 60000 });
    expect(load).toHaveBeenCalledOnce();
    expect(expired.items[0].id).toBe("bangumi:2");
    expect(expired.cached).toBe(false);
  });

  it("refreshes on demand and reports the same season's original cache timestamp when offline", async () => {
    const storage = cache();
    await getSeasonDiscovery(autumn, { fetcher: fetchPage([subject(1)]), storage, now: () => timestamp });
    const load = vi.fn(offline);
    const fallback = await getSeasonDiscovery(autumn, { refresh: true, fetcher: load, storage, now: () => timestamp + 1000 });
    expect(load).toHaveBeenCalledOnce();
    expect(fallback).toMatchObject({ season: autumn, cached: true, stale: true, updatedAt: "2026-10-30T04:00:00.000Z" });
    expect(fallback.warning).toContain("缓存");
    await expect(getSeasonDiscovery(winter, { refresh: true, fetcher: offline, storage })).rejects.toThrow("offline");
    await expect(getSeasonDiscovery(autumn, { page: 2, fetcher: offline, storage })).rejects.toThrow("offline");
  });

  it("rejects cache contents from another season even when put under the requested key", async () => {
    const storage = cache();
    await getSeasonDiscovery(autumn, { fetcher: fetchPage([subject(1)]), storage, now: () => timestamp });
    const autumnEntry = [...storage.values.values()][0];
    const winterCache = cache();
    await getSeasonDiscovery(winter, { fetcher: fetchPage([subject(2, "2027-01-01")]), storage: winterCache, now: () => timestamp });
    winterCache.values.set([...winterCache.values.keys()][0], autumnEntry);
    await expect(getSeasonDiscovery(winter, { fetcher: offline, storage: winterCache, now: () => timestamp })).rejects.toThrow("offline");
  });

  it("bounds a fetcher that ignores AbortSignal and never returns a previous season on timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<JsonFetcher>(() => new Promise(() => undefined));
    const request = getSeasonDiscovery(autumn, { fetcher, storage: null, timeoutMs: 25 });
    const rejected = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(vi.mocked(fetcher).mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it("cancels an in-flight request instead of restoring its cached items", async () => {
    const storage = cache();
    await getSeasonDiscovery(autumn, { fetcher: fetchPage([subject(1)]), storage, now: () => timestamp });
    const controller = new AbortController();
    let captured: JsonRequestInit | undefined;
    const fetcher: JsonFetcher = async (_url, init) => { captured = init; return new Promise(() => undefined); };
    const request = getSeasonDiscovery(autumn, { refresh: true, signal: controller.signal, fetcher, storage });
    await Promise.resolve();
    controller.abort(new DOMException("Changed season", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError", message: "Changed season" });
    expect(captured?.signal?.aborted).toBe(true);
  });

  it("does not cache malformed, non-success or incorrectly paginated responses", async () => {
    const storage = cache();
    await expect(getSeasonDiscovery(autumn, { fetcher: async () => ({ status: 429, json: async () => ({}) }), storage })).rejects.toThrow("HTTP 429");
    await expect(getSeasonDiscovery(autumn, { fetcher: async () => ({ status: 200, json: async () => ({ data: [] }) }), storage })).rejects.toThrow("响应格式");
    await expect(getSeasonDiscovery(autumn, { page: 2, fetcher: async () => ({ status: 200, json: async () => ({ data: [subject(1)], total: 100, limit: 20, offset: 0 }) }), storage })).rejects.toThrow("响应格式");
    expect(storage.values.size).toBe(0);
  });

  it("works without persistent storage and validates arguments before any request", async () => {
    const brokenStorage = { getItem: () => { throw new Error("private mode"); }, setItem: () => { throw new Error("quota"); } };
    const fetcher = fetchPage([subject(1)]);
    await expect(getSeasonDiscovery(autumn, { fetcher, storage: brokenStorage })).resolves.toMatchObject({ cached: false });
    await expect(getSeasonDiscovery(autumn, { page: 0, fetcher, storage: null })).rejects.toThrow(RangeError);
    await expect(getSeasonDiscovery({ year: 2026, quarter: 5 } as never, { fetcher, storage: null })).rejects.toThrow(RangeError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
