import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useDownloadStore } from "@/stores/download";
import type { DownloadTask } from "@/domain/download";

const fixture = vi.hoisted(() => ({ rows: [] as DownloadTask[], renameFails: false, pendingRecovery: false,
  invoke: vi.fn(), engine: { id: "aria2", add: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), status: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fixture.invoke }));
vi.mock("@/infrastructure/download/create-download-engine", () => ({ createDownloadEngine: () => fixture.engine }));
vi.mock("@/infrastructure/database/create-task-repository", () => ({ createTaskRepository: async () => ({
  list: async () => structuredClone(fixture.rows),
  findById: async (id: string) => structuredClone(fixture.rows.find((row) => row.id === id)),
  update: async (task: DownloadTask) => { fixture.rows = fixture.rows.map((row) => row.id === task.id ? structuredClone(task) : row); },
  insert: async (task: DownloadTask) => { fixture.rows.push(structuredClone(task)); }, remove: vi.fn(),
}) }));
vi.mock("@/infrastructure/library/create-media-library-repository", () => ({ createMediaLibraryRepository: async () => ({
  list: async () => [{ id: "m", type: "anime", title: "测试中文番剧", aliases: [], externalIds: [], metadata: {} }],
}) }));
vi.mock("@/infrastructure/database/create-resource-repository", () => ({ createResourceRepository: async () => ({
  findById: async () => undefined,
}) }));
vi.mock("@/application/download-events", () => ({ emitDownloadCompleted: vi.fn() }));

function task(state: DownloadTask["state"] = "completed"): DownloadTask {
  return { id: "t", engineId: "aria2", engineTaskId: "0123456789abcdef", engineEndpoint: "http://127.0.0.1:16800/jsonrpc", sourceUrl: "https://example.org/episode.torrent",
    protocol: "torrent", directory: "D:\\Incoming", filename: "[Group] English Title [01].mp4", mediaId: "m",
    state, totalBytes: 100, completedBytes: state === "completed" ? 100 : 50, speedBytesPerSecond: 0,
    files: ["D:\\Incoming\\[Group] English Title [01].mp4"], dedupeKey: "torrent:one", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}

beforeEach(() => {
  setActivePinia(createPinia());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  fixture.rows = [task()]; fixture.renameFails = false; fixture.pendingRecovery = false;
  fixture.invoke.mockReset().mockImplementation(async (command: string, input: { taskId?: string; sourcePath?: string; newFileName?: string }) => {
    if (command === "recover_completed_download_renames") return { recovered: 0, pending: fixture.pendingRecovery ? 1 : 0, messages: fixture.pendingRecovery ? ["请恢复原文件位置"] : [] };
    if (command !== "rename_completed_download") throw new Error("Unexpected native command: " + command);
    if (fixture.renameFails) throw new Error("目标文件已存在，未覆盖");
    fixture.rows = fixture.rows.map((row) => row.id !== input.taskId ? row : ({ ...row, filename: input.newFileName,
      files: ["D:\\Incoming\\" + input.newFileName], naming: { status: "renamed", originalFileName: row.filename, originalPath: input.sourcePath,
        currentFileName: input.newFileName, renamedAt: "2026-01-02" } }));
    return { status: "renamed" };
  });
  fixture.engine.status.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("completed download naming integration", () => {
  it("names older completed files once during initialization and reloads native-updated paths", async () => {
    const store = useDownloadStore(); await store.initialize();
    await vi.waitFor(() => expect(store.tasks[0].naming?.status).toBe("renamed"));
    expect(store.tasks[0]).toMatchObject({ state: "completed", filename: "测试中文番剧 - 第01话.mp4", files: ["D:\\Incoming\\测试中文番剧 - 第01话.mp4"] });
    expect(fixture.invoke.mock.calls.filter(([command]) => command === "rename_completed_download")).toHaveLength(1);
    await store.initialize();
    expect(fixture.invoke.mock.calls.filter(([command]) => command === "rename_completed_download")).toHaveLength(1);
  });
  it("waits for the engine's completion before renaming a new file", async () => {
    fixture.rows = [task("downloading")];
    const store = useDownloadStore(); await store.initialize();
    expect(fixture.invoke.mock.calls.some(([command]) => command === "rename_completed_download")).toBe(false);
    fixture.engine.status.mockResolvedValue({ state: "completed", totalBytes: 100, completedBytes: 100, speedBytesPerSecond: 0, files: task().files });
    await store.refreshAll();
    await vi.waitFor(() => expect(store.tasks[0].naming?.status).toBe("renamed"));
    expect(store.tasks[0].completedBytes).toBe(100);
  });
  it("preserves original files and completed state when naming conflicts", async () => {
    fixture.renameFails = true;
    const original = task();
    const store = useDownloadStore(); await store.initialize();
    await vi.waitFor(() => expect(store.tasks[0].naming?.status).toBe("failed"));
    expect(store.tasks[0]).toMatchObject({ state: "completed", files: original.files, filename: original.filename, naming: { message: "目标文件已存在，未覆盖" } });
  });
  it("respects a disabled automatic setting while still allowing explicit naming", async () => {
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ autoRenameDownloads: false }));
    const store = useDownloadStore(); await store.initialize();
    expect(fixture.invoke.mock.calls.some(([command]) => command === "rename_completed_download")).toBe(false);
    const preview = await store.previewName(store.tasks[0]);
    await store.renameCompleted(store.tasks[0], preview.newFileName!, preview.filePath);
    expect(store.tasks[0].naming?.status).toBe("renamed");
  });
  it("does not start automatic or explicit renaming over an unresolved recovery", async () => {
    fixture.pendingRecovery = true;
    const store = useDownloadStore(); await store.initialize();
    expect(store.namingRecoveryMessage).toBe("请恢复原文件位置");
    await expect(store.renameCompleted(store.tasks[0], "测试中文番剧 - 第01话.mp4")).rejects.toThrow("请恢复");
    expect(fixture.invoke.mock.calls.some(([command]) => command === "rename_completed_download")).toBe(false);
  });
  it("does not invalidate the native recovery snapshot after a rollback cannot finish", async () => {
    fixture.renameFails = true;
    const implementation = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation(async (command, input) => {
      if (command === "rename_completed_download") fixture.pendingRecovery = true;
      return implementation(command, input);
    });
    const original = structuredClone(fixture.rows[0]);
    const store = useDownloadStore(); await store.initialize();
    await vi.waitFor(() => expect(store.namingRecoveryMessage).toBe("请恢复原文件位置"));
    expect(fixture.rows[0]).toEqual(original);
    expect(store.tasks[0].state).toBe("completed");
    expect(store.tasks[0].naming).toBeUndefined();
  });
});
