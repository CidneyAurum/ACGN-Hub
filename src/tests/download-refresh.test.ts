import { describe, expect, it } from "vitest";
import type { DownloadTask } from "@/domain/download";
import { needsBackgroundDownloadRefresh } from "@/shared/download-refresh";

function task(overrides: Partial<DownloadTask>): DownloadTask {
  return {
    id: "task-1",
    engineId: "aria2",
    sourceUrl: "https://example.com/file.zip",
    protocol: "http",
    directory: "D:\\Incoming",
    state: "failed",
    totalBytes: 0,
    completedBytes: 0,
    speedBytesPerSecond: 0,
    files: [],
    dedupeKey: "test",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("download background refresh", () => {
  it("keeps live tasks in the refresh set", () => {
    expect(needsBackgroundDownloadRefresh(task({ state: "downloading" }))).toBe(true);
    expect(needsBackgroundDownloadRefresh(task({ state: "queued" }))).toBe(true);
    expect(needsBackgroundDownloadRefresh(task({ state: "paused" }))).toBe(true);
  });

  it("re-drives tasks whose engine GID vanished after an aria2 switch", () => {
    expect(needsBackgroundDownloadRefresh(task({ errorCode: "ENGINE_TASK_NOT_FOUND" }))).toBe(true);
  });

  it("does not wake an ordinary terminal failure forever", () => {
    expect(needsBackgroundDownloadRefresh(task({ errorCode: "3" }))).toBe(false);
  });
});
