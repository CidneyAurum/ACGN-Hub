import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings } from "@/shared/settings";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

describe("settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads bounded download scheduling settings", () => {
    const storage = new MemoryStorage();
    storage.setItem("acgn-hub.settings.v1", JSON.stringify({ maxConcurrentDownloads: 99, speedLimitBytesPerSecond: -1, pollIntervalMs: 100 }));
    vi.stubGlobal("localStorage", storage);

    expect(loadSettings()).toMatchObject({ maxConcurrentDownloads: 20, speedLimitBytesPerSecond: 0, pollIntervalMs: 1000 });
    expect(loadSettings().autoRenameDownloads).toBe(true);
  });

  it("persists the scheduling settings", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const settings = loadSettings();
    settings.maxConcurrentDownloads = 5;
    settings.speedLimitBytesPerSecond = 1024;
    settings.pollIntervalMs = 5000;
    settings.autoRenameDownloads = false;
    saveSettings(settings);

    expect(loadSettings()).toMatchObject({ maxConcurrentDownloads: 5, speedLimitBytesPerSecond: 1024, pollIntervalMs: 5000, autoRenameDownloads: false });
  });

  it("preserves a deliberately configured external aria2 port", () => {
    const storage = new MemoryStorage();
    storage.setItem("acgn-hub.settings.v1", JSON.stringify({ aria2Endpoint: "http://127.0.0.1:6800/jsonrpc" }));
    vi.stubGlobal("localStorage", storage);

    expect(loadSettings().aria2Endpoint).toBe("http://127.0.0.1:6800/jsonrpc");
  });

  it("preserves malformed settings including empty data instead of overwriting them", () => {
    const storage = new MemoryStorage();
    storage.setItem("acgn-hub.settings.v1", "");
    vi.stubGlobal("localStorage", storage);
    expect(() => loadSettings()).toThrow("原始数据已保留");
    expect(storage.getItem("acgn-hub.settings.v1")).toBe("");
  });
});
