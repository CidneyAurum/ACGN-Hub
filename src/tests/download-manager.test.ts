import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadManager } from "@/application/download-manager";
import type { DownloadEngine, TaskRepository } from "@/application/ports";
import type { DownloadStatus, DownloadTask } from "@/domain/download";
import { getCompletedDownloadFiles, getCompletedDownloadOutputs } from "@/domain/download-output";

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return { id: "one", engineId: "aria2", sourceUrl: "https://example.org/one.zip", protocol: "http", directory: "C:\\Downloads", state: "queued", totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0, files: [], dedupeKey: "one", createdAt: "2026-10-01", updatedAt: "2026-10-01", ...overrides };
}
function fixture(initial: DownloadTask[] = [], slots = 1) {
  let persisted = structuredClone(initial);
  let tasks: DownloadTask[] = [];
  const repository: TaskRepository = {
    initialize: vi.fn(async () => undefined), list: vi.fn(async () => structuredClone(persisted)),
    insert: vi.fn(async (next) => { persisted.push(structuredClone(next)); }),
    update: vi.fn(async (next) => { persisted = persisted.map((entry) => entry.id === next.id ? structuredClone(next) : entry); }),
    remove: vi.fn(async (id) => { persisted = persisted.filter((entry) => entry.id !== id); }),
    findById: vi.fn(async (id) => persisted.find((entry) => entry.id === id)),
  };
  const status: DownloadStatus = { state: "downloading", totalBytes: 100, completedBytes: 10, speedBytesPerSecond: 5, files: ["C:\\Downloads\\one.zip"] };
  const engine: DownloadEngine = { id: "aria2", add: vi.fn(async () => "remote-one"), pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), status: vi.fn(async () => status) };
  const resolve = vi.fn((_id: string, _endpoint?: string) => engine);
  const completed = vi.fn();
  const settings: { maxConcurrentDownloads: number; speedLimitBytesPerSecond: number; aria2Endpoint?: string } = { maxConcurrentDownloads: slots, speedLimitBytesPerSecond: 0 };
  const manager = new DownloadManager({ repository, engine: resolve, settings: () => settings, onChange: (next) => { tasks = next; }, onComplete: completed });
  return { manager, engine, repository, resolve, completed, settings, tasks: () => tasks };
}

