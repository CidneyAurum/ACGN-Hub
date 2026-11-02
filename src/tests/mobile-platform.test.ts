import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DownloadManager } from "@/application/download-manager";
import type { TaskRepository } from "@/application/ports";
import type { DownloadTask, DownloadStatus } from "@/domain/download";
import { joinWindowsPath, isPathInside } from "@/domain/organization";
import { assertDownloadDirectory } from "@/shared/validation";
import { isAndroidRuntime, setRuntimePlatform } from "@/shared/runtime";
import { MobileHttpClient } from "@/infrastructure/download/mobile-http-client";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { userAgent: "Android WebView" });
  setRuntimePlatform("android"); invoke.mockReset();
});
afterEach(() => { setRuntimePlatform(""); vi.unstubAllGlobals(); });

function fixture(initial: DownloadTask[] = []) {
  let rows = structuredClone(initial);
  const repository: TaskRepository = {
    initialize: async () => {}, list: async () => structuredClone(rows),
    insert: async (task) => { rows.push(structuredClone(task)); },
    update: async (task) => { rows = rows.map((item) => item.id === task.id ? structuredClone(task) : item); },
    remove: async (id) => { rows = rows.filter((item) => item.id !== id); },
    findById: async (id) => rows.find((item) => item.id === id),
  };
  const engine = new MobileHttpClient();
  const resolve = vi.fn((id: string) => { expect(id).toBe("mobile_http"); return engine; });
  const manager = new DownloadManager({ repository, engine: resolve,
    settings: () => ({ httpDownloadEngine: "mobile_http", maxConcurrentDownloads: 2, speedLimitBytesPerSecond: 0 }), onChange: () => {} });
  return { manager, resolve, rows: () => rows };
}

it("uses Android absolute paths while keeping case-sensitive boundaries and Windows behavior", () => {
  const root = "/data/user/0/local.acgnhub.mobile/files/Files";
  expect(assertDownloadDirectory(root)).toBe(root);
  expect(joinWindowsPath(root, "Books", "小说.txt")).toBe(root + "/Books/小说.txt");
  expect(isPathInside(root, root + "/Books/小说.txt")).toBe(true);
  expect(isPathInside(root, root.toLowerCase().replace("Files", "files") + "/小说.txt")).toBe(false);
  expect(() => assertDownloadDirectory("C:\\Downloads")).toThrow();
  expect(() => assertDownloadDirectory(root + "/../outside")).toThrow();
  setRuntimePlatform("windows");
  expect(isAndroidRuntime()).toBe(false);
  expect(() => assertDownloadDirectory(root)).toThrow("Windows");
  expect(joinWindowsPath("D:\\Books", "小说.txt")).toBe("D:\\Books\\小说.txt");
});

it("creates a native HTTP task and never starts a Windows RPC engine on Android", async () => {
  const f = fixture();
  invoke.mockResolvedValue({ engineTaskId: "native1", state: "downloading" });
  await f.manager.add("https://files.example.org/archive.zip", "/data/user/0/local.acgnhub.mobile/files/Files/Incoming");
  expect(f.rows()[0]).toMatchObject({ engineId: "mobile_http", engineTaskId: "native1", state: "downloading" });
  expect(f.rows()[0].engineEndpoint).toBeUndefined();
  expect(invoke).toHaveBeenCalledWith("mobile_http_start", expect.objectContaining({ url: "https://files.example.org/archive.zip", filename: "archive.zip" }));
  expect(f.resolve.mock.calls.every(([id]) => id === "mobile_http")).toBe(true);
});

it("keeps a manually entered long Chinese HTTP filename within native byte limits and preserves its zip suffix", async () => {
  const f = fixture();
  invoke.mockResolvedValue({ engineTaskId: "long-name", state: "queued" });
  const original = "很长的中文作品与日本語ゲーム🌸".repeat(25) + ".zip";
  const url = "https://files.example.org/" + encodeURIComponent(original);
  await f.manager.add(url, "/data/user/0/local.acgnhub.mobile/files/Files/Incoming");
  const filename = f.rows()[0].filename!;
  expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(220);
  expect(filename.endsWith(".zip")).toBe(true);
  expect(new TextDecoder().decode(new TextEncoder().encode(filename))).toBe(filename);
  expect(f.rows()[0].engineId).toBe("mobile_http");
  expect(invoke).toHaveBeenCalledWith("mobile_http_start", expect.objectContaining({ url, filename }));
});

