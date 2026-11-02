import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadTask } from "@/domain/download";
import { DownloadManager, errorMessage } from "@/application/download-manager";
import { createTaskRepository } from "@/infrastructure/database/create-task-repository";
import { createDownloadEngine } from "@/infrastructure/download/create-download-engine";
import { loadSettings } from "@/shared/settings";
import { isAndroidRuntime, isTauriRuntime } from "@/shared/runtime";
import { emitDownloadCompleted } from "@/application/download-events";
import { automaticNameEligible, previewCompletedName, type CompletedNamePreview } from "@/application/completed-download-naming";
import { createMediaLibraryRepository } from "@/infrastructure/library/create-media-library-repository";
import { createResourceRepository } from "@/infrastructure/database/create-resource-repository";

export const useDownloadStore = defineStore("downloads", () => {
  const tasks = ref<DownloadTask[]>([]);
  const loading = ref(false);
  const error = ref("");
  const namingBusy = ref(new Set<string>());
  const automaticNaming = ref(new Set<string>());
  const namingRecoveryMessage = ref("");
  let manager: DownloadManager | undefined;
  let initializing: Promise<void> | undefined;

  async function initialize(): Promise<void> {
    if (manager) return;
    if (initializing) return initializing;
    loading.value = true;
    error.value = "";
    initializing = (async () => {
      const repository = await createTaskRepository();
      if (isTauriRuntime() && !isAndroidRuntime()) {
        const recovery = await invoke<{ recovered: number; pending: number; messages: string[] }>("recover_completed_download_renames");
        namingRecoveryMessage.value = recovery.pending ? recovery.messages.join("；") || "有成品命名操作尚待恢复，请先检查文件位置。" : "";
      }
      const candidate = new DownloadManager({
        repository,
        engine: (id, endpoint) => {
          const settings = loadSettings();
          if (endpoint) {
            if (id === "aria2") settings.aria2Endpoint = endpoint;
            else settings.qbittorrentEndpoint = endpoint;
          }
          return createDownloadEngine(id, settings);
        },
        settings: loadSettings,
        onChange: (next) => { tasks.value = next; },
        onComplete: (task) => { void automaticallyName(task).finally(() => emitDownloadCompleted(tasks.value.find((item) => item.id === task.id) ?? task)); },
      });
      await candidate.initialize();
      manager = candidate;
      // Also handle completed rows from an older version, once. Active BT files
      // keep their original names until the engine confirms completion.
      if (isTauriRuntime() && !isAndroidRuntime() && !namingRecoveryMessage.value) for (const task of [...tasks.value]) void automaticallyName(task);
    })().catch((cause) => { error.value = errorMessage(cause); throw cause; })
      .finally(() => { loading.value = false; initializing = undefined; });
    return initializing;
  }
  async function useManager<T>(action: (value: DownloadManager) => Promise<T>): Promise<T> {
    await initialize();
    if (!manager) throw new Error("下载服务未就绪，请在设置中检查本地存储。");
    try {
      const result = await action(manager);
      error.value = "";
      return result;
    } catch (cause) { error.value = errorMessage(cause); throw cause; }
  }
  const add = (url: string, directory: string, association: { mediaId?: string; resourceId?: string; sourceName?: string; filename?: string } = {}) =>
    useManager((value) => value.add(url, directory, association));
  const refreshAll = () => useManager((value) => value.refreshAll());
  const pause = (task: DownloadTask) => useManager((value) => value.pause(task.id));
  const resume = (task: DownloadTask) => useManager((value) => value.resume(task.id));
  const cancel = (task: DownloadTask) => useManager((value) => value.cancel(task.id));
  const retry = (task: DownloadTask) => useManager((value) => value.retry(task.id));
  const markOrganized = (taskId: string, path: string) => useManager((value) => value.markOrganized(taskId, path));

  const namingSources = {
    async findMedia(id: string) { return (await (await createMediaLibraryRepository()).list()).find((item) => item.id === id); },
    async findResource(id: string) { return (await createResourceRepository()).findById(id); },
  };
  async function previewName(task: DownloadTask, filePath?: string): Promise<CompletedNamePreview> {
    await initialize();
    return previewCompletedName(tasks.value.find((item) => item.id === task.id) ?? task, namingSources, filePath);
  }
  async function renameCompleted(task: DownloadTask, newFileName: string, filePath?: string): Promise<void> {
    if (!isTauriRuntime()) throw new Error("修改成品文件名需要使用桌面版。");
    if (namingRecoveryMessage.value) throw new Error(namingRecoveryMessage.value);
    if (namingBusy.value.has(task.id)) throw new Error("正在保存该任务的文件名，请稍候。");
    namingBusy.value.add(task.id);
    try {
      await useManager((value) => value.mutateCompletedTask(task.id, async (current) => {
        const sourcePath = filePath ?? (current.files.length === 1 ? current.files[0] : undefined);
        if (!sourcePath) throw new Error("请先选择需要命名的成品文件。");
        await invoke("rename_completed_download", { taskId: current.id, sourcePath, newFileName });
      }));
    } catch (cause) {
      // A retained native journal owns the recovery snapshot. Do not rewrite
      // naming_json/updatedAt and invalidate that snapshot after a rollback fault.
      try {
        const recovery = await invoke<{ recovered: number; pending: number; messages: string[] }>("recover_completed_download_renames");
        if (recovery.pending) namingRecoveryMessage.value = recovery.messages.join("；") || "改名尚待安全恢复，请先检查原文件和新文件位置。";
      } catch { namingRecoveryMessage.value = "改名结果尚待核对，请保留现有文件并重新打开程序恢复。"; }
      const current = tasks.value.find((item) => item.id === task.id);
      if (current && manager && !namingRecoveryMessage.value) {
        await manager.recordNamingResult(task.id, { ...current.naming, status: "failed", message: errorMessage(cause) });
      }
      throw cause;
    } finally { namingBusy.value.delete(task.id); }
  }
  async function automaticallyName(task: DownloadTask): Promise<void> {
    if (!isTauriRuntime() || automaticNaming.value.has(task.id) || namingBusy.value.has(task.id) || namingRecoveryMessage.value) return;
    try {
      if (!automaticNameEligible(task, loadSettings().autoRenameDownloads)) return;
      automaticNaming.value.add(task.id);
      const preview = await previewCompletedName(task, namingSources);
      if (!preview.newFileName) {
        await manager?.recordNamingResult(task.id, { status: "skipped", message: preview.reason || "未能确定成品名称，已保留原名。" });
        return;
      }
      await renameCompleted(task, preview.newFileName, preview.filePath);
    } catch (cause) {
      // Completion stays successful. Naming faults have their own retryable record.
      const current = tasks.value.find((item) => item.id === task.id);
      if (current && manager && !namingRecoveryMessage.value && current.naming?.status !== "failed") {
        try { await manager.recordNamingResult(task.id, { ...current.naming, status: "failed", message: errorMessage(cause) }); }
        catch { namingRecoveryMessage.value = "成品已下载，但命名记录无法保存，请检查资料库与文件位置。"; }
      }
    } finally { automaticNaming.value.delete(task.id); }
  }
  const remove = (task: DownloadTask, deleteFiles: boolean) => useManager((value) => value.remove(task.id, async (current) => {
    if (!deleteFiles || !current.files.length) return;
    if (!isTauriRuntime()) throw new Error("删除下载文件需要使用桌面版。");
    if (current.finalPath) throw new Error("此任务已经整理入库。请在本地文件管理中确认文件，避免误删作品。");
    await invoke("delete_download_files", { paths: current.files, allowedRoot: current.directory });
  }));

  return {
    tasks: computed(() => [...tasks.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    loading, error, initialize, add, refreshAll, pause, resume, cancel, retry, markOrganized, remove,
    namingBusy: computed(() => new Set([...namingBusy.value, ...automaticNaming.value])), namingRecoveryMessage, previewName, renameCompleted,
  };
});
