import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { LocalDownloadKind, LocalDownloadStage, LocalDownloadTask } from "@/domain/local-download";
import { isTauriRuntime, newId, nowIso } from "@/shared/runtime";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "acgn-hub.local-download-tasks.v1";

export const useLocalDownloadStore = defineStore("local-downloads", () => {
  const tasks = ref<LocalDownloadTask[]>([]);
  const error = ref("");
  const persistencePending = ref(false);
  const runningIds = ref(new Set<string>());
  const settlements = new Map<string, boolean>();
  const cleanupInFlight = new Map<string, Promise<void>>();
  const cleaningPaths = new Set<string>();
  let initialized = false;
  let storageWritable = false;

  function initialize(): void {
    if (initialized) return;
    initialized = true;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (!Array.isArray(saved) || !saved.every(isLocalDownloadTask) || new Set(saved.map((task) => task.id)).size !== saved.length) {
        throw new Error("记录包含无效字段、重复 ID 或不是列表");
      }
      storageWritable = true;
      error.value = "";
      tasks.value = saved.map((task) => ({
            ...task,
            ...(isActive(task.stage) ? { stage: "failed" as const, error: "上次任务未能确认完成，文件可能已经生成。请先检查记录中的输出路径，再决定是否重新下载。", updatedAt: nowIso() } : {}),
            // Older versions registered the final path before creating it.
            // Failed/interrupted records cannot prove that they own a file.
            cleanupPaths: task.stage === "completed" ? task.cleanupPaths :
              task.cleanupPaths?.filter((item) => item.path !== task.outputPath),
          }));
      const claims = new Map<string, number>();
      for (const task of tasks.value) for (const item of task.cleanupPaths ?? []) {
        const key = pathKey(item.path); claims.set(key, (claims.get(key) ?? 0) + 1);
      }
      let ownershipReconciled = false;
      tasks.value = tasks.value.map((task) => {
        const remaining = task.cleanupPaths?.filter((item) => claims.get(pathKey(item.path)) === 1);
        if (!task.cleanupPaths || remaining?.length === task.cleanupPaths.length) return task;
        ownershipReconciled = true;
        return { ...task, cleanupPaths: remaining, detail: "同一路径曾登记在多个任务中，无法确认旧文件归属；旧记录的文件删除权限已撤销，请手动核对输出路径。" };
      });
      for (const task of tasks.value) settlements.set(task.id, task.stage === "completed");
      if (ownershipReconciled || saved.some((task) => isActive(task.stage) || (task.stage !== "completed" && task.cleanupPaths?.some((item) => item.path === task.outputPath)))) {
        try { persist(); } catch (cause) { keepPending(cause); }
      }
    } catch (cause) {
      storageWritable = false;
      error.value = cause instanceof Error && cause.message.startsWith("本地生成任务") ? cause.message
        : "本地生成任务记录无法读取，原始文本已保留。请先备份并修复存储，再重新打开应用；本次已停止写入。";
    }
  }

  function create(input: {
    kind: LocalDownloadKind;
    title: string;
    sourceName: string;
    directory: string;
    outputPath: string;
    cleanupPaths?: Array<{ path: string; allowedRoot: string }>;
    totalUnits?: number;
    reading?: LocalDownloadTask["reading"];
  }): string {
    initialize();
    assertWritable();
    const outputKey = pathKey(input.outputPath);
    const requestedPaths = [input.outputPath, ...(input.cleanupPaths ?? []).map((item) => item.path)];
    if (requestedPaths.some((path) => [...cleaningPaths].some((cleaning) => pathsOverlap(pathKey(path), cleaning))) ||
      tasks.value.some((task) => runningIds.value.has(task.id) && pathKey(task.outputPath) === outputKey)) {
      throw new Error("相同输出路径还有任务正在生成或清理，请等待当前步骤结束后重试。");
    }
    const timestamp = nowIso();
    const task: LocalDownloadTask = {
      id: newId(),
      kind: input.kind,
      title: input.title,
      sourceName: input.sourceName,
      directory: input.directory,
      outputPath: input.outputPath,
      ...(input.reading ? { reading: { ...input.reading } } : {}),
      ...(input.cleanupPaths?.length ? { cleanupPaths: input.cleanupPaths.filter((item) => pathKey(item.path) !== outputKey) } : {}),
      stage: "preparing",
      completedUnits: 0,
      totalUnits: input.totalUnits ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    persist([task, ...tasks.value]);
    runningIds.value.add(task.id);
    return task.id;
  }

  function update(id: string, patch: Partial<Pick<LocalDownloadTask, "stage" | "completedUnits" | "totalUnits" | "detail" | "error">>): void {
    initialize();
    if (!persistencePending.value) assertWritable();
    const next = tasks.value.map((task) => {
      if (task.id !== id) return task;
      if (["completed", "failed", "cancelled"].includes(task.stage) && patch.stage !== undefined && patch.stage !== task.stage) return task;
      return { ...task, ...patch, updatedAt: nowIso() };
    });
    // Progress bookkeeping is independent of the native writer. A full Web
    // Storage must not turn a successful native transfer into a failed one.
    tasks.value = next;
    try { persist(next); } catch (cause) { keepPending(cause); }
  }

  async function complete(id: string, detail?: string): Promise<boolean> {
    initialize();
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return false;
    if (settlements.has(id)) return settlements.get(id)!;
    runningIds.value.delete(id);
    settlements.set(id, task.stage !== "cancelled");
    // Call only after the native writer confirms creation. A failed create
    // must never grant permission to delete an existing destination file.
    const finished: LocalDownloadTask = {
      ...task,
      cleanupPaths: [...(task.cleanupPaths ?? []).filter((item) => item.path !== task.outputPath),
        { path: task.outputPath, allowedRoot: task.directory }],
      ...(task.stage === "cancelled" ? {} : {
        stage: "completed", completedUnits: task.totalUnits || 1, totalUnits: task.totalUnits || 1,
        detail, error: undefined,
      }),
      updatedAt: nowIso(),
    };
    // The writer has already confirmed the file. Keep that fact authoritative
    // in memory even when saving the task history fails; never hand it to fail().
    const outputKey = pathKey(task.outputPath);
    // A newly confirmed writer becomes the sole owner of this output path.
    // Earlier history may keep the path for reference, never for later deletion.
    tasks.value = tasks.value.map((item) => {
      if (item.id === id) return finished;
      const previous = item.cleanupPaths ?? [];
      const remaining = previous.filter((path) => pathKey(path.path) !== outputKey);
      if (remaining.length === previous.length) return item;
      return { ...item, cleanupPaths: remaining.length ? remaining : undefined,
        ...(pathKey(item.outputPath) === outputKey ? { detail: "此输出路径已由新的下载任务使用，旧记录不再拥有该文件；请在新任务中打开或删除。" } : {}),
        updatedAt: nowIso() };
    });
    try { persist(); } catch (cause) { keepPending(cause); }
    if (task.stage === "cancelled") {
      await cleanup(id);
      update(id, { detail: "已取消，当前步骤生成的文件已清理" });
      return false;
    }
    return true;
  }

  async function fail(id: string, error: string): Promise<void> {
    runningIds.value.delete(id);
    // Page callbacks and late progress may finish out of order. A subsequent
    // bookkeeping/notification error must never delete an already published file.
    const existing = tasks.value.find((item) => item.id === id);
    if (existing?.stage === "completed" || settlements.get(id) === true) return;
    settlements.set(id, false);
    let writeError: unknown;
    try { update(id, { stage: "failed", error }); } catch (cause) { writeError = cause; }
    const task = tasks.value.find((item) => item.id === id);
    if (task) await cleanup(id);
    if (task?.stage === "cancelled" && !writeError) update(id, { detail: "已取消，临时文件已清理", error: undefined });
    if (writeError) throw writeError;
  }

  function isCancelled(id: string): boolean {
    initialize();
    return tasks.value.find((task) => task.id === id)?.stage === "cancelled";
  }

  async function cancel(id: string): Promise<void> {
    initialize();
    const task = tasks.value.find((item) => item.id === id);
    if (!task || !isActive(task.stage)) return;
    update(id, { stage: "cancelled", error: "已请求取消", detail: "等待下载停止并清理临时文件" });
    // The worker observes cancellation between native/network steps. Deleting
    // its temporary directory while it is writing would race with cleanup.
    if (!runningIds.value.has(id)) await cleanup(id);
  }

  async function remove(task: LocalDownloadTask, deleteFiles: boolean): Promise<void> {
    initialize();
    assertWritable();
    const current = tasks.value.find((item) => item.id === task.id);
    if (!current) return;
    if (isActive(current.stage)) throw new Error("活动任务请先取消后再删除");
    if (runningIds.value.has(current.id)) throw new Error("取消请求正在处理，请等待当前步骤结束后再删除记录");
    if (deleteFiles) await cleanup(current.id);
    persist(tasks.value.filter((item) => item.id !== current.id));
  }

  function cleanup(id: string): Promise<void> {
    const pending = cleanupInFlight.get(id);
    if (pending) return pending;
    const operation = (async () => {
      if (!isTauriRuntime()) return;
      for (;;) {
        // Always read the latest ownership, never a UI snapshot captured before
        // a newer same-path download or an earlier successful cleanup.
        const task = tasks.value.find((value) => value.id === id);
        const item = task?.cleanupPaths?.[0];
        if (!item) return;
        const key = pathKey(item.path);
        if (hasOtherWriter(id, key)) throw new Error("该路径还有新的下载任务正在生成，请等待后再处理旧记录。");
        if (hasOtherOwner(id, key)) throw new Error("该路径同时登记在其它任务中，未删除文件，请先核对实际成品。");
        if ([...cleaningPaths].some((cleaning) => pathsOverlap(key, cleaning))) throw new Error("该路径正在清理，请等待当前操作结束。");
        cleaningPaths.add(key);
        try {
          await invoke("delete_download_files", { paths: [item.path], allowedRoot: item.allowedRoot });
          // Consume each successful permission immediately. If a later path
          // fails, retry only the paths which are still owned and unconsumed.
          tasks.value = tasks.value.map((value) => value.id !== id ? value : {
            ...value, cleanupPaths: value.cleanupPaths?.filter((path) => pathKey(path.path) !== key), updatedAt: nowIso(),
          });
          try { persist(); } catch (cause) { keepPending(cause); }
        } finally { cleaningPaths.delete(key); }
      }
    })();
    cleanupInFlight.set(id, operation);
    void operation.finally(() => { if (cleanupInFlight.get(id) === operation) cleanupInFlight.delete(id); }).catch(() => undefined);
    return operation;
  }

  function hasOtherWriter(id: string, key: string): boolean {
    return tasks.value.some((task) => task.id !== id && runningIds.value.has(task.id) && pathsOverlap(pathKey(task.outputPath), key));
  }
  function hasOtherOwner(id: string, key: string): boolean {
    return tasks.value.some((task) => task.id !== id && task.cleanupPaths?.some((item) => pathsOverlap(pathKey(item.path), key)));
  }
  function ownedOutputPath(id: string): string | undefined {
    const task = tasks.value.find((value) => value.id === id);
    if (!task || task.stage !== "completed") return;
    const key = pathKey(task.outputPath);
    if (!task.cleanupPaths?.some((item) => pathKey(item.path) === key) || hasOtherWriter(id, key) || hasOtherOwner(id, key) || cleaningPaths.has(key)) return;
    return task.outputPath;
  }

  function assertWritable(): void {
    if (!storageWritable) throw new Error(error.value || "本地生成任务存储尚未准备好，已停止写入。");
  }

  function persist(next = tasks.value): void {
    assertWritable();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      tasks.value = next;
    } catch (cause) {
      storageWritable = false;
      error.value = "本地生成任务记录无法保存，原始存储已保留。请检查空间与权限，再重新打开应用；后续写入已停止。";
      throw new Error(error.value, { cause });
    }
  }

  function keepPending(cause: unknown): void {
    storageWritable = false;
    persistencePending.value = true;
    error.value = "任务记录尚未保存，当前进度与结果已保留在本次窗口，已生成的文件不会删除。请先重试保存或导出记录，再关闭应用；也可按输出路径查找成品。";
    void cause;
  }

  function retryPersistence(): void {
    initialize();
    if (!persistencePending.value) { assertWritable(); return; }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.value));
      storageWritable = true;
      persistencePending.value = false;
      error.value = "";
    } catch (cause) {
      keepPending(cause);
      throw new Error(error.value, { cause });
    }
  }

  function exportRawRecords(): string {
    return JSON.stringify({ storageKey: STORAGE_KEY, exportedAt: nowIso(), rawText: localStorage.getItem(STORAGE_KEY),
      ...(persistencePending.value ? { pendingTasks: tasks.value } : {}),
    }, null, 2);
  }

  function backupAndRebuild(): string {
    if (runningIds.value.size) throw new Error("还有本地生成任务正在结束，请等待后再重建记录。");
    if (cleanupInFlight.size) throw new Error("还有文件清理操作正在结束，请等待后再重建记录。");
    if (persistencePending.value) throw new Error("存在尚未保存的任务结果，请先重试保存或导出当前记录，不会清空本次窗口中的结果。");
    const backupKey = `${STORAGE_KEY}.backup.${Date.now()}.${newId()}`;
    try {
      const raw = exportRawRecords();
      // Preserve the exact old text first. A quota/access failure here must
      // leave the original key untouched; Web Storage writes are atomic.
      localStorage.setItem(backupKey, raw);
      if (localStorage.getItem(backupKey) !== raw) throw new Error("无法验证备份");
      localStorage.setItem(STORAGE_KEY, "[]");
      tasks.value = [];
      storageWritable = true;
      initialized = true;
      error.value = "";
      persistencePending.value = false;
      return backupKey;
    } catch (cause) {
      throw new Error("备份或重建记录失败，尚未清空原始记录。请先导出并检查存储空间与权限。", { cause });
    }
  }

  return { tasks: computed(() => [...tasks.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt))), error, persistencePending, retryPersistence, initialize, create, update, complete, fail, isCancelled, ownedOutputPath, isRunning: (id: string) => runningIds.value.has(id), cancel, remove, exportRawRecords, backupAndRebuild };
});

