import { describe, expect, it } from "vitest";
import { LocalStorageMediaRepository, type StorageLike } from "@/infrastructure/library/local-storage-media-repository";
import { LocalStorageLocalFileRepository } from "@/infrastructure/database/local-file-repository";
import type { Media } from "@/domain/media";

class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}

const media: Media = { id: "a", type: "anime", title: "A", aliases: [], externalIds: [], metadata: {} };
const key = "acgn-hub.media-library.v1";

describe("storage integrity", () => {
  it("serializes writes across repository instances without losing either work", async () => {
    const storage = new MemoryStorage();
    const first = new LocalStorageMediaRepository(storage);
    const second = new LocalStorageMediaRepository(storage);
    await Promise.all([first.upsert(media), second.upsert({ ...media, id: "b" })]);
    expect((await first.list()).map((item) => item.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps damaged original text through initialization and failed writes", async () => {
    const storage = new MemoryStorage();
    storage.setItem(key, "");
    const repository = new LocalStorageMediaRepository(storage);
    await repository.initialize();
    await expect(repository.upsert(media)).rejects.toThrow("原始数据已保留");
    expect(storage.getItem(key)).toBe("");
    storage.setItem(key, JSON.stringify([media, { id: "damaged" }]));
    await expect(repository.list()).resolves.toEqual([media]);
    const original = storage.getItem(key);
    await expect(repository.remove(media.id)).rejects.toThrow("本次写入已停止");
    expect(storage.getItem(key)).toBe(original);
  });

  it("does not silently discard older saved works at the previous 500-item limit", async () => {
    const storage = new MemoryStorage();
    storage.setItem(key, JSON.stringify(Array.from({ length: 501 }, (_, index) => ({ ...media, id: String(index) }))));
    const repository = new LocalStorageMediaRepository(storage);
    await repository.upsert(media);
    expect(await repository.list()).toHaveLength(502);
  });

  it("rejects a duplicate scan before replacing the existing local file index", async () => {
    const storage = new MemoryStorage();
    const repository = new LocalStorageLocalFileRepository(storage);
    const file = { id: "one", path: "D:\\Library\\one.cbz", sizeBytes: 10 };
    await repository.replaceScan([file]);
    const original = storage.getItem("acgn-hub.local-files.v1");
    await expect(repository.replaceScan([file, { ...file, id: "two", path: file.path.toUpperCase() }])).rejects.toThrow("重复路径");
    expect(storage.getItem("acgn-hub.local-files.v1")).toBe(original);
  });
});
