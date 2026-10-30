import { describe, expect, it } from "vitest";
import type { Media } from "@/domain/media";
import { LocalStorageMediaRepository, type StorageLike } from "@/infrastructure/library/local-storage-media-repository";

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const media: Media = {
  id: "bangumi:123",
  type: "anime",
  title: "测试作品",
  aliases: ["Test"],
  externalIds: [{ provider: "bangumi", value: "123" }],
  metadata: {},
};

describe("LocalStorageMediaRepository", () => {
  it("upserts, lists and removes saved media", async () => {
    const repository = new LocalStorageMediaRepository(new MemoryStorage());
    await repository.upsert(media);
    await repository.upsert({ ...media, title: "更新后的作品" });

    await expect(repository.list()).resolves.toMatchObject([{ id: "bangumi:123", title: "更新后的作品" }]);
    await repository.remove("bangumi:123");
    await expect(repository.list()).resolves.toEqual([]);
  });

  it("ignores malformed stored entries", async () => {
    const storage = new MemoryStorage();
    storage.setItem("acgn-hub.media-library.v1", JSON.stringify([{ id: "broken" }, media]));

    await expect(new LocalStorageMediaRepository(storage).list()).resolves.toEqual([media]);
  });
});
