import type { DownloadTask } from "@/domain/download";

export interface DownloadCompletedEvent {
  task: DownloadTask;
  emittedAt: string;
}

type DownloadCompletedListener = (event: DownloadCompletedEvent) => void;

const listeners = new Set<DownloadCompletedListener>();

export function onDownloadCompleted(listener: DownloadCompletedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitDownloadCompleted(task: DownloadTask): void {
  const event = { task, emittedAt: new Date().toISOString() } satisfies DownloadCompletedEvent;
  for (const listener of listeners) listener(event);
}
