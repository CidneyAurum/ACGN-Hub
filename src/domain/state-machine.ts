import type { DownloadState } from "./download";

const transitions: Record<DownloadState, readonly DownloadState[]> = {
  queued: ["downloading", "paused", "completed", "cancelled", "failed"],
  downloading: ["paused", "completed", "failed", "cancelled"],
  paused: ["queued", "downloading", "completed", "cancelled", "failed"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: ["queued"],
};

export function canTransition(from: DownloadState, to: DownloadState): boolean {
  return from === to || transitions[from].includes(to);
}
