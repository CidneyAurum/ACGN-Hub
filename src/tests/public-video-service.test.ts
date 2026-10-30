import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadPublicVideo } from "@/infrastructure/video/tauri-public-video-service";
import { createPinia, setActivePinia } from "pinia";
import { useLocalDownloadStore } from "@/stores/local-download";

const { invoke, listen, unlisten } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const input = { url: "https://www.bilibili.com/video/BV1UqHi6uEie/", outputRoot: "C:\\Library", outputPath: "C:\\Library\\episode.mp4", operationId: "operation-one" };

describe("public video download integration", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    invoke.mockReset(); listen.mockReset(); unlisten.mockReset();
    listen.mockResolvedValue(unlisten);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("scopes progress to one operation and removes the listener after completion", async () => {
    const progress = vi.fn();
    listen.mockImplementation(async (_event, callback) => {
      invoke.mockImplementation(async () => {
        callback({ payload: { id: "other", percent: 50, stage: "downloading" } });
        callback({ payload: { id: input.operationId, percent: 25, downloadedBytes: 25, totalBytes: 100, stage: "downloading" } });
        return { outputPath: input.outputPath, sizeBytes: 100 };
      });
      return unlisten;
    });
    await expect(downloadPublicVideo({ ...input, onProgress: progress })).resolves.toMatchObject({ sizeBytes: 100 });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("download_public_video", input);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("sends cancellation only to its own worker and cleans up the listener on failure", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let rejectWorker!: (cause: Error) => void;
    invoke.mockImplementation((command) => command === "download_public_video"
      ? new Promise((_resolve, reject) => { rejectWorker = reject; })
      : Promise.resolve());
    const pending = downloadPublicVideo({ ...input, isCancelled: () => cancelled });
    const failed = expect(pending).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke.mock.calls.filter(([name]) => name === "cancel_public_video")).toEqual([["cancel_public_video", { id: input.operationId }]]);
    rejectWorker(new Error("cancelled"));
    await failed;
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("restores completed MP4 tasks and keeps their output ownership", async () => {
    setActivePinia(createPinia());
    const store = useLocalDownloadStore();
    const id = store.create({ kind: "video", title: "第1话", sourceName: "公开投稿", directory: input.outputRoot, outputPath: input.outputPath, totalUnits: 100 });
    await store.complete(id);
    setActivePinia(createPinia());
    const reopened = useLocalDownloadStore(); reopened.initialize();
    expect(reopened.error).toBe("");
    expect(reopened.tasks[0]).toMatchObject({ kind: "video", stage: "completed", completedUnits: 100, cleanupPaths: [{ path: input.outputPath, allowedRoot: input.outputRoot }] });
  });
});
