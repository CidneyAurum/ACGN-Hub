import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonFetcher, JsonRequestInit } from "@/infrastructure/metadata/json-transport";
import { classifyDiscoveryBookSubject, getBookDiscovery } from "@/infrastructure/metadata/book-discovery-provider";

const timestamp = Date.parse("2026-10-30T04:00:00.000Z");
function cache() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function subject(id: number, extra: Record<string, unknown> = {}) {
  return { id, type: 1, name: `Original ${id}`, name_cn: `漫画 ${id}`, platform: "漫画", date: "2026-02-18", nsfw: false,
    tags: [{ name: "漫画", count: 120 }], summary: "来源简介", images: { large: "http://lain.bgm.tv/pic/cover/l/genuine.jpg" },
    rating: { score: 7.8, total: 548 }, collection: { doing: 971, wish: 555, collect: 189, on_hold: 24, dropped: 5 }, ...extra };
}
function novel(id: number, extra: Record<string, unknown> = {}) { return subject(id, { name_cn: `轻小说 ${id}`, platform: "小说", tags: [{ name: "轻小说", count: 61 }, { name: "漫画", count: 4 }], ...extra }); }
function fetchPage(data: unknown[], total = data.length, baseOffset = 0): JsonFetcher {
  return vi.fn(async (url) => {
    const params = new URL(url).searchParams;
    const limit = Math.min(20, Number(params.get("limit")));
    const offset = Number(params.get("offset"));
    return { status: 200, json: async () => ({ data: data.slice(offset - baseOffset, offset - baseOffset + limit), total, limit, offset }) };
  });
}
const offline: JsonFetcher = async () => { throw new Error("offline"); };

