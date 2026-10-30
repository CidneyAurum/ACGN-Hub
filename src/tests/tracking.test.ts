import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readTracking, useTrackingStore } from "@/stores/tracking";
import type { Media } from "@/domain/media";
const state = vi.hoisted(() => ({ items: [] as Media[] }));
vi.mock("@/stores/media-library", () => ({ useMediaLibraryStore: () => ({ get items() { return state.items; }, initialize: async () => undefined, save: async (media: Media) => { state.items = [media, ...state.items.filter((item) => item.id !== media.id)]; } }) }));
const media: Media = { id: "bangumi:400602", type: "anime", title: "芙莉莲", aliases: [], externalIds: [], metadata: { rating: 8.5 } };
describe("local anime tracking", () => {
  afterEach(() => { state.items = []; });
  it("saves tracking progress within the existing media record without losing metadata", async () => {
    setActivePinia(createPinia());
    const store = useTrackingStore();
    await store.setStatus(media, "watching");
    await store.advance(media);
    expect(state.items[0].metadata.rating).toBe(8.5);
    expect(readTracking(state.items[0])).toMatchObject({ status: "watching", episode: 1 });
    await store.update(media, { total: 2 });
    await store.advance(media);
    expect(readTracking(state.items[0])).toMatchObject({ status: "completed", episode: 2 });
  });
});
