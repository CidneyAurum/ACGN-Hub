import { describe, expect, it } from "vitest";
import { emitDownloadCompleted, onDownloadCompleted } from "@/application/download-events";
import type { DownloadTask } from "@/domain/download";

const task: DownloadTask = {
  id: "task-1",
  engineId: "aria2",
  sourceUrl: "https://example.com/file.mkv",
  protocol: "http",
  directory: "D:\\ACGN\\Incoming",
  state: "completed",
  totalBytes: 1,
  completedBytes: 1,
  speedBytesPerSecond: 0,
  files: ["D:\\ACGN\\Incoming\\file.mkv"],
  dedupeKey: "https://example.com/file.mkv",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("download completion events", () => {
  it("notifies subscribers and supports unsubscribe", () => {
    const received: DownloadTask[] = [];
    const stop = onDownloadCompleted((event) => received.push(event.task));
    emitDownloadCompleted(task);
    stop();
    emitDownloadCompleted(task);

    expect(received).toEqual([task]);
  });
});
