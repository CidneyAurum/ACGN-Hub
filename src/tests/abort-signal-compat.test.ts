import { afterEach, describe, expect, it, vi } from "vitest";
import { RssAtomProvider } from "@/infrastructure/feeds/rss-atom-provider";
import { BangumiProvider } from "@/infrastructure/metadata/bangumi-provider";
import { rssFixture } from "@/tests/fixtures/feeds";
import { anySignal, disposeAbortSignal, throwIfAborted, timeoutSignal } from "@/shared/abort-signals";
import { KUNGalgameSourceProvider } from "@/infrastructure/sources/kungal-source-provider";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function oldWebView(): void {
  class LegacyAbortSignal extends AbortSignal {}
  Object.defineProperty(LegacyAbortSignal, "timeout", { value: undefined });
  Object.defineProperty(LegacyAbortSignal, "any", { value: undefined });
  vi.stubGlobal("AbortSignal", LegacyAbortSignal);
}

describe("old WebView network compatibility", () => {
  it("reads an actual RSS provider when AbortSignal.timeout and any are absent", async () => {
    oldWebView();
    const fetcher = vi.fn(async () => ({ status: 200, text: async () => rssFixture }));
    const provider = new RssAtomProvider({ fetcher, minIntervalMs: 0, maxRetries: 0 });
    await expect(provider.read("https://example.com/feed.xml")).resolves.toMatchObject({ format: "rss2" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("searches actual Bangumi metadata before the transport when static abort helpers are absent", async () => {
    oldWebView();
    const fetcher = vi.fn(async () => ({ status: 200, json: async () => ({ total: 1, limit: 20, offset: 0, data: [{ id: 1, type: 2, name: "Anime fixture" }] }) }));
    const provider = new BangumiProvider({ fetcher, minIntervalMs: 0, maxRetries: 0 });
    await expect(provider.search({ keyword: "Anime", type: "anime" })).resolves.toMatchObject([{ title: "Anime fixture" }]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("continues to use native helpers when they exist", () => {
    const controller = new AbortController();
    const nativeTimeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const nativeAny = vi.spyOn(AbortSignal, "any").mockReturnValue(controller.signal);
    expect(timeoutSignal(123)).toBe(controller.signal);
    expect(anySignal([controller.signal])).toBe(controller.signal);
    expect(nativeTimeout).toHaveBeenCalledWith(123);
    expect(nativeAny).toHaveBeenCalledWith([controller.signal]);
  });

  it("times out a real stalled RSS request in an old WebView", async () => {
    oldWebView(); vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<never>(() => undefined));
    const provider = new RssAtomProvider({ fetcher, minIntervalMs: 0, maxRetries: 0, timeoutMs: 30 });
    const rejection = expect(provider.read("https://example.com/feed.xml")).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a real source request with its original reason and cleans combined listeners and timers", async () => {
    oldWebView(); vi.useFakeTimers();
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new DOMException("user changed source", "AbortError");
    const fetcher = vi.fn(() => new Promise<never>(() => undefined));
    const source = new KUNGalgameSourceProvider(undefined, { fetcher, signal: controller.signal, timeoutMs: 500 });
    const rejection = expect(source.search({ keyword: "AIR", aliases: [], mediaType: "visual_novel" })).rejects.toBe(reason);
    await Promise.resolve();
    controller.abort(reason);
    await rejection;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(() => throwIfAborted(controller.signal)).toThrow(reason);
  });

  it("keeps first-aborted ordering and allows early disposal of fallback resources", () => {
    oldWebView(); vi.useFakeTimers();
    const first = new AbortController(); const second = new AbortController();
    first.abort("first"); second.abort("second");
    expect(anySignal([first.signal, second.signal]).reason).toBe("first");
    const live = new AbortController();
    const remove = vi.spyOn(live.signal, "removeEventListener");
    const timeout = timeoutSignal(500);
    const combined = anySignal([live.signal, timeout]);
    disposeAbortSignal(combined); disposeAbortSignal(timeout);
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(live.signal.aborted).toBe(false);
  });
});
