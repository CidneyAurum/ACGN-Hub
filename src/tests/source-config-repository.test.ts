import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageSourceConfigRepository, SqliteSourceConfigRepository, type SourceConfigStorageLike } from "@/infrastructure/database/source-config-repository";

const { database } = vi.hoisted(() => ({ database: { execute: vi.fn(), select: vi.fn() } }));
vi.mock("@/infrastructure/database/repository-runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/infrastructure/database/repository-runtime")>(),
  loadDatabase: async () => database,
}));

class MemoryStorage implements SourceConfigStorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("LocalStorageSourceConfigRepository", () => {
  it("persists, updates and removes RSS source configs", async () => {
    const repository = new LocalStorageSourceConfigRepository(new MemoryStorage());
    const config = {
      id: "source-1",
      type: "rss" as const,
      name: "Example Feed",
      url: "https://example.com/feed.xml",
      enabled: true,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };

    await repository.initialize();
    await repository.upsert(config);
    await expect(repository.list()).resolves.toEqual([config]);
    await repository.upsert({ ...config, enabled: false, updatedAt: "2026-08-17T01:00:00.000Z" });
    await expect(repository.list()).resolves.toMatchObject([{ enabled: false }]);
    await repository.remove(config.id);
    await expect(repository.list()).resolves.toEqual([]);
  });

  it("persists the last health result without storing response data", async () => {
    const repository = new LocalStorageSourceConfigRepository(new MemoryStorage());
    const config = {
      id: "source-health",
      type: "rss" as const,
      name: "Health Feed",
      url: "https://example.com/feed.xml",
      enabled: false,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T01:00:00.000Z",
      lastHealth: { ok: false, checkedAt: "2026-08-17T01:00:00.000Z", message: "HTTP 503" },
    };
    await repository.initialize();
    await repository.upsert(config);
    await expect(repository.list()).resolves.toEqual([config]);
  });

  it("recognizes even obsolete retired records for cleanup while retaining every other source field", async () => {
    const storage = new MemoryStorage();
    const active = { id: "keep", type: "copymanga", name: "配置", url: "https://configured.example", token: "keep-token", enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-02" };
    storage.setItem("acgn-hub.source-configs.v1", JSON.stringify([active, { id: "old-weeb", type: "weebcentral", token: 123 }, { id: "old-kuaikan", type: "kuaikan" }]));
    const repository = new LocalStorageSourceConfigRepository(storage);
    await repository.initialize();
    await expect(repository.list()).resolves.toMatchObject([active, { id: "old-weeb", type: "weebcentral" }, { id: "old-kuaikan", type: "kuaikan" }]);
    await repository.remove("old-weeb");
    await repository.remove("old-kuaikan");
    await expect(repository.list()).resolves.toEqual([active]);
    expect(JSON.parse(storage.getItem("acgn-hub.source-configs.v1")!)).toEqual([active]);
    for (const type of ["weebcentral", "kuaikan"] as const) await expect(repository.upsert({ ...active, type })).rejects.toThrow("已撤下");
    await expect(repository.list()).resolves.toEqual([active]);
  });
});

describe("retired sources in existing SQLite records", () => {
  beforeEach(() => { database.execute.mockReset().mockResolvedValue({ rowsAffected: 0 }); database.select.mockReset(); });

  it("keeps retired rows readable for v18 removal without breaking other configurations", async () => {
    const active = { type: "copymanga", name: "我的地址", url: "https://configured.example", token: "keep-token", createdAt: "2026-01-01" };
    database.select.mockResolvedValue([
      { source_id: "active", enabled: 0, updated_at: "2026-01-02", config_json: JSON.stringify(active) },
      { source_id: "old-weeb", enabled: 1, updated_at: "2026-01-02", config_json: JSON.stringify({ type: "weebcentral", token: 123, lastHealth: "obsolete" }) },
      { source_id: "old-kuaikan", enabled: 1, updated_at: "2026-01-02", config_json: JSON.stringify({ type: "kuaikan" }) },
    ]);
    const repository = new SqliteSourceConfigRepository();
    await repository.initialize();
    database.execute.mockClear();
    const rows = await repository.list();
    expect(rows[0]).toEqual({ ...active, id: "active", enabled: false, updatedAt: "2026-01-02" });
    expect(rows.slice(1).map((row) => [row.id, row.type])).toEqual([["old-weeb", "weebcentral"], ["old-kuaikan", "kuaikan"]]);
    expect(database.execute).not.toHaveBeenCalled();
    for (const type of ["weebcentral", "kuaikan"] as const) await expect(repository.upsert({ ...rows[0], type })).rejects.toThrow("已撤下");
    expect(database.execute).not.toHaveBeenCalled();
    await repository.remove("old-weeb");
    expect(database.execute).toHaveBeenCalledExactlyOnceWith("DELETE FROM source_configs WHERE source_id = ?", ["old-weeb"]);
  });

  it("continues to report damaged unrelated configurations instead of silently deleting them", async () => {
    database.select.mockResolvedValue([{ source_id: "damaged", enabled: 0, updated_at: "2026-01-02", config_json: '{"type":"copymanga","token":123}' }]);
    const repository = new SqliteSourceConfigRepository();
    await repository.initialize();
    database.execute.mockClear();
    await expect(repository.list()).rejects.toThrow("已损坏");
    expect(database.execute).not.toHaveBeenCalled();
  });
});
