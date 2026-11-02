import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriTextFetcher } from "@/infrastructure/feeds/text-transport";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("native feed text transport", () => {
  afterEach(() => { vi.restoreAllMocks(); invoke.mockReset(); });

  it("bounds an IPC call without relying on the caller to supply a signal", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    invoke.mockImplementation(() => new Promise(() => undefined));
    const rejection = expect(tauriTextFetcher("https://mikanani.me/RSS/Classic")).rejects.toMatchObject({ name: "TimeoutError" });
    await Promise.resolve();
    controller.abort(new DOMException("timed out", "TimeoutError"));
    await rejection;
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(invoke).toHaveBeenCalledWith("feed_text_request", expect.objectContaining({ timeoutMs: 10_000 }));
  });

  it("retains explicit caller cancellation and does not invoke the native request", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(tauriTextFetcher("https://example.com/feed.xml", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the structured native error prefix intact for provider classification", async () => {
    invoke.mockRejectedValue("[NETWORK_TLS] HTTPS certificate failed (mikanani.me)");
    await expect(tauriTextFetcher("https://mikanani.me/RSS/Classic")).rejects.toBe("[NETWORK_TLS] HTTPS certificate failed (mikanani.me)");
  });
});
