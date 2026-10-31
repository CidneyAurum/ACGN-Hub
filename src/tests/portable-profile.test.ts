import { describe, expect, it } from "vitest";
import { inferLegacyPortableRoot, planPortableStorageRelocation, PORTABLE_ROOT_KEY, preparePortableProfile, relocatePortablePath, type PortableStorage } from "@/shared/portable-profile";

class MemoryStorage implements PortableStorage {
  readonly values = new Map<string, string>();
  failKey = "";
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { if (key === this.failKey) throw new Error("quota exceeded"); this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const oldRoot = "D:\\旧位置\\Data";
const newRoot = "E:\\新位置\\Data";
const settingsKey = "acgn-hub.settings.v1";
const tasksKey = "acgn-hub.local-download-tasks.v1";
function fixture(): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(settingsKey, JSON.stringify({ incomingDirectory: oldRoot + "\\Files\\Incoming", libraryDirectory: oldRoot + "\\Files\\Library", backupDirectory: "F:\\独立存档", aria2Endpoint: "http://127.0.0.1:16800/jsonrpc" }));
  storage.setItem(tasksKey, JSON.stringify([{ id: "same-id", directory: oldRoot + "\\Files\\Library", outputPath: oldRoot + "\\Files\\Library\\小说.txt", cleanupPaths: [{ path: oldRoot + "\\Files\\Library\\小说.txt", allowedRoot: oldRoot + "\\Files\\Library" }], title: oldRoot + " is text, not a path", reading: { seriesId: "same-series" } }]));
  return storage;
}

describe("portable profile relocation", () => {
  it("requires complete path boundaries and retains external paths", () => {
    expect(relocatePortablePath(oldRoot + "\\Files\\漫画.cbz", oldRoot, newRoot)).toBe(newRoot + "\\Files\\漫画.cbz");
    expect(relocatePortablePath("\\\\?\\" + oldRoot + "\\Files\\漫画.cbz", oldRoot, newRoot)).toBe(newRoot + "\\Files\\漫画.cbz");
    for (const value of [oldRoot + "base\\keep.txt", oldRoot + "\\..\\keep.txt", "F:\\outside\\keep.txt", "https://example.org/novel.epub"]) expect(relocatePortablePath(value, oldRoot, newRoot)).toBe(value);
  });

  it("relocates canonical UNC outputs and reading positions using either profile-root spelling", async () => {
    const previous = "\\\\server\\share\\旧位置\\Data";
    const verbatimRoot = "\\\\?\\UNC\\server\\share\\旧位置\\Data";
    const output = verbatimRoot + "\\Files\\Library\\小说.txt";
    expect(relocatePortablePath(output, previous, newRoot)).toBe(newRoot + "\\Files\\Library\\小说.txt");
    expect(relocatePortablePath(output, verbatimRoot, "\\\\?\\UNC\\new-server\\share\\Data")).toBe("\\\\new-server\\share\\Data\\Files\\Library\\小说.txt");
    for (const root of [previous, verbatimRoot]) {
      const storage = new MemoryStorage(); storage.setItem(PORTABLE_ROOT_KEY, root);
      storage.setItem(settingsKey, JSON.stringify({ incomingDirectory: root + "\\Files\\Incoming" }));
      storage.setItem(tasksKey, JSON.stringify([{ outputPath: output, directory: previous + "\\Files\\Library", cleanupPaths: [{ path: output, allowedRoot: previous + "\\Files\\Library" }] }]));
      const progress = "acgn-hub.viewer-progress.v1:" + JSON.stringify([output, "text", 100, "unchanged-mtime"]);
      storage.setItem(progress, "42");
      const calls: string[] = [];
      await preparePortableProfile(storage, newRoot, async (previousRoot) => { calls.push(previousRoot); });
      expect(calls).toEqual([root]);
      expect(JSON.parse(storage.getItem(tasksKey)!)[0]).toMatchObject({ outputPath: newRoot + "\\Files\\Library\\小说.txt", directory: newRoot + "\\Files\\Library" });
      const relocatedProgress = "acgn-hub.viewer-progress.v1:" + JSON.stringify([newRoot + "\\Files\\Library\\小说.txt", "text", 100, "unchanged-mtime"]);
      expect(storage.getItem(relocatedProgress)).toBe("42");
      expect(storage.getItem(progress)).toBe("42");
    }
  });

  it("infers only a coherent legacy default profile and preserves custom roots", () => {
    const storage = fixture();
    expect(inferLegacyPortableRoot(storage.getItem(settingsKey))).toBe(oldRoot);
    expect(inferLegacyPortableRoot(JSON.stringify({ incomingDirectory: oldRoot + "\\Files\\Incoming", libraryDirectory: "F:\\MyBooks" }))).toBeUndefined();
  });

  it("moves settings, generated outputs, ownership and reading positions together", async () => {
    const storage = fixture();
    const path = oldRoot + "\\Files\\Library\\小说.txt";
    const progress = "acgn-hub.viewer-progress.v1:" + JSON.stringify([path, "text", 2048, "date"]);
    const relocatedProgress = "acgn-hub.viewer-progress.v1:" + JSON.stringify([newRoot + "\\Files\\Library\\小说.txt", "text", 2048, "date"]);
    storage.setItem(progress, "4096");
    storage.setItem("acgn-hub.source-configs.v1", "public source configuration remains byte-for-byte unchanged");
    const databaseCalls: string[] = [];
    await preparePortableProfile(storage, newRoot, async (previous) => { databaseCalls.push(previous); });
    expect(databaseCalls).toEqual([oldRoot]);
    expect(JSON.parse(storage.getItem(settingsKey)!)).toMatchObject({ incomingDirectory: newRoot + "\\Files\\Incoming", backupDirectory: "F:\\独立存档" });
    expect(JSON.parse(storage.getItem(tasksKey)!)[0]).toMatchObject({ id: "same-id", outputPath: newRoot + "\\Files\\Library\\小说.txt", cleanupPaths: [{ path: newRoot + "\\Files\\Library\\小说.txt", allowedRoot: newRoot + "\\Files\\Library" }], title: oldRoot + " is text, not a path", reading: { seriesId: "same-series" } });
    expect(storage.getItem(progress)).toBe("4096");
    expect(storage.getItem(relocatedProgress)).toBe("4096");
    expect(storage.getItem(PORTABLE_ROOT_KEY)).toBe(newRoot);
    expect(storage.getItem("acgn-hub.source-configs.v1")).toBe("public source configuration remains byte-for-byte unchanged");
    await preparePortableProfile(storage, newRoot, async () => { throw new Error("must not migrate twice"); });
  });

  it("validates every affected record before touching SQLite", async () => {
    const storage = fixture(); storage.setItem(tasksKey, "broken");
    let called = false;
    await expect(preparePortableProfile(storage, newRoot, async () => { called = true; })).rejects.toThrow("原始数据已保留");
    expect(called).toBe(false);
    expect(storage.getItem(tasksKey)).toBe("broken");
    expect(storage.getItem(PORTABLE_ROOT_KEY)).toBeNull();
  });

  it("rolls back Web Storage on quota failure and safely retries an already migrated database", async () => {
    const storage = fixture(); const original = storage.getItem(settingsKey); const tasks = storage.getItem(tasksKey);
    storage.failKey = tasksKey;
    await expect(preparePortableProfile(storage, newRoot, async () => undefined)).rejects.toThrow("本次未启动下载");
    expect(storage.getItem(settingsKey)).toBe(original);
    expect(storage.getItem(tasksKey)).toBe(tasks);
    expect(storage.getItem(PORTABLE_ROOT_KEY)).toBe(oldRoot);
    storage.failKey = "";
    await preparePortableProfile(storage, newRoot, async () => undefined);
    expect(storage.getItem(PORTABLE_ROOT_KEY)).toBe(newRoot);
  });

  it("resumes an interrupted first migration using the saved previous identity", async () => {
    const storage = fixture(); storage.setItem(PORTABLE_ROOT_KEY, oldRoot);
    const settings = planPortableStorageRelocation(storage, oldRoot, newRoot).find((change) => change.key === settingsKey)!;
    storage.setItem(settingsKey, settings.next);
    await preparePortableProfile(storage, newRoot, async () => undefined);
    expect(JSON.parse(storage.getItem(tasksKey)!)[0].outputPath).toBe(newRoot + "\\Files\\Library\\小说.txt");
    expect(storage.getItem(PORTABLE_ROOT_KEY)).toBe(newRoot);
  });

  it("keeps the previous identity and records when SQLite rejects relocation", async () => {
    const storage = fixture(); const tasks = storage.getItem(tasksKey);
    await expect(preparePortableProfile(storage, newRoot, async () => { throw new Error("database is locked"); })).rejects.toThrow("database is locked");
    expect(storage.getItem(tasksKey)).toBe(tasks);
    expect(storage.getItem(PORTABLE_ROOT_KEY)).toBe(oldRoot);
  });

  it("rejects nested profile moves before mutations", async () => {
    const storage = fixture();
    await expect(preparePortableProfile(storage, oldRoot + "\\Backup\\Data", async () => undefined)).rejects.toThrow("互相嵌套");
    expect(storage.getItem(PORTABLE_ROOT_KEY)).toBeNull();
  });
});
