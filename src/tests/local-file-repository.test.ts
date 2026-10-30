import { describe, expect, it } from "vitest";
import { LocalStorageLocalFileRepository, type LocalFileStorageLike } from "@/infrastructure/database/local-file-repository";

class MemoryStorage implements LocalFileStorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("LocalStorageLocalFileRepository", () => {
  it("replaces a completed library scan", async () => {
    const repository = new LocalStorageLocalFileRepository(new MemoryStorage());
    await repository.initialize();
    await repository.replaceScan([{ id: "path:a", path: "D:\\Library\\a.mkv", sizeBytes: 12 }]);
    await expect(repository.list()).resolves.toMatchObject([{ path: "D:\\Library\\a.mkv", sizeBytes: 12, status: "present" }]);
    await repository.replaceScan([]);
    await expect(repository.list()).resolves.toMatchObject([{ path: "D:\\Library\\a.mkv", status: "missing" }]);
    await repository.replaceScan([
      { id: "path:a", path: "D:\\Library\\a.mkv", sizeBytes: 12, sha256: "same" },
      { id: "path:b", path: "D:\\Library\\b.mkv", sizeBytes: 12, sha256: "same" },
    ]);
    await expect(repository.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "D:\\Library\\a.mkv", status: "duplicate" }),
      expect.objectContaining({ path: "D:\\Library\\b.mkv", status: "duplicate", duplicateOf: "D:\\Library\\a.mkv" }),
    ]));
  });

  it("assigns and clears a media association without changing the file record", async () => {
    const repository = new LocalStorageLocalFileRepository(new MemoryStorage());
    await repository.initialize();
    await repository.replaceScan([{ id: "path:a", path: "D:\\Library\\a.mkv", sizeBytes: 12 }]);

    await repository.assignMedia("path:a", "bangumi:1");
    await expect(repository.list()).resolves.toMatchObject([{ id: "path:a", mediaId: "bangumi:1" }]);
    await repository.assignMedia("path:a");
    await expect(repository.list()).resolves.toMatchObject([{ id: "path:a" }]);
  });
});
