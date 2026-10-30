import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useLocalDownloadStore } from "@/stores/local-download";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

const input = { kind: "manga" as const, title: "测试漫画", sourceName: "测试来源", directory: "C:\\Books", outputPath: "C:\\Books\\chapter.cbz" };

describe("local download ownership and cancellation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["broken JSON", "{}", '[{"id":"bad","outputPath":"C:\\\\Books\\\\bad.cbz"}]'])
    ("preserves malformed storage and visibly blocks later writes: %s", (raw) => {
      localStorage.setItem("acgn-hub.local-download-tasks.v1", raw);
      const store = useLocalDownloadStore();
      expect(() => store.initialize()).not.toThrow();
      expect(store.error).toContain("原始文本已保留");
      expect(() => store.create(input)).toThrow("已停止写入");
      expect(localStorage.getItem("acgn-hub.local-download-tasks.v1")).toBe(raw);
      expect(store.tasks).toEqual([]);
    });

  it("keeps all valid history entries instead of truncating them to 100", async () => {
    const completed = Array.from({ length: 120 }, (_, index) => ({ ...input, id: `history-${index}`, stage: "completed", completedUnits: 1, totalUnits: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" }));
    localStorage.setItem("acgn-hub.local-download-tasks.v1", JSON.stringify(completed));
    const store = useLocalDownloadStore();
    const id = store.create(input);
    await store.complete(id);
    expect(JSON.parse(localStorage.getItem("acgn-hub.local-download-tasks.v1")!)).toHaveLength(121);
  });

  it("backs up the exact damaged text before rebuilding records without deleting files", () => {
    const raw = "{ damaged original text";
    localStorage.setItem("acgn-hub.local-download-tasks.v1", raw);
    const store = useLocalDownloadStore();
    store.initialize();
    const backupKey = store.backupAndRebuild();
    expect(JSON.parse(localStorage.getItem(backupKey)!).rawText).toBe(raw);
    expect(localStorage.getItem("acgn-hub.local-download-tasks.v1")).toBe("[]");
    expect(store.error).toBe("");
    expect(() => store.create(input)).not.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not clear original data when the backup cannot be written", () => {
    const raw = "damaged original";
    localStorage.setItem("acgn-hub.local-download-tasks.v1", raw);
    const store = useLocalDownloadStore();
    store.initialize();
    const originalWrite = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key.includes(".backup.")) throw new Error("quota exceeded");
      originalWrite(key, value);
    });
    expect(() => store.backupAndRebuild()).toThrow("尚未清空原始记录");
    expect(localStorage.getItem("acgn-hub.local-download-tasks.v1")).toBe(raw);
    expect(store.error).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not delete an existing destination after output creation fails", async () => {
    const store = useLocalDownloadStore();
    const id = store.create(input);
    await store.fail(id, "destination already exists");
    await store.remove(store.tasks[0], true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("waits for a cancelled worker before deleting its own newly created output", async () => {
    const store = useLocalDownloadStore();
    const id = store.create({ ...input, cleanupPaths: [{ path: "C:\\Incoming\\temp-1", allowedRoot: "C:\\Incoming" }] });
    await store.cancel(id);
    expect(invokeMock).not.toHaveBeenCalled();
    await expect(store.remove(store.tasks[0], true)).rejects.toThrow("当前步骤");
    await expect(store.complete(id)).resolves.toBe(false);
    expect(store.tasks[0].stage).toBe("cancelled");
    expect(invokeMock.mock.calls.map((call) => call[1].paths[0])).toEqual(["C:\\Incoming\\temp-1", input.outputPath]);
    expect(store.isRunning(id)).toBe(false);
  });

  it("grants final-file cleanup only after the writer reports success", async () => {
    const store = useLocalDownloadStore();
    const id = store.create(input);
    await expect(store.complete(id)).resolves.toBe(true);
    await store.remove(store.tasks[0], true);
    expect(invokeMock).toHaveBeenCalledWith("delete_download_files", { paths: [input.outputPath], allowedRoot: input.directory });
  });

  it("does not trust final-path cleanup registered by an older failed task", async () => {
    localStorage.setItem("acgn-hub.local-download-tasks.v1", JSON.stringify([{ ...input, id: "old", stage: "failed", completedUnits: 0, totalUnits: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", cleanupPaths: [{ path: input.outputPath, allowedRoot: input.directory }] }]));
    const store = useLocalDownloadStore();
    store.initialize();
    await store.remove(store.tasks[0], true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps a successfully written output when completion-history storage fails and can persist that result later", async () => {
    const store = useLocalDownloadStore();
    const id = store.create({ ...input, totalUnits: 20 });
    const files = new Set([input.outputPath]); // The simulated native writer has confirmed this file.
    invokeMock.mockImplementation(async (_command, args: { paths: string[] }) => { for (const path of args.paths) files.delete(path); });
    const originalWrite = localStorage.setItem.bind(localStorage);
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });

    await expect(store.complete(id, input.outputPath)).resolves.toBe(true);
    expect(store.tasks[0]).toMatchObject({ stage: "completed", completedUnits: 20, outputPath: input.outputPath });
    expect(store.persistencePending).toBe(true);
    expect(store.error).toContain("尚未保存");
    expect(JSON.parse(localStorage.getItem("acgn-hub.local-download-tasks.v1")!)[0].stage).toBe("preparing");
    await store.fail(id, "the page's later notification failed");
    expect(files.has(input.outputPath)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(store.tasks[0].stage).toBe("completed");
    expect(store.isRunning(id)).toBe(false);
    expect(() => store.backupAndRebuild()).toThrow("尚未保存的任务结果");
    expect(JSON.parse(store.exportRawRecords()).pendingTasks[0].stage).toBe("completed");
    expect(() => store.retryPersistence()).toThrow("尚未保存");
    expect(store.persistencePending).toBe(true);
    write.mockImplementation(originalWrite);
    store.retryPersistence();
    expect(store.persistencePending).toBe(false);
    expect(store.error).toBe("");
    expect(JSON.parse(localStorage.getItem("acgn-hub.local-download-tasks.v1")!)[0].stage).toBe("completed");
    expect(files.has(input.outputPath)).toBe(true);
  });

  it("keeps progress in memory after a quota fault and ignores late progress after native completion", async () => {
    const store = useLocalDownloadStore();
    const id = store.create({ ...input, totalUnits: 100 });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    expect(() => store.update(id, { stage: "downloading", completedUnits: 40 })).not.toThrow();
    expect(store.tasks[0]).toMatchObject({ stage: "downloading", completedUnits: 40 });
    await expect(store.complete(id)).resolves.toBe(true);
    store.update(id, { stage: "downloading", completedUnits: 30 });
    expect(store.tasks[0]).toMatchObject({ stage: "completed", completedUnits: 100 });
    expect(store.persistencePending).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps failed cleanup from changing the success of an already completed output", async () => {
    const store = useLocalDownloadStore();
    const id = store.create(input);
    await store.complete(id);
    invokeMock.mockRejectedValue(new Error("file is open"));
    await expect(store.remove(store.tasks[0], true)).rejects.toThrow("file is open");
    expect(store.tasks[0].stage).toBe("completed");
    invokeMock.mockClear();
    await store.fail(id, "cleanup failed");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(store.tasks[0].stage).toBe("completed");
  });

  it("cleans only the owned temporary directory after a real transfer failure during a storage fault", async () => {
    const store = useLocalDownloadStore();
    const temp = { path: "C:\\Incoming\\owned-temp", allowedRoot: "C:\\Incoming" };
    const id = store.create({ ...input, cleanupPaths: [temp] });
    const files = new Set([input.outputPath, temp.path]); // Existing destination belongs to somebody else.
    invokeMock.mockImplementation(async (_command, args: { paths: string[] }) => { for (const path of args.paths) files.delete(path); });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    await store.fail(id, "native image fetch failed");
    expect(store.tasks[0].stage).toBe("failed");
    expect(files.has(temp.path)).toBe(false);
    expect(files.has(input.outputPath)).toBe(true);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("delete_download_files", { paths: [temp.path], allowedRoot: temp.allowedRoot });
    expect(store.persistencePending).toBe(true);
  });

  it("warns after restart that an interrupted record may already have a finished output and never assumes ownership", () => {
    localStorage.setItem("acgn-hub.local-download-tasks.v1", JSON.stringify([{ ...input, id: "interrupted", stage: "packaging", completedUnits: 20, totalUnits: 20, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]));
    const store = useLocalDownloadStore();
    store.initialize();
    expect(store.tasks[0]).toMatchObject({ stage: "failed", outputPath: input.outputPath });
    expect(store.tasks[0].error).toContain("文件可能已经生成");
    expect(store.tasks[0].cleanupPaths).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("consumes cancelled output ownership once, preserving a later same-path download through late callbacks and old-record removal", async () => {
    const files = new Map<string, string>();
    invokeMock.mockImplementation(async (_command, args: { paths: string[] }) => { for (const path of args.paths) files.delete(path); });
    const store = useLocalDownloadStore();
    const a = store.create(input);
    await store.cancel(a);
    files.set(input.outputPath, "cancelled-A");
    await expect(store.complete(a)).resolves.toBe(false);
    const old = store.tasks.find((task) => task.id === a)!;
    expect(old.cleanupPaths).toEqual([]);
    const b = store.create(input);
    files.set(input.outputPath, "completed-B");
    await store.complete(b);
    await expect(store.complete(a)).resolves.toBe(false);
    await store.fail(a, "late callback");
    await store.remove(old, true);
    expect(files.get(input.outputPath)).toBe("completed-B");
    expect(store.ownedOutputPath(b)).toBe(input.outputPath);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await store.remove(store.tasks.find((task) => task.id === b)!, true);
    expect(files.has(input.outputPath)).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("transfers a reused completed path to the newest writer and ignores a stale UI snapshot's cleanup permissions", async () => {
    const files = new Map<string, string>();
    invokeMock.mockImplementation(async (_command, args: { paths: string[] }) => { for (const path of args.paths) files.delete(path); });
    const store = useLocalDownloadStore();
    const a = store.create(input); files.set(input.outputPath, "A"); await store.complete(a);
    const old = JSON.parse(JSON.stringify(store.tasks.find((task) => task.id === a)!));
    files.delete(input.outputPath); // User removed A outside the application.
    const b = store.create(input); files.set(input.outputPath, "B"); await store.complete(b);
    expect(store.ownedOutputPath(a)).toBeUndefined();
    expect(store.tasks.find((task) => task.id === a)?.detail).toContain("新的下载任务");
    await store.complete(a); await store.fail(a, "late error"); await store.remove(old, true);
    expect(files.get(input.outputPath)).toBe("B");
    expect(invokeMock).not.toHaveBeenCalled();
    await store.remove(store.tasks.find((task) => task.id === b)!, true);
    expect(files.has(input.outputPath)).toBe(false);
  });

  it("reserves a writer's output before native publication and blocks an old record from deleting it", async () => {
    const store = useLocalDownloadStore();
    const a = store.create(input); await store.complete(a);
    const old = store.tasks.find((task) => task.id === a)!;
    const b = store.create({ ...input, outputPath: "c:/books/CHAPTER.cbz" });
    expect(() => store.create(input)).toThrow("相同输出路径");
    await expect(store.remove(old, true)).rejects.toThrow("新的下载任务正在生成");
    expect(invokeMock).not.toHaveBeenCalled();
    await store.complete(b);
    await store.remove(old, true);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(store.ownedOutputPath(b)).toBe("c:/books/CHAPTER.cbz");
  });

  it("blocks a new writer while deletion is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    invokeMock.mockImplementation(async () => gate);
    const store = useLocalDownloadStore();
    const a = store.create(input); await store.complete(a);
    const removal = store.remove(store.tasks[0], true);
    expect(() => store.create(input)).toThrow("正在生成或清理");
    expect(() => store.backupAndRebuild()).toThrow("文件清理操作");
    release(); await removal;
    expect(() => store.create(input)).not.toThrow();
  });

  it("blocks writes inside a parent temporary directory while that directory is being cleaned", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    invokeMock.mockImplementation(async () => gate);
    const store = useLocalDownloadStore();
    const temp = { path: "C:\\Incoming\\owned", allowedRoot: "C:\\Incoming" };
    const a = store.create({ ...input, cleanupPaths: [temp] });
    const failing = store.fail(a, "native failure");
    expect(() => store.create({ ...input, outputPath: "c:/incoming/OWNED/new.cbz" })).toThrow("正在生成或清理");
    release(); await failing;
    const b = store.create({ ...input, outputPath: "c:/incoming/OWNED/new.cbz" });
    await store.complete(b);
    await store.remove(store.tasks.find((task) => task.id === a)!, true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(store.ownedOutputPath(b)).toBe("c:/incoming/OWNED/new.cbz");
  });

  it("consumes successful paths before a partial cleanup failure and retries only the still-owned remainder", async () => {
    const first = { path: "C:\\Incoming\\temp-first", allowedRoot: "C:\\Incoming" };
    const second = { path: "C:\\Incoming\\temp-second", allowedRoot: "C:\\Incoming" };
    const files = new Map([[first.path, "A-temp"], [second.path, "A-temp"], [input.outputPath, "A-output"]]);
    let failSecond = true;
    invokeMock.mockImplementation(async (_command, args: { paths: string[] }) => {
      const path = args.paths[0];
      if (path === second.path && failSecond) throw new Error("second path is busy");
      files.delete(path);
    });
    const store = useLocalDownloadStore();
    const a = store.create({ ...input, cleanupPaths: [first, second] }); await store.cancel(a);
    await expect(store.complete(a)).rejects.toThrow("second path is busy");
    expect(store.tasks[0].cleanupPaths?.map((item) => item.path)).toEqual([second.path, input.outputPath]);
    files.set(first.path, "unrelated replacement after consumed cleanup");
    await expect(store.complete(a)).resolves.toBe(false); // Native result cannot grant ownership a second time.
    failSecond = false; await store.fail(a, "late failure while cancellation settles");
    expect(files.get(first.path)).toContain("unrelated replacement");
    expect(files.has(second.path)).toBe(false); expect(files.has(input.outputPath)).toBe(false);
    expect(invokeMock.mock.calls.map((call) => call[1].paths[0])).toEqual([first.path, second.path, second.path, input.outputPath]);
    await store.remove(store.tasks[0], true);
    expect(invokeMock).toHaveBeenCalledTimes(4);
  });

  it("retains same-path ownership revocation when its persistence fails, blocking deletion until the current snapshot is saved", async () => {
    const files = new Map<string, string>();
    invokeMock.mockImplementation(async (_command, args: { paths: string[] }) => { for (const path of args.paths) files.delete(path); });
    const store = useLocalDownloadStore();
    const a = store.create(input); files.set(input.outputPath, "A"); await store.complete(a);
    const old = JSON.parse(JSON.stringify(store.tasks[0])); files.delete(input.outputPath);
    const b = store.create(input); files.set(input.outputPath, "B");
    const original = localStorage.setItem.bind(localStorage);
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    await store.complete(b);
    await expect(store.remove(old, true)).rejects.toThrow("尚未保存");
    expect(files.get(input.outputPath)).toBe("B");
    expect(store.ownedOutputPath(a)).toBeUndefined(); expect(store.persistencePending).toBe(true);
    write.mockImplementation(original); store.retryPersistence();
    await store.remove(old, true);
    expect(files.get(input.outputPath)).toBe("B"); expect(invokeMock).not.toHaveBeenCalled();
  });

  it("revokes ambiguous legacy deletion claims durably rather than guessing which duplicate completed record owns the file", async () => {
    const shared = { ...input, stage: "completed", completedUnits: 1, totalUnits: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", cleanupPaths: [{ path: input.outputPath, allowedRoot: input.directory }] };
    localStorage.setItem("acgn-hub.local-download-tasks.v1", JSON.stringify([{ ...shared, id: "old-A" }, { ...shared, id: "old-B", outputPath: "c:/books/CHAPTER.cbz", cleanupPaths: [{ path: "c:/books/CHAPTER.cbz", allowedRoot: "c:/books" }] }]));
    const store = useLocalDownloadStore(); store.initialize();
    expect(store.tasks.every((task) => !task.cleanupPaths?.length)).toBe(true);
    expect(JSON.parse(localStorage.getItem("acgn-hub.local-download-tasks.v1")!).every((task: { cleanupPaths?: unknown[] }) => !task.cleanupPaths?.length)).toBe(true);
    for (const task of [...store.tasks]) await store.remove(task, true);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
