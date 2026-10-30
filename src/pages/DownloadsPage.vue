<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useDownloadStore } from "@/stores/download";
import { loadSettings } from "@/shared/settings";
import type { DownloadTask } from "@/domain/download";
import { getCompletedDownloadOutputs, type DownloadOutput } from "@/domain/download-output";
import type { LocalDownloadTask } from "@/domain/local-download";
import { isTauriRuntime } from "@/shared/runtime";
import { useLocalDownloadStore } from "@/stores/local-download";
import { useRouter } from "vue-router";
import { parsePublicVideoInput } from "@/infrastructure/sources/public-video-source-provider";

const store = useDownloadStore();
const localStore = useLocalDownloadStore();
const router = useRouter();
const url = ref("");
const initialSettings = loadSettings();
const directory = ref(initialSettings.downloadDirectory || initialSettings.incomingDirectory);
const formError = ref("");
const adding = ref(false);
const refreshing = ref(false);
const pendingTaskActions = ref(new Set<string>());
interface NameEditor { filePath: string; newFileName: string; reason: string; loading: boolean; error: string }
const nameEditors = ref<Record<string, NameEditor>>({});
const outputSelections = ref<Record<string, string>>({});
function configuredOutputRoots(): string[] {
  const settings = loadSettings();
  return [settings.libraryDirectory, settings.incomingDirectory, settings.downloadDirectory].filter(Boolean);
}
const outputChoices = computed(() => Object.fromEntries(store.tasks.map((task) => [task.id, getCompletedDownloadOutputs(task, configuredOutputRoots())])));
const recoveryMessage = ref("");
const taskFilter = ref("all");
const taskQuery = ref("");
const taskCount = computed(() => store.tasks.length + localStore.tasks.length);
const activeCount = computed(() => store.tasks.filter((task) => ["queued", "downloading", "paused"].includes(task.state)).length
  + localStore.tasks.filter((task) => ["preparing", "downloading", "packaging"].includes(task.stage)).length);
const completedCount = computed(() => store.tasks.filter((task) => task.state === "completed").length
  + localStore.tasks.filter((task) => task.stage === "completed").length);
const failedCount = computed(() => store.tasks.filter((task) => task.state === "failed").length
  + localStore.tasks.filter((task) => task.stage === "failed").length);
const visibleTasks = computed(() => store.tasks.filter((task) => {
  if (taskFilter.value === "active" && !["queued", "downloading", "paused"].includes(task.state)) return false;
  if (taskFilter.value === "completed" && task.state !== "completed") return false;
  if (taskFilter.value === "failed" && task.state !== "failed") return false;
  const query = taskQuery.value.trim().toLocaleLowerCase();
  return !query || [task.filename, task.sourceName, task.sourceUrl, task.naming?.originalFileName, task.naming?.currentFileName, ...task.files]
    .some((value) => value?.toLocaleLowerCase().includes(query));
}));
const visibleLocalTasks = computed(() => localStore.tasks.filter((task) => {
  if (taskFilter.value === "active" && !["preparing", "downloading", "packaging"].includes(task.stage)) return false;
  if (taskFilter.value === "completed" && task.stage !== "completed") return false;
  if (taskFilter.value === "failed" && task.stage !== "failed") return false;
  const query = taskQuery.value.trim().toLocaleLowerCase();
  return !query || [task.title, task.sourceName, task.outputPath].some((value) => value.toLocaleLowerCase().includes(query));
}));

onMounted(async () => {
  localStore.initialize();
  try { await store.initialize(); }
  catch (cause) { formError.value = cause instanceof Error ? cause.message : "下载记录读取失败"; }
});

async function submit(): Promise<void> {
  if (adding.value) return;
  formError.value = "";
  adding.value = true;
  try {
    const publicVideo = parsePublicVideoInput(url.value);
    if (publicVideo) {
      await router.push({ path: "/resources", query: { type: "anime", q: publicVideo.url, provider: "public_video" } });
      return;
    }
    await store.add(url.value, directory.value);
    url.value = "";
  } catch (cause) {
    formError.value = actionError(cause, "创建任务失败");
  } finally {
    adding.value = false;
  }
}

