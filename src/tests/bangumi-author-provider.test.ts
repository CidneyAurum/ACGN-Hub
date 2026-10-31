import { describe, expect, it, vi } from "vitest";
import { BangumiAuthorProvider } from "@/infrastructure/metadata/bangumi-author-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

const person = {
  id: 6207, name: "入間人間", images: { large: "http://lain.bgm.tv/person.jpg" }, summary: "日本轻小说作家。",
  infobox: [{ key: "简体中文名", value: "入间人间" }, { key: "别名", value: [{ v: "Iruma Hitoma" }, { v: "入间人间" }] }],
};
const relation = (id: number, extra: Record<string, unknown> = {}) => ({ id, type: 1, name: `Original ${id}`, name_cn: `作品 ${id}`, staff: "作者", image: "https://lain.bgm.tv/cover.jpg", ...extra });
const subject = (id: number, extra: Record<string, unknown> = {}) => ({ id, type: 1, name: `Original ${id}`, name_cn: `作品 ${id}`, platform: "小说", tags: [{ name: "轻小说" }], rating: { score: 8.2, total: 100 }, date: "2025-06-01", ...extra });
const response = (body: unknown, status = 200) => ({ status, json: async () => body });
function setup(related: unknown[], details: Record<string, unknown> = {}) {
  const fetcher = vi.fn<JsonFetcher>(async (url) => {
    if (url.includes("/search/persons")) return response({ data: [person], total: 1, limit: 20, offset: 0 });
    if (url.endsWith("/persons/6207/subjects")) return response(related);
    if (url.endsWith("/persons/6207")) return response(person);
    const id = /\/subjects\/(\d+)$/.exec(url)?.[1];
    return id && details[id] ? response(details[id]) : response({}, 404);
  });
  return { fetcher, provider: new BangumiAuthorProvider({ fetcher, minIntervalMs: 0, maxRetries: 0 }) };
}

