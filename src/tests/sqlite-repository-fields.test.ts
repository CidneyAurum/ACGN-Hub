import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceItem } from "@/domain/resource";
import type { Media } from "@/domain/media";
import { SqliteResourceRepository } from "@/infrastructure/database/resource-repository";
import { SqliteMediaRepository } from "@/infrastructure/library/sqlite-media-repository";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), transaction: vi.fn() }));
vi.mock("@/infrastructure/database/repository-runtime", () => ({
  RepositoryStorageError: class extends Error {},
  loadDatabase: async () => ({ execute: mocks.execute, select: mocks.select }),
  initializeRepository: (_owner: object, _label: string, initialize: () => Promise<void>) => initialize(),
  ensureColumns: vi.fn(),
  executeTransaction: mocks.transaction,
  serializeDatabaseWrite: (write: () => Promise<void>) => write(),
}));

beforeEach(() => {
  mocks.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  mocks.select.mockReset().mockResolvedValue([]);
  mocks.transaction.mockReset().mockResolvedValue(undefined);
});

describe("SQLite field preservation", () => {
  it("round-trips chapter, volume, format and size alongside resource metadata", async () => {
    const resource: ResourceItem = {
      id: "r", sourceId: "rss:test", sourceItemId: "entry", mediaId: "media", title: "Chapter",
      protocol: "http", targetUrl: "https://example.com/chapter.cbz", episode: 1, chapter: 2, volume: 3,
      language: "zh", resolution: "original", format: "CBZ", sizeBytes: 1024,
      publishedAt: "2026-01-01", metadata: { source: "test" }, createdAt: "2026-01-02",
    };
    const repository = new SqliteResourceRepository();
    await repository.initialize();
    await repository.upsert(resource);
    const statements = mocks.transaction.mock.calls[0][0];
    const values = statements[1].values;
    mocks.select.mockResolvedValue([{
      id: values[0], source_id: values[1], source_item_id: values[2], media_id: values[3], title: values[4],
      protocol: values[5], target_url: values[6], metadata_json: values[7], details_json: values[8], created_at: values[9],
    }]);
    await expect(repository.findById(resource.id)).resolves.toEqual(resource);
    expect(statements).toHaveLength(2);
  });

  it("round-trips a work's description and release year", async () => {
    const media: Media = { id: "m", type: "anime", title: "Title", description: "Introduction", releaseYear: 2026,
      aliases: ["Alias"], externalIds: [{ provider: "bangumi", value: "1" }], metadata: { raw: true } };
    const repository = new SqliteMediaRepository();
    await repository.initialize();
    await repository.upsert(media);
    const values = mocks.transaction.mock.calls[0][0][0].values;
    mocks.select.mockResolvedValue([{
      id: values[0], type: values[1], title: values[2], original_title: values[3], aliases_json: values[4], cover_url: values[5],
      description: values[6], release_year: values[7], metadata_json: values[8], external_ids_json: JSON.stringify(media.externalIds),
    }]);
    await expect(repository.list()).resolves.toEqual([media]);
  });
});
