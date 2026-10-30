import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), desktop: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: mocks.load } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/shared/runtime", () => ({ isTauriRuntime: mocks.desktop }));

beforeEach(() => {
  vi.resetModules();
  mocks.load.mockReset();
  mocks.invoke.mockReset().mockResolvedValue("sqlite:acgn-hub.db");
  mocks.desktop.mockReturnValue(true);
});

describe("repository initialization", () => {
  it("shares a pending SQLite open and allows retry after failure", async () => {
    const { loadDatabase } = await import("@/infrastructure/database/repository-runtime");
    mocks.load.mockRejectedValueOnce(new Error("disk full"));
    const first = loadDatabase();
    expect(loadDatabase()).toBe(first);
    await expect(first).rejects.toThrow("无法打开 acgn-hub.db");
    const db = { execute: vi.fn(), select: vi.fn() };
    mocks.load.mockResolvedValueOnce(db);
    await expect(loadDatabase()).resolves.toBe(db);
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("deduplicates factories and never changes desktop storage on failure", async () => {
    const { createRepository } = await import("@/infrastructure/database/repository-runtime");
    const initialize = vi.fn().mockRejectedValueOnce(new Error("migration failed")).mockResolvedValue(undefined);
    const desktop = vi.fn(() => ({ initialize }));
    const browser = vi.fn(() => ({ initialize: vi.fn() }));
    const first = createRepository("factory-test", desktop, browser);
    expect(createRepository("factory-test", desktop, browser)).toBe(first);
    await expect(first).rejects.toThrow("migration failed");
    await createRepository("factory-test", desktop, browser);
    expect(desktop).toHaveBeenCalledTimes(2);
    expect(browser).not.toHaveBeenCalled();
  });

  it("runs an instance schema initialization once and exposes migration errors", async () => {
    const { initializeRepository, ensureColumns } = await import("@/infrastructure/database/repository-runtime");
    const owner = {};
    const initialize = vi.fn().mockResolvedValue(undefined);
    await Promise.all([initializeRepository(owner, "作品", initialize), initializeRepository(owner, "作品", initialize)]);
    expect(initialize).toHaveBeenCalledTimes(1);
    const db = {
      select: vi.fn().mockResolvedValue([{ name: "id" }]),
      execute: vi.fn().mockRejectedValue(new Error("read only")),
    };
    await expect(ensureColumns(db as never, "media", { description: "TEXT" })).rejects.toThrow("read only");
  });
});