describe("download task lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("persists the native canonical directory so Android completed files remain readable and exportable", async () => {
    const declared = "/data/user/0/local.acgnhub.mobile/files/Files/Incoming";
    const canonical = "/data/data/local.acgnhub.mobile/files/Files/Incoming";
    const file = canonical + "/第一卷.txt";
    const f = fixture([task({ directory: declared, state: "downloading", engineTaskId: "active" })]);
    vi.mocked(f.engine.status).mockResolvedValue({ state: "completed", directory: canonical, totalBytes: 10, completedBytes: 10, speedBytesPerSecond: 0, files: [file] });
    await f.manager.refreshAll();
    expect(f.tasks()[0].directory).toBe(canonical);
    expect((await f.repository.findById("one"))?.directory).toBe(canonical);
    expect(getCompletedDownloadOutputs(f.tasks()[0])).toEqual([{ path: file, allowedRoot: canonical, label: "第一卷.txt" }]);
    expect(getCompletedDownloadFiles(f.tasks()[0])).toHaveLength(1);
  });
  it("pauses and cancels queued tasks without requiring a remote task id", async () => {
    const f = fixture([task()]);
    await f.manager.pause("one");
    expect(f.tasks()[0].state).toBe("paused");
    await f.manager.cancel("one");
    expect(f.tasks()[0].state).toBe("cancelled");
    expect(f.engine.pause).not.toHaveBeenCalled();
    expect(f.engine.cancel).not.toHaveBeenCalled();
  });

  it("starts the next waiting task when the active one is paused", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "active" }), task({ id: "two", sourceUrl: "https://example.org/two.zip" })]);
    await f.manager.pause("one");
    expect(f.tasks().map((entry) => entry.state)).toEqual(["paused", "downloading"]);
    expect(f.engine.add).toHaveBeenCalledTimes(1);
  });

  it("serializes simultaneous additions so duplicate links never reach the engine", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.manager.add("https://example.org/file.zip", "C:\\Downloads"), f.manager.add("https://example.org/file.zip#preview", "C:\\Downloads")]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(f.tasks()).toHaveLength(1);
    expect(f.engine.add).toHaveBeenCalledTimes(1);
  });

  it("preserves a paused task across an aria2 session reset", async () => {
    const f = fixture([task({ state: "paused", engineTaskId: "old" })]);
    vi.mocked(f.engine.status).mockResolvedValue({ state: "failed", errorCode: "ENGINE_TASK_NOT_FOUND", totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0, files: [] });
    await f.manager.refreshAll();
    expect(f.tasks()[0]).toMatchObject({ state: "paused", engineTaskId: undefined });
    expect(f.engine.add).not.toHaveBeenCalled();
    await f.manager.resume("one");
    expect(f.tasks()[0].state).toBe("downloading");
    expect(f.engine.add).toHaveBeenCalledTimes(1);
  });

  it("keeps a cancellation after a delayed refresh finishes", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "active" })]);
    let resolveStatus!: (status: DownloadStatus) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    vi.mocked(f.engine.status).mockImplementation(() => { notifyStarted(); return new Promise((resolve) => { resolveStatus = resolve; }); });
    const refresh = f.manager.refreshAll();
    await started;
    const cancellation = f.manager.cancel("one");
    resolveStatus({ state: "downloading", totalBytes: 10, completedBytes: 5, speedBytesPerSecond: 1, files: [] });
    await Promise.all([refresh, cancellation]);
    expect(f.tasks()[0].state).toBe("cancelled");
    expect(f.engine.cancel).toHaveBeenCalledTimes(1);
  });

  it("notifies completion once, then frees the next slot", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "active" }), task({ id: "two", sourceUrl: "https://example.org/two.zip" })]);
    vi.mocked(f.engine.status).mockResolvedValue({ state: "completed", totalBytes: 10, completedBytes: 10, speedBytesPerSecond: 0, files: ["C:\\Downloads\\one.zip"] });
    await f.manager.refreshAll();
    expect(f.tasks().map((entry) => entry.state)).toEqual(["completed", "downloading"]);
    expect(f.completed).toHaveBeenCalledTimes(1);
    vi.mocked(f.engine.status).mockResolvedValue({ state: "downloading", totalBytes: 10, completedBytes: 5, speedBytesPerSecond: 1, files: [] });
    await f.manager.refreshAll();
    expect(f.completed).toHaveBeenCalledTimes(1);
  });

  it("uses the embedded engine for new BitTorrent work without requiring external setup", async () => {
    const f = fixture();
    await f.manager.add("magnet:?xt=urn:btih:" + "a".repeat(40), "C:\\Downloads");
    expect(f.tasks()[0].engineId).toBe("aria2");
    expect(f.resolve).toHaveBeenCalledWith("aria2", undefined);
  });

  it("reports a missing external torrent without silently re-adding it", async () => {
    const f = fixture([task({ engineId: "qbittorrent", protocol: "torrent", sourceUrl: "https://example.org/a.torrent", state: "downloading", engineTaskId: "hash" })]);
    vi.mocked(f.engine.status).mockResolvedValue({ state: "failed", errorCode: "ENGINE_TASK_NOT_FOUND", error: "removed", totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0, files: [] });
    await f.manager.refreshAll();
    expect(f.tasks()[0].state).toBe("failed");
    expect(f.engine.add).not.toHaveBeenCalled();
  });

  it("stops a newly started remote job when its local record cannot be saved", async () => {
    const f = fixture([task()]);
    vi.mocked(f.repository.update).mockRejectedValueOnce(new Error("disk full"));
    await expect(f.manager.refreshAll()).rejects.toThrow("记录保存失败");
    expect(f.engine.cancel).toHaveBeenCalledWith("remote-one");
    expect(f.tasks()[0]).toMatchObject({ state: "failed", engineTaskId: undefined });
    await f.manager.refreshAll();
    expect(f.engine.add).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing job bound to its saved endpoint after settings change", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "active", engineEndpoint: "http://127.0.0.1:6800/jsonrpc" })]);
    f.settings.aria2Endpoint = "http://127.0.0.1:16800/jsonrpc";
    await f.manager.refreshAll();
    expect(f.resolve).toHaveBeenCalledWith("aria2", "http://127.0.0.1:6800/jsonrpc");
    expect(f.tasks()[0].engineEndpoint).toBe("http://127.0.0.1:6800/jsonrpc");
  });

  it("does not cancel a user-retried job on restart after a previous storage failure", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const f = fixture([task({ state: "downloading", engineTaskId: "old" })]);
    await f.manager.initialize();
    vi.mocked(f.repository.update).mockRejectedValueOnce(new Error("disk full"));
    await expect(f.manager.cancel("one")).rejects.toThrow("disk full");
    expect(f.tasks()[0].state).toBe("cancelled");
    await f.manager.retry("one");
    let restored: DownloadTask[] = [];
    const restarted = new DownloadManager({ repository: f.repository, engine: () => f.engine, settings: () => f.settings, onChange: (next) => { restored = next; } });
    await restarted.initialize();
    expect(restored[0]).toMatchObject({ state: "downloading", engineTaskId: "remote-one" });
  });

  it("persists the torrent content GID so future controls target the actual files", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "metadata", protocol: "torrent", sourceUrl: "https://example.org/a.torrent" })]);
    vi.mocked(f.engine.status).mockResolvedValue({ state: "downloading", engineTaskId: "content", totalBytes: 1000, completedBytes: 1, speedBytesPerSecond: 2, files: ["C:\\Downloads\\one.mkv"] });
    await f.manager.refreshAll();
    expect(f.tasks()[0].engineTaskId).toBe("content");
    await f.manager.pause("one");
    expect(f.engine.pause).toHaveBeenCalledWith("content");
  });

  it("fails one invalid engine configuration without blocking the next valid job", async () => {
    const f = fixture([task({ engineEndpoint: "http://external.invalid/jsonrpc" }), task({ id: "two", sourceUrl: "https://example.org/two.zip", engineEndpoint: "http://127.0.0.1:16800/jsonrpc" })]);
    f.resolve.mockImplementation((_id, endpoint) => {
      if (endpoint?.includes("external.invalid")) throw new Error("本机地址无效");
      return f.engine;
    });
    await f.manager.refreshAll();
    expect(f.tasks().map((entry) => entry.state)).toEqual(["failed", "downloading"]);
  });

  it("passes the original protocol and persists detailed BT diagnostics on refresh", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "metadata", protocol: "magnet", sourceUrl: "magnet:?xt=urn:btih:" + "a".repeat(40) })]);
    vi.mocked(f.engine.status).mockResolvedValue({ state: "downloading", stage: "fetching_metadata", totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0,
      connections: 2, peers: 2, seeders: 0, infoHash: "a".repeat(40), files: [] });
    await f.manager.refreshAll();
    expect(f.engine.status).toHaveBeenCalledWith("metadata", { protocol: "magnet" });
    expect(f.tasks()[0]).toMatchObject({ stage: "fetching_metadata", peers: 2, seeders: 0, infoHash: "a".repeat(40) });
    expect(f.repository.update).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "fetching_metadata", peers: 2 }));
  });

  it("keeps downloaded bytes and files on an engine connection failure and clears the stale error after recovery", async () => {
    const f = fixture([task({ state: "downloading", stage: "downloading", engineTaskId: "active", totalBytes: 1000, completedBytes: 500, speedBytesPerSecond: 100, files: ["C:\\Downloads\\episode.mkv"] })]);
    vi.mocked(f.engine.status).mockRejectedValueOnce(new Error("connection refused"));
    await f.manager.refreshAll();
    expect(f.tasks()[0]).toMatchObject({ state: "downloading", stage: "downloading", totalBytes: 1000, completedBytes: 500, files: ["C:\\Downloads\\episode.mkv"], speedBytesPerSecond: 0, errorCode: "ENGINE_UNREACHABLE" });
    vi.mocked(f.engine.status).mockResolvedValue({ state: "downloading", stage: "connecting", totalBytes: 1000, completedBytes: 500, speedBytesPerSecond: 0, files: ["C:\\Downloads\\episode.mkv"] });
    await f.manager.refreshAll();
    expect(f.tasks()[0].errorCode).toBeUndefined();
    expect(f.tasks()[0].error).toBeUndefined();
    expect(f.tasks()[0].stage).toBe("connecting");
  });

  it("distinguishes invalid or unauthorized status responses from network disconnection", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "active", completedBytes: 7 })]);
    vi.mocked(f.engine.status).mockRejectedValueOnce(new Error("Unauthorized"));
    await f.manager.refreshAll();
    expect(f.tasks()[0]).toMatchObject({ state: "downloading", completedBytes: 7, errorCode: "ENGINE_STATUS_UNAVAILABLE", error: "Unauthorized" });
    expect(f.engine.add).not.toHaveBeenCalled();
  });

  it("recovers old aria2 missing-GID failures on startup without reviving removed external torrents", async () => {
    const f = fixture([task({ state: "failed", engineTaskId: "old", errorCode: "ENGINE_TASK_NOT_FOUND", completedBytes: 50 }),
      task({ id: "external", engineId: "qbittorrent", protocol: "torrent", state: "failed", errorCode: "ENGINE_TASK_NOT_FOUND", sourceUrl: "https://example.org/external.torrent" })]);
    await f.manager.initialize();
    expect(f.tasks()[0]).toMatchObject({ state: "queued", engineTaskId: undefined, completedBytes: 50 });
    expect(f.tasks()[1].state).toBe("failed");
    await f.manager.refreshAll();
    expect(f.engine.add).toHaveBeenCalledOnce();
    expect(f.tasks()[0]).toMatchObject({ state: "downloading", engineTaskId: "remote-one" });
    expect(f.tasks()[1].state).toBe("failed");
  });

  it("recreates a missing aria2 handle when the user resumes, while preserving the original URL and directory", async () => {
    const f = fixture([task({ state: "paused", engineTaskId: "old", completedBytes: 50 })]);
    vi.mocked(f.engine.resume).mockRejectedValueOnce(new Error("GID old is not found"));
    await f.manager.resume("one");
    expect(f.engine.add).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.org/one.zip" }), expect.objectContaining({ directory: "C:\\Downloads" }));
    expect(f.tasks()[0]).toMatchObject({ state: "downloading", engineTaskId: "remote-one", completedBytes: 50 });
  });

  it("honors a user's pause after the metadata parent has generated an active content child", async () => {
    const f = fixture([task({ state: "paused", engineTaskId: "metadata", protocol: "torrent", sourceUrl: "https://example.org/episode.torrent" })]);
    vi.mocked(f.engine.status).mockResolvedValue({ state: "downloading", engineTaskId: "content", stage: "downloading", totalBytes: 1000, completedBytes: 20, speedBytesPerSecond: 100,
      files: ["C:\\Downloads\\episode.mkv"] });
    await f.manager.refreshAll();
    expect(f.engine.pause).toHaveBeenCalledWith("content");
    expect(f.tasks()[0]).toMatchObject({ state: "paused", engineTaskId: "content", completedBytes: 20, speedBytesPerSecond: 0, stage: undefined });
    expect(f.engine.resume).not.toHaveBeenCalled();
  });

  it("can retain a paused intent when the engine GID has already disappeared", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "old" })]);
    vi.mocked(f.engine.pause).mockRejectedValueOnce(new Error("GID old not found"));
    await f.manager.pause("one");
    expect(f.tasks()[0]).toMatchObject({ state: "paused", engineTaskId: undefined, stage: undefined });
    expect(f.engine.add).not.toHaveBeenCalled();
  });

  it("synchronizes active job limits once per settings or handle change, including disabling a previous limit", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "active" })]);
    f.engine.applySettings = vi.fn(async () => undefined);
    await f.manager.refreshAll();
    await f.manager.refreshAll();
    expect(f.engine.applySettings).toHaveBeenCalledTimes(1);
    f.settings.maxConcurrentDownloads = 8;
    f.settings.speedLimitBytesPerSecond = 2048;
    await f.manager.refreshAll();
    expect(f.engine.applySettings).toHaveBeenLastCalledWith({ maxConcurrentDownloads: 8, speedLimitBytesPerSecond: 2048 }, ["active"]);
    f.settings.speedLimitBytesPerSecond = 0;
    await f.manager.refreshAll();
    expect(f.engine.applySettings).toHaveBeenLastCalledWith({ maxConcurrentDownloads: 8, speedLimitBytesPerSecond: 0 }, ["active"]);
    await f.manager.add("https://example.org/two.zip", "C:\\Downloads");
    await f.manager.refreshAll();
    expect(f.engine.applySettings).toHaveBeenCalledTimes(4);
    expect(vi.mocked(f.engine.applySettings).mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["active", "remote-one"]));
  });

  it("continues progress polling when settings synchronization fails and retries that synchronization", async () => {
    const f = fixture([task({ state: "downloading", engineTaskId: "active" })]);
    f.engine.applySettings = vi.fn().mockRejectedValueOnce(new Error("RPC options temporarily unavailable")).mockResolvedValue(undefined);
    await expect(f.manager.refreshAll()).rejects.toThrow("设置未能同步");
    expect(f.tasks()[0]).toMatchObject({ completedBytes: 10, speedBytesPerSecond: 5, state: "downloading" });
    expect(f.engine.status).toHaveBeenCalledOnce();
    await f.manager.refreshAll();
    expect(f.engine.applySettings).toHaveBeenCalledTimes(2);
  });

  it("preserves known payload progress while reacquiring metadata, then accepts the content GID's actual resumed counters", async () => {
    for (const stage of ["fetching_torrent", "fetching_metadata"] as const) {
      const files = ["C:\\Downloads\\episode.mp4"];
      const f = fixture([task({ protocol: stage === "fetching_torrent" ? "torrent" : "magnet", state: "downloading", stage: "connecting", engineTaskId: "metadata",
        totalBytes: 416074928, completedBytes: 27279360, filename: "episode.mp4", files, infoHash: "a".repeat(40) })]);
      vi.mocked(f.engine.status).mockResolvedValue({ state: "downloading", stage, totalBytes: 9736, completedBytes: 9736, speedBytesPerSecond: 9736,
        filename: "episode.torrent", files: ["C:\\Downloads\\episode.torrent"] });
      await f.manager.refreshAll();
      await f.manager.refreshAll();
      expect(f.tasks()[0]).toMatchObject({ stage, totalBytes: 416074928, completedBytes: 27279360, files, filename: "episode.mp4", speedBytesPerSecond: 0, infoHash: "a".repeat(40) });
      vi.mocked(f.engine.status).mockResolvedValue({ state: "downloading", stage: "checking", engineTaskId: "content", totalBytes: 416074928, completedBytes: 20000000,
        speedBytesPerSecond: 0, files, verifiedBytes: 20000000 });
      await f.manager.refreshAll();
      expect(f.tasks()[0]).toMatchObject({ engineTaskId: "content", stage: "checking", completedBytes: 20000000, verifiedBytes: 20000000, files });
    }
  });
});
