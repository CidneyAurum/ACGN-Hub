import { defineStore } from "pinia";
import type { Media } from "@/domain/media";
import { useMediaLibraryStore } from "./media-library";

export type TrackingStatus = "wish" | "watching" | "completed" | "on_hold" | "dropped";
export interface Tracking { status: TrackingStatus; episode: number; total?: number; updatedAt?: string }
export const trackingLabels: Record<TrackingStatus, string> = { wish: "想看", watching: "在看", completed: "看过", on_hold: "搁置", dropped: "不再追" };
export function readTracking(media: Media): Tracking {
  const value = media.metadata.tracking as Partial<Tracking> | undefined;
  return { status: value && value.status && value.status in trackingLabels ? value.status : "wish", episode: Number.isInteger(value?.episode) && value!.episode! >= 0 ? value!.episode! : 0, ...(Number.isInteger(value?.total) && value!.total! > 0 ? { total: value!.total } : {}), updatedAt: value?.updatedAt };
}
export const useTrackingStore = defineStore("tracking", () => {
  const library = useMediaLibraryStore();
  function get(media: Media): Tracking { return readTracking(library.items.find((item) => item.id === media.id) ?? media); }
  async function update(media: Media, patch: Partial<Tracking>): Promise<void> {
    await library.initialize();
    const current = library.items.find((item) => item.id === media.id) ?? media;
    const previous = readTracking(current);
    const tracking = { ...previous, ...patch, updatedAt: new Date().toISOString() };
    if (!Number.isInteger(tracking.episode) || tracking.episode < 0 || tracking.episode > 99999) throw new Error("观看进度需要是有效集数");
    if (tracking.total !== undefined && tracking.episode > tracking.total) tracking.episode = tracking.total;
    await library.save({ ...current, metadata: { ...current.metadata, tracking } });
  }
  async function setStatus(media: Media, status: TrackingStatus): Promise<void> { await update(media, { status }); }
  async function advance(media: Media): Promise<void> { const tracking = get(media); await update(media, { episode: tracking.episode + 1, status: tracking.total && tracking.episode + 1 >= tracking.total ? "completed" : "watching" }); }
  return { get, update, setStatus, advance };
});
