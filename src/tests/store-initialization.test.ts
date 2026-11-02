import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useMediaLibraryStore } from "@/stores/media-library";
import { useSourceConfigStore } from "@/stores/source-config";
import type { Media } from "@/domain/media";
import type { SourceConfig } from "@/domain/source";

const { mediaRepository, sourceRepository, mediaFactory, sourceFactory } = vi.hoisted(() => ({
  mediaRepository: { list: vi.fn(), upsert: vi.fn(), remove: vi.fn() },
  sourceRepository: { list: vi.fn(), upsert: vi.fn(), remove: vi.fn() },
  mediaFactory: vi.fn(), sourceFactory: vi.fn(),
}));
vi.mock("@/infrastructure/library/create-media-library-repository", () => ({ createMediaLibraryRepository: mediaFactory }));
vi.mock("@/infrastructure/database/create-source-config-repository", () => ({ createSourceConfigRepository: sourceFactory }));

const work: Media = { id: "test:work", title: "收藏作品", type: "novel", aliases: [], externalIds: [], metadata: {} };
const source: SourceConfig = { id: "test:source", type: "rss", name: "我的来源", url: "https://example.test/feed", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("store initialization shared with user actions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    const values = new Map([["acgn-hub.resource-source-migration.v18", "1"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("localStorage", storage);
    mediaFactory.mockResolvedValue(mediaRepository);
    sourceFactory.mockResolvedValue(sourceRepository);
    mediaRepository.upsert.mockResolvedValue(undefined);
    sourceRepository.upsert.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("waits for the original library read before saving a favorite so stale rows cannot erase it", async () => {
    const read = deferred<Media[]>();
    mediaRepository.list.mockReturnValue(read.promise);
    const store = useMediaLibraryStore();
    const loading = store.initialize();
    await vi.waitFor(() => expect(mediaRepository.list).toHaveBeenCalledOnce());
    const saving = store.save(work);
    await Promise.resolve(); await Promise.resolve();
    const wroteBeforeRead = mediaRepository.upsert.mock.calls.length;
    read.resolve([]);
    await Promise.all([loading, saving]);
    expect(wroteBeforeRead).toBe(0);
    expect(store.isSaved(work.id)).toBe(true);
    expect(store.items).toEqual([work]);
    expect(mediaFactory).toHaveBeenCalledOnce();
  });

  it("waits for the original source read before saving settings instead of restoring stale enablement", async () => {
    const read = deferred<SourceConfig[]>();
    sourceRepository.list.mockReturnValue(read.promise);
    const store = useSourceConfigStore();
    const loading = store.initialize();
    await vi.waitFor(() => expect(sourceRepository.list).toHaveBeenCalledOnce());
    const saving = store.save(source);
    await Promise.resolve(); await Promise.resolve();
    const wroteBeforeRead = sourceRepository.upsert.mock.calls.length;
    read.resolve([]);
    await Promise.all([loading, saving]);
    expect(wroteBeforeRead).toBe(0);
    expect(store.configs).toEqual([source]);
    expect(sourceFactory).toHaveBeenCalledOnce();
  });

  it("keeps concurrent library initialization pending until the rows are ready", async () => {
    const read = deferred<Media[]>();
    mediaRepository.list.mockReturnValue(read.promise);
    const store = useMediaLibraryStore();
    const first = store.initialize();
    await vi.waitFor(() => expect(mediaRepository.list).toHaveBeenCalledOnce());
    let ready = false;
    const second = store.initialize().then(() => { ready = true; });
    await Promise.resolve(); await Promise.resolve();
    const early = ready;
    read.resolve([work]);
    await Promise.all([first, second]);
    expect(early).toBe(false);
    expect(store.items).toEqual([work]);
  });
});
