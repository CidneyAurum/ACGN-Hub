import { describe, expect, it } from "vitest";
import { resourceDedupeKey, type ResourceItem } from "@/domain/resource";
import { LocalStorageResourceRepository, type ResourceStorageLike } from "@/infrastructure/database/resource-repository";

class MemoryStorage implements ResourceStorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const resource: ResourceItem = {
  id: "rss:fixture:episode-01",
  sourceId: "rss:fixture",
  sourceItemId: "episode-01",
  mediaId: "bangumi:1",
  title: "Episode 01",
  protocol: "http",
  targetUrl: "https://example.com/episode-01.mkv",
  metadata: { resolution: "1080p" },
  createdAt: "2026-08-17T00:00:00.000Z",
};

describe("LocalStorageResourceRepository", () => {
  it("persists a resource and its media association", async () => {
    const repository = new LocalStorageResourceRepository(new MemoryStorage());
    await repository.initialize();
    await repository.upsert(resource);

    await expect(repository.findById(resource.id)).resolves.toEqual(resource);
    await expect(repository.list()).resolves.toEqual([resource]);
  });

  it("deduplicates equivalent resource URLs across sources", () => {
    expect(resourceDedupeKey(resource)).toBe(resourceDedupeKey({ protocol: resource.protocol, targetUrl: `${resource.targetUrl}#mirror` }));
  });
});
