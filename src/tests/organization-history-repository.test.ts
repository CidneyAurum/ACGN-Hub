import { describe, expect, it } from "vitest";
import { LocalStorageOrganizationHistoryRepository, type OrganizationHistoryStorageLike } from "@/infrastructure/database/organization-history-repository";

class MemoryStorage implements OrganizationHistoryStorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("LocalStorageOrganizationHistoryRepository", () => {
  it("keeps organization results in reverse chronological insertion order", async () => {
    const repository = new LocalStorageOrganizationHistoryRepository(new MemoryStorage());
    await repository.initialize();
    await repository.add({
      id: "history-1", taskId: "task-1", mediaId: "bangumi:1", sourcePath: "D:\\Incoming\\a.mkv",
      destinationPath: "D:\\Library\\Anime\\a.mkv", status: "moved", createdAt: "2026-08-17T00:00:00.000Z",
    });
    await repository.add({
      id: "history-2", taskId: "task-1", mediaId: "bangumi:1", sourcePath: "D:\\Incoming\\b.mkv",
      destinationPath: "D:\\Library\\Anime\\b.mkv", status: "failed", error: "conflict", createdAt: "2026-08-17T01:00:00.000Z",
    });

    await expect(repository.list()).resolves.toMatchObject([{ id: "history-2" }, { id: "history-1" }]);
  });
});
