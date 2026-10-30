import type { DownloadTask } from "@/domain/download";

/**
 * Background refresh keeps live tasks up to date and re-drives tasks whose
 * engine GID vanished after an aria2 instance switch. Legacy anime fallback
 * recovery is gone together with the removed BitTorrent feature.
 */
export function needsBackgroundDownloadRefresh(task: DownloadTask): boolean {
  return ["queued", "downloading", "paused"].includes(task.state) ||
    (task.state === "failed" && task.errorCode === "ENGINE_TASK_NOT_FOUND");
}