describe("Bangumi author search", () => {
  it("uses the official experimental people POST rather than a title search, with anonymous headers", async () => {
    const { fetcher, provider } = setup([]);
    await expect(provider.searchPeople(" 入间人间 ")).resolves.toEqual([{
      id: "6207", name: "入間人間", aliases: ["入间人间", "Iruma Hitoma"], imageUrl: "https://lain.bgm.tv/person.jpg", summary: "日本轻小说作家。",
    }]);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.bgm.tv/v0/search/persons?limit=20&offset=0");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ keyword: "入间人间" });
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });

  it("supports the documented short_summary response while retaining the original person's name", async () => {
    const fetcher = vi.fn<JsonFetcher>(async () => response({ data: [{ id: 39, name: "CLAMP", short_summary: "漫画创作组合", images: null }], total: 1, limit: 20, offset: 0 }));
    await expect(new BangumiAuthorProvider({ fetcher, minIntervalMs: 0 }).searchPeople("CLAMP")).resolves.toEqual([{ id: "39", name: "CLAMP", aliases: [], summary: "漫画创作组合" }]);
  });

  it("rejects malformed person containers and pagination instead of returning a false empty state", async () => {
    for (const body of [{ data: [] }, { data: [{ id: 1, name: "" }], total: 1, limit: 20, offset: 0 },
      { data: [], total: 0, limit: 20, offset: 20 }, { data: [], total: 0, limit: 21, offset: 0 }]) {
      const provider = new BangumiAuthorProvider({ fetcher: async () => response(body), minIntervalMs: 0 });
      await expect(provider.searchPeople("作者")).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("caches real people without allowing callers to mutate later searches", async () => {
    const { provider, fetcher } = setup([]);
    const authors = await provider.searchPeople("入间人间");
    authors[0].name = "changed";
    expect((await provider.searchPeople("入间人间"))[0].name).toBe("入間人間");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("loads official related works and merges multiple participation roles before paging", async () => {
    const { provider, fetcher } = setup([
      relation(101, { type: 2, staff: "原作", name_cn: "安达与岛村" }),
      relation(101, { type: 2, staff: "脚本" }), relation(101, { type: 2, staff: "原作" }),
      relation(102, { type: 2, staff: "原作" }), relation(103, { type: 2 }), relation(1),
    ]);
    const first = await provider.listWorks("6207", "anime", { pageSize: 2 });
    expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2, hasMore: true });
    expect(first.items.map((work) => work.id)).toEqual(["bangumi:101", "bangumi:102"]);
    expect(first.items[0]).toMatchObject({ title: "安达与岛村", type: "anime", metadata: { authorId: "6207", authorName: "入間人間", authorRole: "原作 / 脚本", authorRelation: "原作 / 脚本" } });
    const second = await provider.listWorks("bangumi:person:6207", "anime", { page: 2, pageSize: 2 });
    expect(second).toMatchObject({ hasMore: false, total: 3 });
    expect(second.items.map((work) => work.id)).toEqual(["bangumi:103"]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://api.bgm.tv/v0/persons/6207", "https://api.bgm.tv/v0/persons/6207/subjects"]);
  });

  it("uses a searched person's exact ID and caches their name, never ranking works against the author's keyword", async () => {
    const { provider, fetcher } = setup([relation(1)], { 1: subject(1, { name_cn: "安达与岛村" }) });
    await provider.searchPeople("入间人间");
    const result = await provider.listWorks("6207", "novel");
    expect(result.items[0]).toMatchObject({ title: "安达与岛村", metadata: { authorName: "入間人間" } });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/persons/6207"))).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => url.includes("/search/subjects"))).toBe(false);
  });

  it("classifies manga and novels using platform before adaptation tags and omits unclassified or NSFW books", async () => {
    const { provider, fetcher } = setup([relation(1), relation(2), relation(3), relation(4)], {
      1: subject(1), 2: subject(2, { platform: "漫画", tags: [{ name: "轻小说" }] }),
      3: subject(3, { platform: "画集", tags: [{ name: "漫画" }] }), 4: subject(4, { nsfw: true }),
    });
    const novels = await provider.listWorks("6207", "novel");
    const manga = await provider.listWorks("6207", "manga");
    expect(novels.items.map((work) => work.id)).toEqual(["bangumi:1"]);
    expect(manga.items.map((work) => work.id)).toEqual(["bangumi:2"]);
    expect(novels.total).toBeUndefined();
    expect(manga.items[0]).toMatchObject({ releaseYear: 2025, metadata: { rating: 8.2, ratingCount: 100 } });
    // Both book categories reuse the fetched classifications.
    expect(fetcher.mock.calls.filter(([url]) => /\/subjects\/\d+$/.test(url))).toHaveLength(4);
  });

  it("retains pagination after a book candidate page filters to zero matches", async () => {
    const { provider } = setup([relation(1), relation(2), relation(3)], { 1: subject(1), 2: subject(2), 3: subject(3, { platform: "漫画" }) });
    await expect(provider.listWorks("6207", "manga", { pageSize: 2 })).resolves.toMatchObject({ items: [], hasMore: true, page: 1 });
    const next = await provider.listWorks("6207", "manga", { page: 2, pageSize: 2 });
    expect(next.items.map((work) => work.id)).toEqual(["bangumi:3"]);
    expect(next.hasMore).toBe(false);
  });

  it("bounds work-detail concurrency at three and requests only the current candidate page", async () => {
    let active = 0; let maximum = 0; const loaded: number[] = [];
    const fetcher = vi.fn<JsonFetcher>(async (url) => {
      if (url.endsWith("/persons/6207")) return response(person);
      if (url.endsWith("/subjects")) return response(Array.from({ length: 30 }, (_, index) => relation(index + 1)));
      const id = Number(/\/subjects\/(\d+)$/.exec(url)![1]);
      active += 1; maximum = Math.max(maximum, active); loaded.push(id);
      await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1;
      return response(subject(id));
    });
    const provider = new BangumiAuthorProvider({ fetcher, minIntervalMs: 0, maxRetries: 0 });
    const result = await provider.listWorks("6207", "novel");
    expect(maximum).toBe(3);
    expect(loaded).toHaveLength(20);
    expect(result).toMatchObject({ hasMore: true, pageSize: 20 });
    expect(result.items.map((work) => work.id)).toEqual(Array.from({ length: 20 }, (_, index) => `bangumi:${index + 1}`));
  });

  it("reports partially failed details and rejects fully unavailable pages", async () => {
    const { provider } = setup([relation(1), relation(2)], { 1: subject(1) });
    const result = await provider.listWorks("6207", "novel");
    expect(result.items).toHaveLength(1);
    expect(result.warning).toContain("1 部");
    const broken = setup([relation(1)]).provider;
    await expect(broken.listWorks("6207", "novel")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("rejects related-response schema changes and mismatched subject identities", async () => {
    const invalid = setup([{ id: 1, type: 1, name: "Book", relation: "作者" }]).provider;
    await expect(invalid.listWorks("6207", "novel")).rejects.toMatchObject({ code: "invalid_response" });
    const mismatch = setup([relation(1)], { 1: subject(99) }).provider;
    await expect(mismatch.listWorks("6207", "novel")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("does not silently substitute a title search when the people API fails", async () => {
    const fetcher = vi.fn<JsonFetcher>(async () => response({}, 403));
    const provider = new BangumiAuthorProvider({ fetcher, minIntervalMs: 0 });
    await expect(provider.searchPeople("作者")).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toContain("/search/persons");
  });

  it("retries rate limits once with the same operation and returns valid empty people results", async () => {
    let count = 0;
    const fetcher = vi.fn<JsonFetcher>(async () => ++count === 1 ? response({}, 429) : response({ data: [], total: 0, limit: 20, offset: 0 }));
    const provider = new BangumiAuthorProvider({ fetcher, minIntervalMs: 0, sleep: async () => undefined });
    await expect(provider.searchPeople("不存在的作者")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
  });

  it("cancels an ignored-signal transport and never stores its late people response", async () => {
    let finish: ((value: ReturnType<typeof response>) => void) | undefined;
    const fetcher = vi.fn<JsonFetcher>(async () => new Promise((resolve) => { finish = resolve; }));
    const provider = new BangumiAuthorProvider({ fetcher, minIntervalMs: 0 });
    const controller = new AbortController();
    const pending = provider.searchPeople("入间人间", { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Changed mode", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Changed mode" });
    finish!({ status: 200, json: async () => ({ data: [person], total: 1, limit: 20, offset: 0 }) });
    await Promise.resolve();
    fetcher.mockResolvedValue(response({ data: [], total: 0, limit: 20, offset: 0 }));
    await expect(provider.searchPeople("入间人间")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not start requests for invalid input, unsupported Galgames or a cancelled caller", async () => {
    const { provider, fetcher } = setup([]);
    await expect(provider.searchPeople(" ")).rejects.toMatchObject({ code: "bad_request" });
    for (const id of ["0", "-1", "6207/path", "6207?q=1", "9007199254740993"]) await expect(provider.listWorks(id, "anime")).rejects.toMatchObject({ code: "bad_request" });
    for (const options of [{ page: 0 }, { page: 1.2 }, { pageSize: 21 }, { pageSize: 0 }, { page: Infinity }]) await expect(provider.listWorks("6207", "anime", options)).rejects.toMatchObject({ code: "bad_request" });
    await expect(provider.listWorks("6207", "visual_novel")).resolves.toMatchObject({ items: [], hasMore: false, total: 0 });
    const controller = new AbortController(); controller.abort();
    await expect(provider.searchPeople("作者", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(provider.listWorks("6207", "anime", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds an unresponsive transport with an explicit timeout instead of hanging the author page", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<JsonFetcher>(() => new Promise(() => undefined));
      const provider = new BangumiAuthorProvider({ fetcher, minIntervalMs: 0, maxRetries: 0, timeoutMs: 500 });
      const pending = provider.searchPeople("作者");
      const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
      expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("cancels all pending book lookups without scheduling the rest of the candidate page", async () => {
    const pendingSignals: AbortSignal[] = [];
    const fetcher = vi.fn<JsonFetcher>(async (url, init) => {
      if (url.endsWith("/persons/6207")) return response(person);
      if (url.endsWith("/subjects")) return response(Array.from({ length: 20 }, (_, index) => relation(index + 1)));
      pendingSignals.push(init.signal!);
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const provider = new BangumiAuthorProvider({ fetcher, minIntervalMs: 0, maxRetries: 0 });
    const pending = provider.listWorks("6207", "novel", { signal: controller.signal });
    await vi.waitFor(() => expect(pendingSignals).toHaveLength(3));
    controller.abort(new DOMException("Changed category", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Changed category" });
    expect(pendingSignals.every((signal) => signal.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
