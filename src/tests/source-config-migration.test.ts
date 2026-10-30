import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSourceConfigStore } from "@/stores/source-config";
import type { SourceConfig } from "@/domain/source";

const { repository, factory } = vi.hoisted(() => ({
  repository: { list: vi.fn(), upsert: vi.fn(), remove: vi.fn() }, factory: vi.fn(),
}));
vi.mock("@/infrastructure/database/create-source-config-repository", () => ({ createSourceConfigRepository: factory }));

describe("source configuration upgrades", () => {
  let rows: SourceConfig[];
  const config: SourceConfig = { id: "builtin:copymanga", type: "copymanga", name: "我的地址", url: "https://configured.example", token: "test-value", enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" };

  beforeEach(() => {
    setActivePinia(createPinia());
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    rows = [{ ...config }];
    repository.list.mockReset().mockImplementation(async () => rows);
    repository.upsert.mockReset().mockImplementation(async (item: SourceConfig) => { rows = [...rows.filter((row) => row.id !== item.id), item]; });
    repository.remove.mockReset().mockImplementation(async (id: string) => { rows = rows.filter((row) => row.id !== id); });
    factory.mockReset().mockResolvedValue(repository);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves addresses, credentials, disabled sources and removed presets on an upgrade", async () => {
    localStorage.setItem("acgn-hub.resource-source-migration.v14", "1");
    const store = useSourceConfigStore();
    await store.initialize();
    expect(store.configs.find((row) => row.id === config.id)).toEqual(config);
    expect(store.configs.filter((row) => row.id !== config.id).map((row) => row.id).sort()).toEqual(["builtin:mangabz", "builtin:public-video"]);
    expect(store.configs.every((row) => !row.enabled)).toBe(true);
    expect(repository.upsert).toHaveBeenCalledTimes(2);
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it("adds optional presets for a first setup without overwriting an existing preset id", async () => {
    const store = useSourceConfigStore();
    await store.initialize();
    expect(store.configs.find((item) => item.id === config.id)).toEqual(config);
    expect(store.configs.length).toBeGreaterThan(1);
    expect(store.configs.every((item) => !item.enabled)).toBe(true);
    expect(store.configs.some((item) => ["weebcentral", "kuaikan"].includes(item.type))).toBe(false);
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it("can retry an initialization whose repository failed to load", async () => {
    repository.list.mockRejectedValueOnce(new Error("database unavailable"));
    const store = useSourceConfigStore();
    await store.initialize();
    expect(store.error).toContain("database unavailable");
    await store.initialize();
    expect(store.error).toBe("");
    expect(store.configs.some((item) => item.id === config.id)).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not seed SQLite presets over legacy source records awaiting import", async () => {
    rows = [];
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([config]));
    const store = useSourceConfigStore();
    await store.initialize();
    expect(store.configs).toEqual([]);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("does not reinsert the new source after a user has removed it", async () => {
    localStorage.setItem("acgn-hub.resource-source-migration.v17", "1");
    await useSourceConfigStore().initialize();
    expect(repository.upsert).not.toHaveBeenCalled();
    expect(rows).toEqual([config]);
  });

  it("keeps an already configured MangaBZ provider on v16 without adding retired presets", async () => {
    localStorage.setItem("acgn-hub.resource-source-migration.v16", "1");
    const existing: SourceConfig = { ...config, id: "my:mangabz", type: "mangabz", name: "我的漫画源", url: "https://mangabz.com", enabled: true };
    rows.push(existing);
    const store = useSourceConfigStore();
    await store.initialize();
    expect(store.configs.find((item) => item.id === existing.id)).toEqual(existing);
    expect(store.configs.some((item) => item.id === "builtin:mangabz" || item.type === "public_video")).toBe(false);
    expect(store.configs.some((item) => ["weebcentral", "kuaikan"].includes(item.type))).toBe(false);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("offers only MangaBZ once to a pre-v17 install that has not configured it", async () => {
    localStorage.setItem("acgn-hub.resource-source-migration.v16", "1");
    const store = useSourceConfigStore();
    await store.initialize();
    expect(repository.upsert).toHaveBeenCalledOnce();
    expect(store.configs.find((item) => item.type === "mangabz")).toMatchObject({ id: "builtin:mangabz", enabled: false });
    expect(store.configs.some((item) => ["weebcentral", "kuaikan"].includes(item.type))).toBe(false);
  });

  it("v18 removes only retired source configurations and preserves other settings, media and download records", async () => {
    localStorage.setItem("acgn-hub.resource-source-migration.v17", "1");
    const manga: SourceConfig = { ...config, id: "custom:manga", type: "mangabz", name: "保留漫画源", url: "https://mangabz.com", enabled: true };
    const rss: SourceConfig = { ...config, id: "custom:rss", type: "rss", name: "保留订阅", url: "https://example.test/rss", token: "another-token" };
    rows.push(manga, rss,
      { ...config, id: "custom:weeb", type: "weebcentral", enabled: true },
      { ...config, id: "builtin:kuaikan", type: "kuaikan", enabled: false });
    const retained = ["acgn-hub.media-library.v1", "acgn-hub.resources.v1", "acgn-hub.download-tasks.v1", "acgn-hub.local-files.v1"];
    for (const key of retained) localStorage.setItem(key, JSON.stringify([{ id: key, path: "D:\\Library\\existing.cbz" }]));
    const originals = retained.map((key) => [key, localStorage.getItem(key)] as const);
    const store = useSourceConfigStore();
    await store.initialize();
    expect(repository.remove.mock.calls.map(([id]) => id).sort()).toEqual(["builtin:kuaikan", "custom:weeb"]);
    expect(repository.upsert).not.toHaveBeenCalled();
    expect(rows).toEqual([config, manga, rss]);
    expect(store.configs).toEqual(expect.arrayContaining([config, manga, rss]));
    expect(store.enabledConfigs).toEqual([manga]);
    expect(localStorage.getItem("acgn-hub.resource-source-migration.v18")).toBe("1");
    for (const [key, raw] of originals) expect(localStorage.getItem(key)).toBe(raw);
    await expect(store.save({ ...config, type: "weebcentral" })).rejects.toThrow("已撤下");
    await expect(store.save({ ...config, type: "kuaikan" })).rejects.toThrow("已撤下");
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("does not restore removed MangaBZ from v17, including when retired sources are present", async () => {
    localStorage.setItem("acgn-hub.resource-source-migration.v17", "1");
    rows.push({ ...config, id: "old-weeb", type: "weebcentral" }, { ...config, id: "old-kuaikan", type: "kuaikan" });
    const store = useSourceConfigStore();
    await store.initialize();
    expect(rows).toEqual([config]);
    expect(store.configs).toEqual([config]);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("retries failed retirement without marking v18 complete or exposing retired rows", async () => {
    localStorage.setItem("acgn-hub.resource-source-migration.v17", "1");
    rows.push({ ...config, id: "old-kuaikan", type: "kuaikan", enabled: true });
    repository.remove.mockRejectedValueOnce(new Error("configuration database locked"));
    const store = useSourceConfigStore();
    await store.initialize();
    expect(store.error).toContain("locked");
    expect(store.configs).toEqual([config]);
    expect(store.enabledConfigs).toEqual([]);
    expect(localStorage.getItem("acgn-hub.resource-source-migration.v18")).toBeNull();
    await store.initialize();
    expect(store.error).toBe("");
    expect(rows).toEqual([config]);
    expect(localStorage.getItem("acgn-hub.resource-source-migration.v18")).toBe("1");
  });

  it("also retires stale configuration rows when the v18 marker already exists", async () => {
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    rows.push({ ...config, id: "stale:weeb", type: "weebcentral" });
    await useSourceConfigStore().initialize();
    expect(rows).toEqual([config]);
    expect(repository.remove).toHaveBeenCalledWith("stale:weeb");
    expect(repository.upsert).not.toHaveBeenCalled();
  });
});