function progress(task: DownloadTask): number {
  if (task.state === "completed") return 100;
  if (!task.totalBytes) return 0;
  const completed = task.stage === "checking" && task.verifiedBytes !== undefined ? task.verifiedBytes : task.completedBytes;
  return Math.min(99, Math.round((completed / task.totalBytes) * 100));
}

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatSpeed(value: number): string {
  return `${formatBytes(value)}/s`;
}

function remaining(task: DownloadTask): string {
  const bytesLeft = task.totalBytes - task.completedBytes;
  if (bytesLeft <= 0 || task.speedBytesPerSecond <= 0) return "—";
  const seconds = Math.ceil(bytesLeft / task.speedBytesPerSecond);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

function stateLabel(task: DownloadTask): string {
  if (["queued", "downloading", "paused"].includes(task.state)) {
    if (task.errorCode === "ENGINE_UNREACHABLE") return "引擎连接失败";
    if (task.errorCode === "ENGINE_STATUS_UNAVAILABLE") return "状态待刷新";
  }
  if (task.state === "downloading" || task.state === "queued") {
    if (task.error?.includes("正在恢复")) return "正在恢复任务";
    if (task.error) return "引擎状态异常";
    switch (task.stage) {
      case "queued_engine": return "等待引擎空位";
      case "fetching_torrent": return "获取种子文件";
      case "fetching_metadata": return "获取磁力元数据";
      case "connecting": return task.protocol === "http" ? "连接文件服务器" : peerCount(task) === 0 ? "正在寻找节点" : "正在连接节点";
      case "checking": return "校验下载内容";
      case "downloading": return task.speedBytesPerSecond > 0 ? "正在传输" : "等待数据传输";
    }
  }
  return {
    queued: "排队中",
    downloading: "下载中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[task.state];
}

function statusUnavailable(task: DownloadTask): boolean {
  return ["ENGINE_UNREACHABLE", "ENGINE_STATUS_UNAVAILABLE"].includes(task.errorCode ?? "");
}

function peerCount(task: DownloadTask): number | undefined {
  return task.peers ?? task.connections;
}

function phaseDetail(task: DownloadTask): string {
  if (statusUnavailable(task)) return "当前无法确认引擎状态，保留上次收到的进度；可以刷新状态或到设置中检查连接。";
  if (["paused", "completed", "failed", "cancelled"].includes(task.state)) return "";
  if (task.stage === "fetching_torrent") return "正在取得种子描述文件，之后才会下载其中的视频或其它内容。";
  if (task.stage === "fetching_metadata") return "正在向节点获取文件信息，暂时无法计算正片进度。";
  if (task.stage === "queued_engine") return "任务已交给引擎，正在等待可用下载名额。";
  if (task.stage === "checking" || task.verifyIntegrityPending) return "正在检查已有分片，校验结束前不会标记完成。";
  if (task.protocol !== "http" && ["connecting", "downloading"].includes(task.stage ?? "") && task.speedBytesPerSecond === 0) {
    return peerCount(task) === 0
      ? "尚未建立节点连接；网络可达性、节点发现和资源在线情况都会影响等待时间。"
      : peerCount(task) !== undefined ? "已连接节点，暂时没有收到可用数据。" : "正在等待可用数据，尚未取得节点连接信息。";
  }
  return "";
}

function protocolLabel(task: DownloadTask): string {
  return { http: "文件直链", magnet: "磁力链接", torrent: "种子文件" }[task.protocol] ?? task.protocol;
}

function localStageLabel(stage: "preparing" | "downloading" | "packaging" | "completed" | "failed" | "cancelled"): string {
  return { preparing: "准备中", downloading: "下载中", packaging: "打包中", completed: "已完成", failed: "失败", cancelled: "已取消" }[stage];
}

function localProgress(task: LocalDownloadTask): number {
  if (task.stage === "completed") return 100;
  if (task.stage === "cancelled") return 0;
  if (task.kind === "video" && task.totalUnits) return Math.min(99, Math.round(task.completedUnits / task.totalUnits * 100));
  if (!task.totalUnits) return task.stage === "preparing" ? 8 : task.stage === "packaging" ? 92 : 18;
  return Math.min(99, Math.max(8, Math.round((task.completedUnits / task.totalUnits) * 90)));
}

function actionError(cause: unknown, fallback = "操作失败"): string {
  return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback;
}

async function taskAction(id: string, action: () => Promise<void>): Promise<void> {
  if (pendingTaskActions.value.has(id)) return;
  pendingTaskActions.value = new Set([...pendingTaskActions.value, id]);
  formError.value = "";
  try { await action(); }
  catch (cause) { formError.value = actionError(cause); }
  finally {
    const next = new Set(pendingTaskActions.value);
    next.delete(id); pendingTaskActions.value = next;
  }
}

function taskBusy(task: DownloadTask): boolean {
  return pendingTaskActions.value.has(task.id) || store.namingBusy.has(task.id);
}

function selectedOutput(task: DownloadTask): DownloadOutput | undefined {
  const choices = outputChoices.value[task.id] ?? [];
  return choices.length === 1 ? choices[0] : choices.find((output) => output.path === outputSelections.value[task.id]);
}

async function openTaskOutput(task: DownloadTask): Promise<void> {
  const current = store.tasks.find((item) => item.id === task.id);
  if (!current || taskBusy(current) || !isTauriRuntime()) return;
  // Re-read current authoritative paths: an earlier selection may precede rename.
  const choices = getCompletedDownloadOutputs(current, configuredOutputRoots());
  const output = choices.length === 1 ? choices[0] : choices.find((item) => item.path === outputSelections.value[current.id]);
  if (!output) { formError.value = "先选择需要打开的已完成文件。"; return; }
  await taskAction(current.id, async () => {
    await invoke("open_downloaded_media", { path: output.path, allowedRoot: output.allowedRoot, preferSystem: true });
  });
}

function fileName(path: string): string { return path.split(/[\\/]/).pop() ?? path; }
function fileExtension(path: string): string { return fileName(path).match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? ""; }

function nameError(editor: NameEditor): string {
  if (!editor.filePath) return "先选择需要命名的成品文件。";
  const name = editor.newFileName.trim();
  if (!name) return "请输入文件名。";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return "文件名包含 Windows 不支持的字符或名称。";
  const extension = fileExtension(editor.filePath);
  if (!extension || !name.endsWith(extension)) return `保留原扩展名 ${extension || '（未能识别）'}，只修改前面的名称。`;
  return "";
}

async function openNameEditor(task: DownloadTask): Promise<void> {
  if (taskBusy(task)) return;
  nameEditors.value[task.id] = { filePath: task.files.length === 1 ? task.files[0] : "", newFileName: "", reason: "", loading: false, error: "" };
  if (task.files.length === 1) await previewName(task);
}

async function previewName(task: DownloadTask): Promise<void> {
  const editor = nameEditors.value[task.id];
  if (!editor || editor.loading || taskBusy(task)) return;
  editor.newFileName = editor.filePath ? fileName(editor.filePath) : "";
  editor.reason = ""; editor.error = "";
  if (!editor.filePath) return;
  const requestedPath = editor.filePath;
  editor.loading = true;
  try {
    const preview = await store.previewName(task, requestedPath);
    if (nameEditors.value[task.id] !== editor || editor.filePath !== requestedPath) return;
    editor.newFileName = preview.newFileName ?? fileName(requestedPath);
    editor.reason = preview.reason ?? "";
  } catch (cause) { editor.error = actionError(cause, "无法生成名称预览"); }
  finally { editor.loading = false; }
}

async function confirmName(task: DownloadTask): Promise<void> {
  const editor = nameEditors.value[task.id];
  if (!editor || editor.loading || taskBusy(task)) return;
  editor.error = nameError(editor);
  if (editor.error) return;
  await taskAction(task.id, async () => {
    await store.renameCompleted(task, editor.newFileName.trim(), editor.filePath);
    delete nameEditors.value[task.id];
  });
}

async function refreshTasks(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try { await store.refreshAll(); }
  catch (cause) { formError.value = actionError(cause); }
  finally { refreshing.value = false; }
}

function openPath(path: string, label: string): void {
  if (!isTauriRuntime()) {
    formError.value = "打开目录功能只在桌面端可用";
    return;
  }
  void invoke("open_directory", { path }).catch((cause) => {
    formError.value = actionError(cause, `${label}打开失败`);
  });
}

function openDirectory(task: DownloadTask): void {
  openPath(task.directory, "下载目录");
}

function removeTask(task: DownloadTask, deleteFiles: boolean): void {
  if (taskBusy(task)) return;
  const action = deleteFiles ? "删除任务及其下载文件" : "删除任务记录";
  if (!window.confirm(`确认${action}吗？${deleteFiles ? "允许目录内的文件或目录将被删除，且不可恢复。" : "不会删除本地文件。"}`)) return;
  void taskAction(task.id, () => store.remove(task, deleteFiles));
}

function removeLocalTask(task: LocalDownloadTask, deleteFiles: boolean): void {
  if (pendingTaskActions.value.has(task.id)) return;
  const action = deleteFiles ? "删除本地任务及生成文件" : "删除本地任务记录";
  if (!window.confirm(`确认${action}吗？${deleteFiles ? "只会清理该任务登记的输出和临时目录，不会影响其它文件。" : "不会删除生成文件。"}`)) return;
  void taskAction(task.id, () => localStore.remove(task, deleteFiles));
}

function openCompletedFile(task: LocalDownloadTask): void {
  if (pendingTaskActions.value.has(task.id)) return;
  const current = localStore.tasks.find((item) => item.id === task.id);
  const ownedPath = localStore.ownedOutputPath(task.id);
  if (!current || !ownedPath) {
    formError.value = "此记录已不再拥有该成品，或路径正由其它任务使用。请核对输出目录，并从当前任务打开文件。";
    return;
  }
  if (current.stage !== "completed" || !/\.(?:cbz|txt|mp4)$/i.test(ownedPath) || !isTauriRuntime()) return;
  void taskAction(current.id, async () => {
    await invoke("open_downloaded_media", { path: ownedPath, allowedRoot: current.directory });
  });
}

function exportLocalRecords(): void {
  formError.value = "";
  try {
    const url = URL.createObjectURL(new Blob([localStore.exportRawRecords()], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `acgn-local-download-records-${Date.now()}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (cause) { formError.value = cause instanceof Error ? cause.message : "原始记录导出失败"; }
}

async function retryLocalPersistence(): Promise<void> {
  await taskAction("local-persistence", async () => {
    localStore.retryPersistence();
    recoveryMessage.value = "任务记录已保存，本次窗口中的下载结果已保留。";
  });
}

function rebuildLocalRecords(): void {
  if (localStore.persistencePending) { formError.value = "存在尚未保存的任务结果，请先重试保存或导出当前记录。"; return; }
  if (!window.confirm("确认先备份旧版原始记录，再重建视频与书籍任务列表吗？只会重建 MP4 / TXT / CBZ 的任务记录，不会删除任何生成文件或下载文件。备份失败时不会清空原记录。")) return;
  formError.value = "";
  try {
    localStore.backupAndRebuild();
    recoveryMessage.value = "原始记录已另存为本机备份，任务列表已重建。生成文件未删除，可以重新创建任务。";
  } catch (cause) { formError.value = cause instanceof Error ? cause.message : "本地记录重建失败"; }
}
</script>

<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">所有下载，都在这里</p>
      <h2>下载中心</h2>
      <p class="muted">查看视频 MP4、漫画 CBZ、小说 TXT，以及直链、磁力和种子的下载进度。</p>
    </div>
    <RouterLink class="ghost-button" to="/settings">引擎与保存位置</RouterLink>
  </section>

  <section v-if="localStore.error" class="card" role="alert"><p class="error-message">{{ localStore.error }}</p><div class="form-footer"><button class="ghost-button" type="button" @click="exportLocalRecords">导出原始记录</button><button v-if="localStore.persistencePending" class="ghost-button" :disabled="pendingTaskActions.has('local-persistence')" type="button" @click="retryLocalPersistence">{{ pendingTaskActions.has('local-persistence') ? '保存中…' : '重试保存记录' }}</button><button class="ghost-button" :disabled="localStore.persistencePending || pendingTaskActions.has('local-persistence')" type="button" @click="rebuildLocalRecords">备份并重建记录</button></div><p class="hint">{{ localStore.persistencePending ? '先保存或导出本次窗口中的记录，再关闭应用。已生成的文件不会删除。' : '只处理任务记录；已有 MP4、TXT、CBZ 和下载文件不会被删除。' }}</p></section>
  <p v-if="recoveryMessage" class="success-message" role="status">{{ recoveryMessage }}</p>
  <p v-if="store.namingRecoveryMessage" class="error-message" role="alert">{{ store.namingRecoveryMessage }}</p>

  <div class="summary-grid download-summary"><button type="button" class="summary-card" @click="taskFilter = 'all'"><span>全部下载</span><strong>{{ taskCount }}</strong><small>本机任务记录</small></button><button type="button" class="summary-card" @click="taskFilter = 'active'"><span>正在进行</span><strong>{{ activeCount }}</strong><small>准备、下载、合并与暂停</small></button><button type="button" class="summary-card" @click="taskFilter = 'completed'"><span>已完成</span><strong>{{ completedCount }}</strong><small>可打开成品文件</small></button><button type="button" class="summary-card" @click="taskFilter = 'failed'"><span>需要处理</span><strong>{{ failedCount }}</strong><small>查看错误后重试</small></button></div>

  <section class="card add-card">
    <div class="card-heading">
      <div>
        <h3>添加下载任务</h3>
        <p class="muted">粘贴 HTTP/HTTPS 文件链接、Magnet 或 .torrent 链接，应用自动选择下载引擎。</p>
      </div>
    </div>
    <form class="download-form" @submit.prevent="submit">
      <label>
        <span>链接</span>
        <input v-model="url" type="text" inputmode="url" placeholder="https://example.com/file.zip" required />
      </label>
      <label>
        <span>下载目录</span>
        <input v-model="directory" type="text" placeholder="例如 D:\\ACGN\\Incoming" required />
      </label>
      <button class="primary-button" :disabled="adding" type="submit">{{ adding ? "创建中…" : "开始下载" }}</button>
    </form>
    <p v-if="formError || store.error" class="error-message">{{ formError || store.error }}</p>
    <p class="hint">默认使用内置 aria2；qBittorrent 可在设置中选用。更换目录不会移动已有任务文件。</p>
  </section>

  <section class="card">
    <div class="card-heading">
      <div>
        <h3>任务列表</h3>
        <p class="muted">{{ taskCount }} 个任务</p>
      </div>
      <button class="ghost-button" :disabled="refreshing" type="button" @click="refreshTasks">{{ refreshing ? '刷新中…' : '刷新' }}</button>
    </div>

    <div class="list-toolbar"><div class="filter-tabs" aria-label="筛选任务"><button v-for="filter in [{ id: 'all', label: '全部' }, { id: 'active', label: '进行中' }, { id: 'completed', label: '已完成' }, { id: 'failed', label: '失败' }]" :key="filter.id" :class="{ active: taskFilter === filter.id }" type="button" @click="taskFilter = filter.id">{{ filter.label }}</button></div><input v-model="taskQuery" type="search" aria-label="搜索任务" placeholder="搜索名称、来源或链接" /></div>

    <div v-if="!taskCount" class="empty-state">
      <strong>还没有下载任务</strong>
      <span>从上方粘贴一个你有权访问的链接开始。</span>
    </div>

    <div v-else-if="!visibleTasks.length && !visibleLocalTasks.length" class="empty-state"><strong>没有符合条件的任务</strong><span>试试其它状态或更短的关键词。</span></div>
    <div v-if="visibleTasks.length" class="task-list">
      <article v-for="task in visibleTasks" :key="task.id" class="task-row" :data-stage="task.stage">
        <div class="task-main">
          <div class="task-title-line">
            <strong :title="task.sourceUrl">{{ task.filename || task.sourceUrl }}</strong>
            <span class="state-pill" :class="{ 'status-warning': statusUnavailable(task) }" :data-state="task.state">{{ stateLabel(task) }}</span>
          </div>
          <div class="progress-track"><span :style="{ width: `${progress(task)}%` }"></span></div>
          <div class="task-meta">
            <span v-if="task.stage === 'checking' && task.verifiedBytes !== undefined">已校验 {{ formatBytes(task.verifiedBytes) }} / {{ task.totalBytes ? formatBytes(task.totalBytes) : '大小待确认' }}</span>
            <span v-else>{{ formatBytes(task.completedBytes) }} / {{ task.totalBytes ? formatBytes(task.totalBytes) : '大小待确认' }}</span>
            <span>{{ statusUnavailable(task) ? '速度待刷新' : formatSpeed(task.speedBytesPerSecond) }}</span>
            <span>剩余：{{ remaining(task) }}</span>
            <span>{{ protocolLabel(task) }}</span>
            <span>引擎：{{ task.engineId }}</span>
            <span v-if="task.protocol !== 'http' && peerCount(task) !== undefined">连接节点：{{ peerCount(task) }}{{ statusUnavailable(task) ? '（上次）' : '' }}</span>
            <span v-if="task.protocol !== 'http' && task.seeders !== undefined">做种节点：{{ task.seeders }}{{ statusUnavailable(task) ? '（上次）' : '' }}</span>
            <span v-if="task.protocol === 'http' && task.connections !== undefined">连接：{{ task.connections }}</span>
            <span v-if="task.sourceName">来源：{{ task.sourceName }}</span>
            <span v-if="task.errorCode && !['0', 'USER_CANCELLED'].includes(task.errorCode)" class="error-text">错误码：{{ task.errorCode }}</span>
            <span v-if="task.error" class="error-text">{{ task.error }}</span>
          </div>
          <p v-if="phaseDetail(task)" class="hint task-phase-detail">{{ phaseDetail(task) }}</p>
          <p v-if="pendingTaskActions.has(task.id)" class="hint" role="status">正在处理任务操作…</p>
          <p v-if="store.namingBusy.has(task.id)" class="hint" role="status">正在保存成品名称，下载文件不会重新下载…</p>
          <p v-if="task.naming?.message" class="hint" :class="{ 'error-text': task.naming.status === 'failed' }">{{ task.naming.status === 'failed' ? '成品命名未完成：' : '' }}{{ task.naming.message }}</p>
          <p v-if="task.state === 'completed' && task.engineId === 'qbittorrent' && task.files.length" class="hint">请在 qBittorrent 中修改名称，以保留做种与文件对应关系。</p>
          <details v-if="task.naming?.originalFileName" class="task-download-details naming-history"><summary>查看原名记录</summary><p>原名：{{ task.naming.originalFileName }}</p><p v-if="task.naming.originalPath">原位置：{{ task.naming.originalPath }}</p><p v-if="task.naming.currentFileName">命名记录：{{ task.naming.currentFileName }}</p></details>
          <form v-if="nameEditors[task.id]" class="completed-name-editor" aria-label="成品名称预览" @submit.prevent="confirmName(task)">
            <label v-if="task.files.length > 1"><span>选择成品文件</span><select v-model="nameEditors[task.id].filePath" :disabled="nameEditors[task.id].loading || taskBusy(task)" @change="previewName(task)"><option value="">先选择一个文件</option><option v-for="path in task.files" :key="path" :value="path">{{ path }}</option></select></label>
            <template v-if="nameEditors[task.id].filePath">
              <p class="hint">当前文件：{{ fileName(nameEditors[task.id].filePath) }}</p>
              <label><span>成品文件名</span><input v-model="nameEditors[task.id].newFileName" :disabled="nameEditors[task.id].loading || taskBusy(task)" type="text" maxlength="180" autocomplete="off" /></label>
              <p class="hint">保留原扩展名 {{ fileExtension(nameEditors[task.id].filePath) }}；仅在当前目录改名，重名不会覆盖。</p>
              <p v-if="nameEditors[task.id].reason" class="hint">{{ nameEditors[task.id].reason }}。可核对作品和集数后手动填写名称。</p>
              <p v-if="nameEditors[task.id].loading" class="hint" role="status">正在生成建议名称…</p>
              <p v-if="nameEditors[task.id].error || nameError(nameEditors[task.id])" class="error-message" role="alert">{{ nameEditors[task.id].error || nameError(nameEditors[task.id]) }}</p>
              <p v-if="!isTauriRuntime()" class="hint">浏览器可预览名称，实际改名请使用桌面版。</p>
            </template>
            <p v-else class="hint">多文件任务逐项确认，不会把所有文件命名成同一集。</p>
            <div class="task-actions"><button class="small-button" :disabled="!isTauriRuntime() || nameEditors[task.id].loading || taskBusy(task) || !!nameError(nameEditors[task.id]) || !!store.namingRecoveryMessage" type="submit">确认改名</button><button class="small-button" :disabled="taskBusy(task)" type="button" @click="delete nameEditors[task.id]">取消</button></div>
          </form>
          <details v-if="task.infoHash" class="task-download-details"><summary>查看下载标识</summary><code>{{ task.infoHash }}</code></details>
        </div>
        <div class="task-actions">
          <template v-if="outputChoices[task.id]?.length">
            <label v-if="outputChoices[task.id].length > 1" class="completed-output-choice"><span>选择打开文件</span><select v-model="outputSelections[task.id]" :disabled="taskBusy(task)"><option value="">先选择一个文件</option><option v-for="output in outputChoices[task.id]" :key="output.path" :value="output.path">{{ output.label }}</option></select></label>
            <button class="small-button" :disabled="!isTauriRuntime() || taskBusy(task) || !selectedOutput(task)" :title="selectedOutput(task)?.path || '先选择需要打开的文件'" type="button" @click="openTaskOutput(task)">打开文件</button>
          </template>
          <button v-if="task.state === 'completed' && task.engineId === 'aria2' && task.files.length" class="small-button" :disabled="taskBusy(task) || !!store.namingRecoveryMessage" type="button" @click="openNameEditor(task)">{{ task.naming?.status === 'renamed' ? '修改名称' : '自动命名' }}</button>
          <button v-if="['queued', 'downloading'].includes(task.state)" class="small-button" :disabled="pendingTaskActions.has(task.id)" type="button" @click="taskAction(task.id, () => store.pause(task))">暂停</button>
          <button v-if="task.state === 'paused'" class="small-button" :disabled="pendingTaskActions.has(task.id)" type="button" @click="taskAction(task.id, () => store.resume(task))">继续</button>
          <button v-if="['failed', 'cancelled'].includes(task.state)" class="small-button" :disabled="pendingTaskActions.has(task.id)" type="button" @click="taskAction(task.id, () => store.retry(task))">重试</button>
          <button v-if="statusUnavailable(task)" class="small-button" :disabled="pendingTaskActions.has(task.id)" type="button" @click="taskAction(task.id, () => store.refreshAll())">刷新状态</button>
          <RouterLink v-if="task.mediaId && (task.state === 'failed' || task.stage === 'connecting')" class="small-button" :to="'/media/' + encodeURIComponent(task.mediaId)">查找其它资源</RouterLink>
          <button class="small-button" type="button" @click="openDirectory(task)">下载目录</button>
          <button v-if="task.tempPath" class="small-button" type="button" @click="openPath(task.tempPath, '临时目录')">临时目录</button>
          <button v-if="task.finalPath" class="small-button" type="button" @click="openPath(task.finalPath, '最终目录')">最终目录</button>
          <template v-if="['completed', 'failed', 'cancelled'].includes(task.state)">
            <button class="small-button" :disabled="taskBusy(task)" type="button" @click="removeTask(task, false)">删记录</button>
            <button v-if="isTauriRuntime() && task.files.length" class="small-button danger" :disabled="taskBusy(task)" type="button" @click="removeTask(task, true)">删记录和文件</button>
          </template>
          <button v-if="['queued', 'downloading', 'paused'].includes(task.state)" class="small-button danger" :disabled="pendingTaskActions.has(task.id)" type="button" @click="taskAction(task.id, () => store.cancel(task))">取消</button>
        </div>
      </article>
    </div>

    <div v-if="visibleLocalTasks.length" class="local-downloads">
      <div class="card-heading local-download-heading">
        <div>
          <h3>视频与书籍</h3>
          <p class="muted">下载结束后，可以直接打开 MP4、CBZ 或 TXT 文件。</p>
        </div>
      </div>
      <div class="task-list">
        <article v-for="task in visibleLocalTasks" :key="task.id" class="task-row">
          <div class="task-main">
            <div class="task-title-line">
              <strong :title="task.outputPath">{{ task.title }}</strong>
              <span class="state-pill" :data-state="task.stage">{{ localStageLabel(task.stage) }}</span>
            </div>
            <div class="progress-track"><span :style="{ width: `${localProgress(task)}%` }"></span></div>
            <div class="task-meta">
              <span>{{ task.kind === 'video' ? '视频 MP4' : task.kind === 'novel' ? '轻小说 TXT' : '漫画 CBZ' }}</span>
              <span>{{ task.kind === 'video' ? `${task.completedUnits}%` : `${task.completedUnits} / ${task.totalUnits || '—'} 步` }}</span>
              <span>{{ task.sourceName }}</span>
              <span>{{ task.detail || task.outputPath }}</span>
              <span v-if="task.error" class="error-text">{{ task.error }}</span>
            </div>
            <p v-if="task.stage === 'completed' && !localStore.ownedOutputPath(task.id)" class="hint">此记录的文件归属已变化，或路径正在处理。请核对输出目录，并从当前任务打开成品。</p>
          </div>
          <div class="task-actions">
            <button v-if="task.stage === 'completed' && isTauriRuntime()" class="small-button" :disabled="!localStore.ownedOutputPath(task.id) || pendingTaskActions.has(task.id)" type="button" @click="openCompletedFile(task)">打开文件</button>
            <button class="small-button" type="button" @click="openPath(task.directory, '输出目录')">输出目录</button>
            <button v-if="['preparing', 'downloading', 'packaging'].includes(task.stage)" class="small-button danger" :disabled="pendingTaskActions.has(task.id)" type="button" @click="taskAction(task.id, () => localStore.cancel(task.id))">取消</button>
            <template v-else>
              <span v-if="localStore.isRunning(task.id)" class="muted">正在等待当前步骤停止…</span>
              <button class="small-button" :disabled="localStore.isRunning(task.id) || pendingTaskActions.has(task.id)" type="button" @click="removeLocalTask(task, false)">删记录</button>
              <button v-if="isTauriRuntime() && task.cleanupPaths?.length" :disabled="localStore.isRunning(task.id) || pendingTaskActions.has(task.id)" class="small-button danger" type="button" @click="removeLocalTask(task, true)">删记录和文件</button>
            </template>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-phase-detail{margin:8px 0 0;line-height:1.7}.state-pill.status-warning{color:#af586c;background:#fff0f3}.task-download-details{font-size:11px;color:#9c86ad;margin-top:9px}.task-download-details summary{cursor:pointer}.task-download-details code{display:block;overflow-wrap:anywhere;margin-top:7px;font-size:10px}.task-actions>a{text-decoration:none;display:inline-flex;align-items:center}.completed-name-editor{padding:14px;margin-top:12px;border:1px solid #e7dbee;border-radius:9px;background:#fff}.completed-name-editor label{display:grid;gap:7px;font-size:11px;color:#806a91}.completed-name-editor input,.completed-name-editor select{width:100%;box-sizing:border-box;font-size:12px}.completed-name-editor .task-actions{justify-content:flex-start;margin-top:10px}.naming-history p{font-size:10px;overflow-wrap:anywhere}
.completed-output-choice{display:grid;gap:4px;max-width:270px;font-size:11px;color:#806a91}.completed-output-choice select{min-width:0;max-width:100%;font-size:12px}
</style>
