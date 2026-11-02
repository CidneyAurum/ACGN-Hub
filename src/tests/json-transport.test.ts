import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriJsonFetcher } from "@/infrastructure/metadata/json-transport";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); invoke.mockReset(); });

function legacyAbortSignals(): void {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout");
  vi.spyOn(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
}

describe("native metadata JSON transport", () => {
  it("bounds a stuck native request without requiring a caller signal", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    invoke.mockImplementation(() => new Promise(() => undefined));
    let failure: unknown;
    let settled = false;
    const request = tauriJsonFetcher("https://api.bgm.tv/calendar", { method: "GET" }).catch((cause) => { failure = cause; }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);
    expect(failure).toMatchObject({ name: "TimeoutError" });
    await request;
  });

  it.each([
    [-1, 500], [501.9, 501], [99_000, 35_000], [NaN, 10_000], [Infinity, 10_000], [undefined, 10_000],
  ])("bounds a caller signal by the normalized timeout %s → %d", async (timeoutMs, expected) => {
    legacyAbortSignals();
    const caller = new AbortController();
    invoke.mockImplementation(() => new Promise(() => undefined));
    const completed = tauriJsonFetcher("https://api.bgm.tv/calendar", { timeoutMs, signal: caller.signal })
      .then(() => undefined, (cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(expected - 1);
    expect(invoke).toHaveBeenCalledWith("metadata_json_request", expect.objectContaining({ timeoutMs: expected }));
    let settled = false;
    void completed.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await completed).toMatchObject({ name: "TimeoutError" });
    expect(caller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invoke an already-cancelled request and retains a non-Error reason", async () => {
    legacyAbortSignals();
    const caller = new AbortController();
    const reason = { code: "USER_LEFT_VIEW" };
    caller.abort(reason);
    await expect(tauriJsonFetcher("https://api.bgm.tv/calendar", { signal: caller.signal })).rejects.toBe(reason);
    expect(invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases fallback timers and caller listeners after cancellation, even with a late IPC response", async () => {
    legacyAbortSignals();
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const reason = "user cancelled before reply";
    const rejected = expect(tauriJsonFetcher("https://api.bgm.tv/calendar", { signal: caller.signal })).rejects.toBe(reason);
    await Promise.resolve();
    caller.abort(reason);
    await rejected;
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
    finish({ status: 200, body: { ignored: true } });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns successful JSON and releases fallback resources without aborting its caller", async () => {
    legacyAbortSignals();
    const caller = new AbortController();
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    invoke.mockResolvedValue({ status: 201, body: { items: [{ title: "result" }] } });
    const response = await tauriJsonFetcher("https://api.bgm.tv/v0/search/subjects", {
      method: "POST", headers: { Accept: "application/json" }, body: JSON.stringify({ keyword: "test" }), signal: caller.signal,
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ items: [{ title: "result" }] });
    expect(invoke).toHaveBeenCalledWith("metadata_json_request", {
      url: "https://api.bgm.tv/v0/search/subjects", method: "POST", headers: { accept: "application/json" }, body: { keyword: "test" }, timeoutMs: 10_000,
    });
    expect(caller.signal.aborted).toBe(false);
    expect(removed).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves native string errors and cleans fallback resources on rejection", async () => {
    legacyAbortSignals();
    invoke.mockRejectedValue("[NETWORK_TLS] HTTPS certificate failed");
    await expect(tauriJsonFetcher("https://api.bgm.tv/calendar", {})).rejects.toBe("[NETWORK_TLS] HTTPS certificate failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
