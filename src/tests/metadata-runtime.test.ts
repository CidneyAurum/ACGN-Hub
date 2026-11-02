import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";
import { MinIntervalLimiter } from "@/infrastructure/metadata/rate-limiter";
import { BangumiProvider } from "@/infrastructure/metadata/bangumi-provider";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";
import { bangumiSearchFixture } from "@/tests/fixtures/bangumi";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("metadata request runtime", () => {
  it("accepts successful metadata responses without structuredClone in legacy WebViews", async () => {
    vi.stubGlobal("structuredClone", undefined);
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => bangumiSearchFixture });
    const provider = new BangumiProvider({ fetcher, minIntervalMs: 0 });
    const works = await provider.search({ keyword: "test" });
    expect(works.length).toBeGreaterThan(0);
    works[0].title = "caller change";
    expect((await provider.search({ keyword: "test" }))[0].title).not.toBe("caller change");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("spaces concurrently requested permits instead of releasing them together", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new MinIntervalLimiter(350);
    const starts: number[] = [];
    const waiting = Array.from({ length: 3 }, () => limiter.wait().then(() => { starts.push(Date.now()); }));
    await vi.runAllTimersAsync();
    await Promise.all(waiting);
    expect(starts).toEqual([0, 350, 700]);
  });

  it("coalesces simultaneous searches and protects the cached result from callers", async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => bangumiSearchFixture });
    const provider = new BangumiProvider({ fetcher, minIntervalMs: 0 });
    const [first, second] = await Promise.all([provider.search({ keyword: "test" }), provider.search({ keyword: "test" })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    first[0].title = "changed";
    expect(second[0].title).not.toBe("changed");
    expect((await provider.search({ keyword: "test" }))[0].title).not.toBe("changed");
  });

  it("expires and bounds the cache and does not repopulate it after clear", async () => {
    const cache = new MemoryCache(2);
    cache.set("a", 1, 10, 0);
    expect(cache.get("a", 10)).toBeUndefined();
    cache.set("a", 1, 100, 0);
    cache.set("b", 2, 100, 0);
    cache.get("a", 1);
    cache.set("c", 3, 100, 1);
    expect(cache.get("b", 1)).toBeUndefined();
    let resolve!: (value: number) => void;
    const loading = cache.getOrLoad("pending", 10000, () => new Promise<number>((done) => { resolve = done; }));
    await Promise.resolve();
    cache.clear();
    resolve(5);
    await loading;
    expect(cache.get("pending")).toBeUndefined();
  });

  it("reports malformed successful JSON without retrying it as a network failure", async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => { throw new SyntaxError("bad JSON"); } });
    const provider = new BangumiProvider({ fetcher, minIntervalMs: 0, sleep: async () => {} });
    await expect(provider.search({ keyword: "test" })).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("distinguishes denied access from network errors", async () => {
    const provider = new BangumiProvider({ fetcher: async () => ({ status: 403, json: async () => ({}) }), minIntervalMs: 0 });
    await expect(provider.search({ keyword: "test" })).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("honors cancellation before starting an IPC request", async () => {
    const controller = new AbortController();
    const invoke = vi.fn();
    controller.abort();
    await expect(abortableRequest(invoke, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