/** App-generated paths may differ in Windows case/slashes/verbatim spelling. */
function pathKey(path: string): string {
  const normalized = path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}
function pathsOverlap(left: string, right: string): boolean { return left === right || left.startsWith(right + "/") || right.startsWith(left + "/"); }

function isActive(stage: LocalDownloadStage): boolean {
  return stage === "preparing" || stage === "downloading" || stage === "packaging";
}

function isLocalDownloadTask(value: unknown): value is LocalDownloadTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Partial<LocalDownloadTask>;
  return [task.id, task.title, task.sourceName, task.directory, task.outputPath, task.createdAt, task.updatedAt]
    .every((item) => typeof item === "string" && item.length > 0) &&
    (task.kind === "manga" || task.kind === "novel" || task.kind === "video") &&
    ["preparing", "downloading", "packaging", "completed", "failed", "cancelled"].includes(task.stage ?? "") &&
    [task.completedUnits, task.totalUnits].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0) &&
    [task.detail, task.error].every((item) => item === undefined || typeof item === "string") &&
    (task.reading === undefined || (task.reading && typeof task.reading === "object" && !Array.isArray(task.reading)
      && typeof task.reading.seriesTitle === "string" && task.reading.seriesTitle.trim().length > 0
      && [task.reading.mediaId, task.reading.editionId, task.reading.unitTitle].every((item) => item === undefined || typeof item === "string")
      && (task.reading.unitNumber === undefined || (typeof task.reading.unitNumber === "number" && Number.isFinite(task.reading.unitNumber) && task.reading.unitNumber >= 0)))) &&
    (task.cleanupPaths === undefined || (Array.isArray(task.cleanupPaths) && task.cleanupPaths.every((item) => item && typeof item.path === "string" && typeof item.allowedRoot === "string" && item.path.length > 0 && item.allowedRoot.length > 0)));
}
