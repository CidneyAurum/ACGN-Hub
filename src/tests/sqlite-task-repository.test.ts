import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteTaskRepository } from "@/infrastructure/database/sqlite-task-repository";
import type { DownloadTask } from "@/domain/download";

const state = vi.hoisted(() => ({ db: undefined as DatabaseSync | undefined }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => "sqlite:acgn-hub.db" }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: {
  load: async () => ({
    execute: async (sql: string, values: SQLInputValue[] = []) => {
      const result = state.db!.prepare(sql).run(...values);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
    select: async (sql: string, values: SQLInputValue[] = []) => state.db!.prepare(sql).all(...values),
  }),
} }));

const task: DownloadTask = {
  id: "one", engineId: "aria2", engineEndpoint: "http://127.0.0.1:16800/jsonrpc", sourceUrl: "https://example.com/file.zip",
  protocol: "http", directory: "D:\\Incoming", state: "paused", totalBytes: 10, completedBytes: 5, speedBytesPerSecond: 0,
  files: ["D:\\Incoming\\file.zip"], dedupeKey: "http:https://example.com/file.zip", createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

beforeEach(() => { state.db = new DatabaseSync(":memory:"); });
afterEach(() => { state.db?.close(); vi.unstubAllGlobals(); });

describe("SqliteTaskRepository with an isolated SQLite database", () => {
  it("restores naming and diagnostics without Object.hasOwn and ignores identity injection", async () => {
    const original = Object.hasOwn;
    Object.hasOwn = undefined as never;
    let restored: DownloadTask | undefined;
    try {
      const repository = new SqliteTaskRepository();
      await repository.initialize();
      await repository.insert(task);
      state.db!.prepare("UPDATE download_tasks SET diagnostics_json = ?, naming_json = ? WHERE id = ?").run(
        JSON.stringify({ stage: "connecting", peers: 0, id: "injected", directory: "D:\\other", hasOwnProperty: false }),
        JSON.stringify({ status: "renamed", originalFileName: "old.zip", originalPath: "D:\\Incoming\\old.zip", currentFileName: "new.zip", id: "injected" }), task.id);
      restored = await repository.findById(task.id);
    } finally { Object.hasOwn = original; }
    expect(restored).toMatchObject({ id: task.id, directory: task.directory, stage: "connecting", peers: 0,
      naming: { status: "renamed", originalFileName: "old.zip", currentFileName: "new.zip" } });
  });
  it("preserves BT stages, peer counts and verification details through restart and clears them explicitly", async () => {
    const repository = new SqliteTaskRepository();
    await repository.initialize();
    const btTask: DownloadTask = { ...task, stage: "fetching_metadata", peers: 0, connections: 0, seeders: 0,
      naming: { status: "renamed", originalFileName: "original.mp4", originalPath: "D:\\Incoming\\original.mp4", currentFileName: "中文.mp4", renamedAt: "2026-01-02" },
      infoHash: "a".repeat(40), verifiedBytes: 5, verifyIntegrityPending: true };
    await repository.insert(btTask);
    const reopened = new SqliteTaskRepository();
    await reopened.initialize();
    await expect(reopened.findById(task.id)).resolves.toEqual(btTask);
    await reopened.update({ ...btTask, stage: undefined, peers: undefined, infoHash: undefined, verifiedBytes: undefined, verifyIntegrityPending: undefined });
    const restored = (await reopened.list())[0]!;
    expect(restored.stage).toBeUndefined();
    expect(restored.peers).toBeUndefined();
    expect(restored.infoHash).toBeUndefined();
    expect(restored.verifiedBytes).toBeUndefined();
    expect(restored.verifyIntegrityPending).toBeUndefined();
    expect(restored.completedBytes).toBe(task.completedBytes);
  });

  it("cannot replace task identity through diagnostic JSON and preserves corrupted diagnostic records", async () => {
    const repository = new SqliteTaskRepository();
    await repository.initialize();
    await repository.insert(task);
    state.db!.prepare("UPDATE download_tasks SET diagnostics_json = ? WHERE id = ?")
      .run(JSON.stringify({ stage: "connecting", peers: 0, id: "other", directory: "D:\\other" }), task.id);
    await expect(repository.findById(task.id)).resolves.toMatchObject({ id: task.id, directory: task.directory, stage: "connecting", peers: 0 });
    const malformed = JSON.stringify({ stage: "not-a-stage", peers: -1 });
    state.db!.prepare("UPDATE download_tasks SET diagnostics_json = ? WHERE id = ?").run(malformed, task.id);
    await expect(repository.list()).rejects.toThrow("记录无效");
    expect(state.db!.prepare("SELECT diagnostics_json FROM download_tasks WHERE id = ?").get(task.id))
      .toMatchObject({ diagnostics_json: malformed });
  });

  it("persists the bound engine endpoint through insert, update and a new repository instance", async () => {
    const repository = new SqliteTaskRepository();
    await repository.initialize();
    await repository.insert(task);
    await expect(repository.findById(task.id)).resolves.toEqual(task);
    const updated = { ...task, engineEndpoint: "http://127.0.0.1:16801/jsonrpc", completedBytes: 8 };
    await repository.update(updated);
    const reopened = new SqliteTaskRepository();
    await reopened.initialize();
    await expect(reopened.list()).resolves.toEqual([updated]);
  });

  it("adds missing columns while preserving legacy rows without an endpoint", async () => {
    state.db!.exec(`CREATE TABLE download_tasks (
      id TEXT PRIMARY KEY, engine_id TEXT NOT NULL, engine_task_id TEXT, source_url TEXT NOT NULL, protocol TEXT NOT NULL,
      directory TEXT NOT NULL, filename TEXT, state TEXT NOT NULL, total_bytes INTEGER NOT NULL DEFAULT 0,
      completed_bytes INTEGER NOT NULL DEFAULT 0, speed_bytes_per_second INTEGER NOT NULL DEFAULT 0,
      files_json TEXT NOT NULL DEFAULT '[]', error TEXT, dedupe_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    state.db!.prepare(`INSERT INTO download_tasks (id, engine_id, source_url, protocol, directory, state, dedupe_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("legacy", "qbittorrent", "https://example.com/a.torrent", "torrent", "D:\\Incoming", "paused", "legacy-key", "2026-01-01", "2026-01-01");
    const repository = new SqliteTaskRepository();
    await Promise.all([repository.initialize(), repository.initialize()]);
    const restored = (await repository.list())[0];
    expect(restored).toMatchObject({ id: "legacy", engineId: "qbittorrent", protocol: "torrent", state: "paused", files: [] });
    expect(restored.engineEndpoint).toBeUndefined();
    await repository.update({ ...restored, engineEndpoint: "http://127.0.0.1:8080" });
    expect(state.db!.prepare("SELECT engine_endpoint FROM download_tasks WHERE id = ?").get("legacy")).toMatchObject({ engine_endpoint: "http://127.0.0.1:8080" });
  });

  it("rejects invalid optional fields before writing and leaves damaged stored JSON intact", async () => {
    const repository = new SqliteTaskRepository();
    await repository.initialize();
    await repository.insert(task);
    await expect(repository.update({ ...task, engineEndpoint: { wrong: true } } as never)).rejects.toThrow("记录无效");
    await expect(repository.findById(task.id)).resolves.toEqual(task);
    state.db!.prepare("UPDATE download_tasks SET files_json = ? WHERE id = ?").run('{"wrong":true}', task.id);
    await expect(repository.list()).rejects.toThrow("记录无效");
    expect(state.db!.prepare("SELECT files_json FROM download_tasks WHERE id = ?").get(task.id)).toMatchObject({ files_json: '{"wrong":true}' });
  });
});