it("rejects magnets and torrent tasks without saving phantom jobs", async () => {
  const f = fixture();
  await expect(f.manager.add("magnet:?xt=urn:btih:" + "a".repeat(40), "/data/files")).rejects.toThrow("安卓版本暂不支持");
  await expect(f.manager.add("https://files.example.org/a.torrent", "/data/files")).rejects.toThrow("安卓版本暂不支持");
  expect(f.rows()).toEqual([]); expect(invoke).not.toHaveBeenCalled();
});

it("retains the native handle across app restart and reflects a safely paused transfer", async () => {
  const row: DownloadTask = { id: "saved", engineId: "mobile_http", engineTaskId: "persisted", sourceUrl: "https://files.example.org/archive.zip", protocol: "http", directory: "/data/files", state: "downloading", totalBytes: 1000, completedBytes: 500, speedBytesPerSecond: 20, files: [], dedupeKey: "saved", createdAt: "2026-11-01", updatedAt: "2026-11-01" };
  const status: DownloadStatus = { engineTaskId: "persisted", state: "paused", totalBytes: 1000, completedBytes: 500, speedBytesPerSecond: 0, files: [] };
  invoke.mockResolvedValue(status);
  const f = fixture([row]); await f.manager.initialize(); await f.manager.refreshAll();
  expect(f.rows()[0]).toMatchObject({ engineId: "mobile_http", engineTaskId: "persisted", state: "paused", completedBytes: 500 });
  expect(invoke).toHaveBeenCalledWith("mobile_http_status", { taskId: "persisted" });
  expect(invoke.mock.calls.every(([name]) => name !== "mobile_http_start")).toBe(true);
});

it("normalizes a native nullable error before persisting task status", async () => {
  const f = fixture();
  invoke.mockResolvedValueOnce({ engineTaskId: "nullable", state: "downloading" });
  await f.manager.add("https://files.example.org/archive.zip", "/data/files");
  invoke.mockResolvedValue({ engineTaskId: "nullable", state: "completed", totalBytes: 100, completedBytes: 100, speedBytesPerSecond: 0, files: ["/data/files/archive.zip"], error: null });
  await f.manager.refreshAll();
  expect(f.rows()[0]).toMatchObject({ state: "completed", completedBytes: 100 });
  expect(f.rows()[0].error).toBeUndefined();
});

it("retries a failed native transfer with its existing partial-file handle", async () => {
  const row: DownloadTask = { id: "retry", engineId: "mobile_http", engineTaskId: "partial", sourceUrl: "https://files.example.org/archive.zip", protocol: "http", directory: "/data/files", state: "failed", totalBytes: 1000, completedBytes: 500, speedBytesPerSecond: 0, files: [], dedupeKey: "retry", createdAt: "2026-11-01", updatedAt: "2026-11-01" };
  invoke.mockResolvedValue({ engineTaskId: "partial", state: "downloading" });
  const f = fixture([row]);
  await f.manager.retry("retry");
  expect(f.rows()[0]).toMatchObject({ state: "downloading", engineTaskId: "partial", completedBytes: 500 });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("mobile_http_resume", { taskId: "partial" });
});

it.each(["pause", "cancel"] as const)("preserves completion when native %s races with the final write", async (action) => {
  const f = fixture();
  invoke.mockResolvedValueOnce({ engineTaskId: "finished", state: "downloading" });
  await f.manager.add("https://files.example.org/archive.zip", "/data/files");
  const id = f.rows()[0].id;
  const completed = { engineTaskId: "finished", state: "completed", totalBytes: 100, completedBytes: 100, speedBytesPerSecond: 0, files: ["/data/files/archive.zip"] };
  invoke.mockResolvedValue(completed);
  await expect(f.manager[action](id)).rejects.toThrow("已完成下载");
  expect(f.rows()[0].engineTaskId).toBe("finished");
  expect(f.rows()[0].state).toBe("downloading");
  await f.manager.refreshAll();
  expect(f.rows()[0]).toMatchObject({ state: "completed", engineTaskId: "finished", completedBytes: 100 });
});
