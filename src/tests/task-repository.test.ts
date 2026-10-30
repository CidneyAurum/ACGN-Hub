import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadTask } from "@/domain/download";
import { LocalStorageTaskRepository } from "@/infrastructure/database/local-storage-task-repository";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const task: DownloadTask = {
  id: "task-1",
  engineId: "aria2",
  sourceName: "RSS/Atom",
  sourceUrl: "https://example.com/file.zip",
  protocol: "http",
  directory: "C:\\Incoming",
  state: "completed",
  totalBytes: 10,
  completedBytes: 10,
  speedBytesPerSecond: 0,
  files: ["C:\\Incoming\\file.zip"],
  dedupeKey: "http:https://example.com/file.zip",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("LocalStorageTaskRepository", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists source metadata and removes a terminal task record", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    const repository = new LocalStorageTaskRepository();
    await repository.initialize();
    await repository.insert(task);

    await expect(repository.list()).resolves.toEqual([task]);
    await repository.remove(task.id);
    await expect(repository.list()).resolves.toEqual([]);
  });
});