describe("real book discovery", () => {
  afterEach(() => vi.useRealTimers());

  it("loads genuine comic covers and metadata with the exact public category filter", async () => {
    const fetcher = fetchPage(Array.from({ length: 24 }, (_, index) => subject(index + 1)), 61);
    const result = await getBookDiscovery("manga", { fetcher, storage: null, now: () => timestamp });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe("https://api.bgm.tv/v0/search/subjects?limit=20&offset=0");
    expect(JSON.parse(String(init.body))).toEqual({ keyword: "", sort: "heat", filter: { type: [1], tag: ["漫画"], nsfw: false } });
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(result).toMatchObject({ type: "manga", sort: "heat", total: 61, page: 1, pageSize: 24, hasMore: true, cached: false, stale: false, updatedAt: "2026-10-30T04:00:00.000Z" });
    expect(result.items).toHaveLength(24);
    expect(result.items[0]).toMatchObject({ id: "bangumi:1", type: "manga", title: "漫画 1", originalTitle: "Original 1", coverUrl: "https://lain.bgm.tv/pic/cover/l/genuine.jpg", releaseYear: 2026, metadata: { rating: 7.8, voteCount: 548, collectionCount: 1744 } });
  });

  it("classifies official platforms before cross-medium tags and requires explicit light-novel identity", () => {
    expect(classifyDiscoveryBookSubject(novel(613150))).toBe("novel");
    expect(classifyDiscoveryBookSubject(subject(10, { tags: [{ name: "轻小说" }] }))).toBe("manga");
    expect(classifyDiscoveryBookSubject(subject(10, { platform: "小说", tags: [{ name: "小说" }] }))).toBeUndefined();
    expect(classifyDiscoveryBookSubject({ platform: "画集", tags: [{ name: "漫画" }] })).toBeUndefined();
    expect(classifyDiscoveryBookSubject({ tags: [{ name: "漫画" }, { name: "轻小说" }] })).toBeUndefined();
    expect(classifyDiscoveryBookSubject({ meta_tags: ["輕小說"] })).toBe("novel");
    expect(classifyDiscoveryBookSubject({ platform: "manga", tags: [{ name: "ライトノベル" }] })).toBe("manga");
    expect(classifyDiscoveryBookSubject({ platform: "小说", summary: "漫画 轻小说" } as never)).toBeUndefined();
  });

  it("omits wrong categories, R18, missing covers, malformed subjects and duplicates without losing valid books", async () => {
    const result = await getBookDiscovery("manga", { storage: null, fetcher: fetchPage([
      subject(1), novel(2), subject(3, { nsfw: true }), subject(4, { tags: [{ name: "R-18" }] }),
      subject(5, { images: null }), subject(6, { images: { large: "javascript:alert(1)" } }),
      subject(7, { images: { large: "https://lain.bgm.tv/img/no_icon_subject.png" } }),
      subject(8, { type: 2 }), subject(9, { name: "  " }), subject(1), null, { id: "broken" },
      subject(10, { images: { large: "invalid", medium: "https://lain.bgm.tv/pic/cover/actual.jpg" } }),
    ]) });
    expect(result.items.map((item) => item.id)).toEqual(["bangumi:1", "bangumi:10"]);
    expect(result.total).toBe(13);
  });

  it("keeps novels as light novels and never invents missing dates or scores", async () => {
    const fetcher = fetchPage([novel(1, { date: null, rating: { score: 0, total: 0 } }), subject(2), novel(3, { tags: [{ name: "小说" }] })]);
    const result = await getBookDiscovery("novel", { storage: null, fetcher });
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1].body)).filter.tag).toEqual(["轻小说"]);
    expect(result.items.map((item) => item.id)).toEqual(["bangumi:1"]);
    expect(result.items[0].type).toBe("novel");
    expect(result.items[0].releaseYear).toBeUndefined();
    expect(result.items[0].metadata.rating).toBeUndefined();
  });

  it("ignores isolated reader joke tags on ordinary literature while retaining credible light novels", async () => {
    const result = await getBookDiscovery("novel", { storage: null, fetcher: fetchPage([
      novel(352515, { name_cn: "罪与罚", meta_tags: ["小说", "名著"], tags: [{ name: "陀思妥耶夫斯基", count: 145 }, { name: "小说", count: 91 }, { name: "轻小说", count: 1 }] }),
      novel(2, { tags: [{ name: "轻小说", count: 70 }, { name: "作者", count: 200 }] }),
      novel(3, { meta_tags: ["轻小说"], tags: [{ name: "作者", count: 100 }, { name: "轻小说", count: 1 }] }),
    ]) });
    expect(result.items.map((item) => item.id)).toEqual(["bangumi:2", "bangumi:3"]);
  });

  it("uses upstream score sorting with at least 50 votes and enforces the threshold on responses", async () => {
    const fetcher = fetchPage([subject(1), subject(2, { rating: { score: 10, total: 1 } }), subject(3, { rating: { score: 9, total: 49 } }), subject(4, { rating: { score: 8.5, total: 50 } })]);
    const result = await getBookDiscovery("manga", { sort: "score", storage: null, fetcher });
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1].body))).toMatchObject({ sort: "score", filter: { rating_count: [">=50"] } });
    expect(result.items.map((item) => item.id)).toEqual(["bangumi:1", "bangumi:4"]);
  });

  it("defines recent as past-year releases ordered by heat, validating dates and excluding future releases", async () => {
    const fetcher = fetchPage([subject(1, { date: "2025-10-29" }), subject(2, { date: "2025-10-30" }), subject(3, { date: "2026-10-30" }), subject(4, { date: "2026-10-31" }), subject(5, { date: "2026-02-31" }), subject(6, { date: null })]);
    const result = await getBookDiscovery("manga", { sort: "recent", fetcher, storage: null, now: () => timestamp });
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1].body))).toMatchObject({ sort: "heat", filter: { air_date: [">=2025-10-30", "<2026-10-31"] } });
    expect(result.items.map((item) => item.id)).toEqual(["bangumi:2", "bangumi:3"]);
    expect(result.sort).toBe("recent");
  });

  it("pages through the API's 20-hit cap as 24 + 24 + 1 without skipping or repeating positions", async () => {
    const fetcher = fetchPage(Array.from({ length: 49 }, (_, index) => subject(index + 1)));
    const pages = [];
    for (const page of [1, 2, 3]) pages.push(await getBookDiscovery("manga", { page, fetcher, storage: null }));
    expect(pages.map((page) => page.items.length)).toEqual([24, 24, 1]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(Array.from({ length: 49 }, (_, index) => `bangumi:${index + 1}`));
    expect(vi.mocked(fetcher).mock.calls.map(([url]) => new URL(url).search)).toEqual(["?limit=20&offset=0", "?limit=4&offset=20", "?limit=20&offset=24", "?limit=4&offset=44", "?limit=20&offset=48"]);
  });

  it("separates category, order and page caches and expires exactly after thirty minutes", async () => {
    const storage = cache();
    await getBookDiscovery("manga", { storage, fetcher: fetchPage([subject(1)]), now: () => timestamp });
    await getBookDiscovery("manga", { sort: "score", storage, fetcher: fetchPage([subject(2)]), now: () => timestamp });
    await getBookDiscovery("manga", { page: 2, storage, fetcher: fetchPage([subject(25)], 25, 24), now: () => timestamp });
    await getBookDiscovery("novel", { storage, fetcher: fetchPage([novel(9)]), now: () => timestamp });
    expect(storage.values.size).toBe(4);
    const unused = vi.fn(offline);
    const cached = await getBookDiscovery("manga", { storage, fetcher: unused, now: () => timestamp + 30 * 60000 - 1 });
    expect(cached).toMatchObject({ cached: true, stale: false });
    expect(cached.items[0].id).toBe("bangumi:1");
    expect(unused).not.toHaveBeenCalled();
    const fresh = await getBookDiscovery("manga", { storage, fetcher: fetchPage([subject(3)]), now: () => timestamp + 30 * 60000 });
    expect(fresh.cached).toBe(false);
    expect(fresh.items[0].id).toBe("bangumi:3");
  });

  it("refreshes on demand and falls back only to the same list with its original timestamp", async () => {
    const storage = cache();
    await getBookDiscovery("manga", { storage, fetcher: fetchPage([subject(1)]), now: () => timestamp });
    const fetcher = vi.fn(offline);
    const result = await getBookDiscovery("manga", { storage, fetcher, refresh: true, now: () => timestamp + 1000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ cached: true, stale: true, updatedAt: "2026-10-30T04:00:00.000Z" });
    expect(result.warning).toContain("缓存");
    await expect(getBookDiscovery("novel", { storage, fetcher: offline })).rejects.toThrow("offline");
    await expect(getBookDiscovery("manga", { sort: "score", storage, fetcher: offline })).rejects.toThrow("offline");
    await expect(getBookDiscovery("manga", { page: 2, storage, fetcher: offline })).rejects.toThrow("offline");
  });

  it("rejects copied or damaged cache categories instead of rendering mismatched cards", async () => {
    const storage = cache();
    await getBookDiscovery("manga", { storage, fetcher: fetchPage([subject(1)]), now: () => timestamp });
    await getBookDiscovery("novel", { storage, fetcher: fetchPage([novel(2)]), now: () => timestamp });
    const mangaKey = [...storage.values.keys()].find((key) => key.includes(":manga:"))!;
    const novelKey = [...storage.values.keys()].find((key) => key.includes(":novel:"))!;
    storage.values.set(novelKey, storage.values.get(mangaKey)!);
    await expect(getBookDiscovery("novel", { storage, fetcher: offline, now: () => timestamp })).rejects.toThrow("offline");
    const broken = JSON.parse(storage.values.get(mangaKey)!);
    broken.items[0].metadata.raw.nsfw = true;
    storage.values.set(mangaKey, JSON.stringify(broken));
    await expect(getBookDiscovery("manga", { storage, fetcher: offline, now: () => timestamp })).rejects.toThrow("offline");
  });

  it("retries transient HTTP failures once while preserving the same requested position", async () => {
    const success = fetchPage([subject(1)]);
    let attempts = 0;
    const fetcher: JsonFetcher = vi.fn(async (url, init) => ++attempts === 1 ? { status: 503, json: async () => ({}) } : success(url, init));
    const result = await getBookDiscovery("manga", { fetcher, storage: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetcher).mock.calls[0][0]).toBe(vi.mocked(fetcher).mock.calls[1][0]);
    expect(result.items[0].id).toBe("bangumi:1");
    const denied = vi.fn<JsonFetcher>(async () => ({ status: 403, json: async () => ({}) }));
    await expect(getBookDiscovery("manga", { fetcher: denied, storage: null })).rejects.toThrow("HTTP 403");
    expect(denied).toHaveBeenCalledOnce();
  });

  it("cancels ignored-signal requests without restoring cached results or writing a late response", async () => {
    const storage = cache();
    await getBookDiscovery("manga", { storage, fetcher: fetchPage([subject(1)]), now: () => timestamp });
    const originalCache = [...storage.values.values()];
    const controller = new AbortController();
    let captured: JsonRequestInit | undefined;
    let resolveLate: ((value: Awaited<ReturnType<JsonFetcher>>) => void) | undefined;
    const fetcher: JsonFetcher = async (_url, init) => { captured = init; return new Promise((resolve) => { resolveLate = resolve; }); };
    const request = getBookDiscovery("manga", { refresh: true, storage, fetcher, signal: controller.signal });
    await Promise.resolve();
    controller.abort(new DOMException("Changed category", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError", message: "Changed category" });
    expect(captured?.signal?.aborted).toBe(true);
    resolveLate!({ status: 200, json: async () => ({ data: [subject(9)], total: 1, limit: 20, offset: 0 }) });
    await Promise.resolve();
    expect([...storage.values.values()]).toEqual(originalCache);
  });

  it("bounds an unresponsive transport and aborts an in-progress retry delay", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<JsonFetcher>(() => new Promise(() => undefined));
    const request = getBookDiscovery("manga", { fetcher, storage: null, timeoutMs: 25 });
    const rejected = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    const failed = vi.fn(offline);
    const controller = new AbortController();
    const retrying = getBookDiscovery("manga", { fetcher: failed, storage: null, signal: controller.signal });
    const cancelled = expect(retrying).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await cancelled;
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed).toHaveBeenCalledOnce();
  });

  it("rejects invalid arguments and broken pagination without caching unusable responses", async () => {
    const storage = cache();
    const malformed = vi.fn<JsonFetcher>(async () => ({ status: 200, json: async () => ({ data: [] }) }));
    await expect(getBookDiscovery("manga", { fetcher: malformed, storage })).rejects.toThrow("响应格式");
    expect(malformed).toHaveBeenCalledOnce();
    await expect(getBookDiscovery("manga", { page: 2, storage, fetcher: async () => ({ status: 200, json: async () => ({ data: [subject(1)], total: 90, limit: 20, offset: 0 }) }) })).rejects.toThrow("响应格式");
    for (const options of [{ page: 0 }, { page: 1.5 }, { timeoutMs: NaN }, { timeoutMs: 0 }, { sort: "rank" as never }]) {
      await expect(getBookDiscovery("manga", { ...options, fetcher: malformed, storage })).rejects.toThrow(RangeError);
    }
    await expect(getBookDiscovery("anime" as never, { fetcher: malformed, storage })).rejects.toThrow(RangeError);
    expect(storage.values.size).toBe(0);
  });

  it("keeps discovery usable when storage is unavailable or full", async () => {
    const storage = { getItem: () => { throw new Error("private mode"); }, setItem: () => { throw new Error("quota"); } };
    await expect(getBookDiscovery("manga", { fetcher: fetchPage([subject(1)]), storage })).resolves.toMatchObject({ cached: false, stale: false });
  });
});
