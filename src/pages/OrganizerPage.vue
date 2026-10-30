<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { DownloadTask } from "@/domain/download";
import type { OrganizationPlan } from "@/domain/organization";
import { buildOrganizationPlan } from "@/domain/organization";
import { createFileOrganizer } from "@/infrastructure/organizer/local-organizer";
import { useDownloadStore } from "@/stores/download";
import { useMediaLibraryStore } from "@/stores/media-library";
import { isTauriRuntime } from "@/shared/runtime";
import { loadSettings } from "@/shared/settings";
import { onDownloadCompleted } from "@/application/download-events";
import { useOrganizationHistoryStore } from "@/stores/organization-history";
import { newId } from "@/shared/runtime";

const downloadStore = useDownloadStore();
const mediaLibrary = useMediaLibraryStore();
const history = useOrganizationHistoryStore();
const settings = ref(loadSettings());
const selectedMediaByTask = ref<Record<string, string>>({});
const filesByTask = ref<Record<string, string[]>>({});
const selectedFilesByTask = ref<Record<string, string[]>>({});
const plans = ref<Record<string, OrganizationPlan[]>>({});
const messages = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
const episodeOverrides = ref<Record<string, string>>({});
const busyTaskId = ref("");
const loadingFiles = ref(false);
const showOrganized = ref(false);
const organizer = createFileOrganizer();
let stopCompletedEvents: (() => void) | undefined;

const completedTasks = computed(() =>
  downloadStore.tasks.filter((task) => task.state === "completed" && task.files.length > 0 && (showOrganized.value || !task.finalPath)),
);

onMounted(async () => {
  try {
    await Promise.all([downloadStore.initialize(), mediaLibrary.initialize(), history.initialize()]);
    await discoverFiles();
    stopCompletedEvents = onDownloadCompleted((event) => void discoverFilesForTask(event.task));
  } catch (cause) { errors.value.page = cause instanceof Error ? cause.message : "整理记录读取失败，请刷新重试"; }
});

onUnmounted(() => stopCompletedEvents?.());

async function discoverFiles(): Promise<void> {
  loadingFiles.value = true;
  try {
    for (const task of completedTasks.value) await discoverFilesForTask(task);
  } finally {
    loadingFiles.value = false;
  }
}

async function discoverFilesForTask(task: DownloadTask): Promise<void> {
  try {
    const discovered = isTauriRuntime()
      ? (await Promise.all(task.files.map((source) => organizer.listFiles(source, settings.value.incomingDirectory || task.directory)))).flat()
      : task.files;
    const files = [...new Set(discovered)].sort();
    filesByTask.value[task.id] = files;
    selectedFilesByTask.value[task.id] = files;
    if (!selectedMediaByTask.value[task.id] && mediaLibrary.items.some((media) => media.id === task.mediaId)) {
      selectedMediaByTask.value[task.id] = task.mediaId!;
    }
  } catch (cause) {
    errors.value[task.id] = cause instanceof Error ? cause.message : "任务文件发现失败";
  }
}

function taskFiles(task: DownloadTask): string[] {
  return filesByTask.value[task.id] ?? task.files;
}

function selectedFiles(task: DownloadTask): string[] {
  return selectedFilesByTask.value[task.id] ?? [];
}

function toggleAll(task: DownloadTask): void {
  selectedFilesByTask.value[task.id] = selectedFiles(task).length === taskFiles(task).length ? [] : [...taskFiles(task)];
  clearPlan(task.id);
}

function clearPlan(taskId: string): void {
  delete plans.value[taskId];
  clearFeedback(taskId);
}

function episodeKey(taskId: string, sourcePath: string): string {
  return `${taskId}::${sourcePath}`;
}

function manualEpisode(taskId: string, sourcePath: string): { season: number; episode: number } | undefined {
  const raw = episodeOverrides.value[episodeKey(taskId, sourcePath)]?.trim();
  if (!raw) return undefined;
  const match = raw.match(/^S?(\d{1,2})(?:E|x)(\d{1,3})$/i) ?? raw.match(/^(\d{1,3})$/);
  if (!match) throw new Error("手动集数格式应为 S01E07、1x07 或 07");
  return match.length === 3
    ? { season: Number(match[1]), episode: Number(match[2]) }
    : { season: 1, episode: Number(match[1]) };
}

function selectedMedia(task: DownloadTask) {
  return mediaLibrary.items.find((item) => item.id === selectedMediaByTask.value[task.id]);
}

function buildPlan(task: DownloadTask): void {
  delete plans.value[task.id];
  clearFeedback(task.id);
  const media = selectedMedia(task);
  const sources = selectedFiles(task);
  if (!sources.length) {
    errors.value[task.id] = "请至少选择一个文件。";
    return;
  }
  if (!media) {
    errors.value[task.id] = "请先从本地作品库选择对应作品。";
    return;
  }
  try {
    const nextPlans = sources.map((sourcePath) => buildOrganizationPlan({
        taskId: task.id,
        sourcePath,
        incomingRoot: settings.value.incomingDirectory || task.directory,
        libraryRoot: settings.value.libraryDirectory,
        media,
        episodeOverride: manualEpisode(task.id, sourcePath),
      }));
    const destinations = new Set<string>();
    for (const plan of nextPlans) {
      const destination = plan.destinationPath.toLowerCase();
      if (destinations.has(destination)) {
        throw new Error("所选文件会生成相同目标路径，请减少选择或先人工改名");
      }
      destinations.add(destination);
    }
    plans.value[task.id] = nextPlans;
  } catch (cause) {
    errors.value[task.id] = cause instanceof Error ? cause.message : "整理计划生成失败";
  }
}

async function organize(task: DownloadTask): Promise<void> {
  if (busyTaskId.value) return;
  clearFeedback(task.id);
  const taskPlans = plans.value[task.id]?.map((plan) => ({ ...plan }));
  if (!taskPlans?.length) {
    errors.value[task.id] = "请先生成并检查路径预览，再确认整理。";
    return;
  }

  busyTaskId.value = task.id;
  let moved = 0;
  let alreadyPresent = 0;
  const failures: string[] = [];
  try {
    for (const plan of taskPlans) {
      try {
        const result = await organizer.organize(plan);
        if (result.status === "conflict") {
          failures.push(`${plan.sourcePath}：目标文件已存在，本次未移动或覆盖`);
        } else if (result.status === "already_present") alreadyPresent += 1;
        else if (result.status === "moved") moved += 1;
        await appendHistory({
          id: newId(),
          taskId: task.id,
          mediaId: plan.mediaId,
          sourcePath: plan.sourcePath,
          destinationPath: plan.destinationPath,
          status: result.status === "conflict" ? "failed" : result.status,
          ...(result.status === "conflict" ? { error: "目标文件已存在，本次未移动或覆盖" } : {}),
          createdAt: new Date().toISOString(),
        }, task.id);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "整理失败";
        failures.push(`${plan.sourcePath}：${message}`);
        await appendHistory({
          id: newId(),
          taskId: task.id,
          mediaId: plan.mediaId,
          sourcePath: plan.sourcePath,
          destinationPath: plan.destinationPath,
          status: "failed",
          error: message,
          createdAt: new Date().toISOString(),
        }, task.id);
      }
    }
    const selectedAllFiles = taskPlans.length === taskFiles(task).length;
    if (!failures.length && selectedAllFiles) {
      await downloadStore.markOrganized(task.id, taskPlans.length === 1 ? taskPlans[0].destinationPath : taskPlans[0].libraryRoot);
    }
    messages.value[task.id] = `移动 ${moved} 个，已整理 ${alreadyPresent} 个，未完成 ${failures.length} 个。${!selectedAllFiles ? "本次仅处理所选文件，其余文件仍保留在原处。" : ""}`;
    if (failures.length) errors.value[task.id] = failures.join("\n");
    if (!failures.length) delete plans.value[task.id];
  } catch (cause) {
    errors.value[task.id] = cause instanceof Error ? cause.message : "文件整理失败";
  } finally {
    busyTaskId.value = "";
  }
}

async function appendHistory(record: Parameters<typeof history.add>[0], taskId: string): Promise<void> {
  try {
    await history.add(record);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "整理历史写入失败";
    errors.value[taskId] = `${errors.value[taskId] ? `${errors.value[taskId]}\n` : ""}${message}`;
  }
}

function clearFeedback(taskId: string): void {
  delete errors.value[taskId];
  delete messages.value[taskId];
}

function mediaTypeLabel(type: string): string {
  return { anime: "动画", manga: "漫画", novel: "小说", visual_novel: "视觉小说" }[type] ?? type;
}
</script>

<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">下载之后，归入收藏</p>
      <h2>自动整理</h2>
      <p class="muted">先展开任务文件并选择目标，再预览安全路径，最后手动确认批量移动。目标冲突不会覆盖文件。</p>
    </div>
  </section>

  <p v-if="errors.page || downloadStore.error || mediaLibrary.error || history.error" class="error-message" role="alert">{{ errors.page || downloadStore.error || mediaLibrary.error || history.error }}</p>

  <section class="card">
    <div class="card-heading">
      <div>
        <h3>整理边界</h3>
        <p class="muted">Incoming：{{ settings.incomingDirectory || "未设置" }}</p>
        <p class="muted">Library：{{ settings.libraryDirectory || "未设置" }}</p>
      </div>
      <RouterLink class="small-link" to="/settings">修改目录</RouterLink>
    </div>
    <p class="hint">支持单文件和目录型任务；符号链接会跳过，单任务最多展开 5000 个文件。动画支持自动识别，也可手动填写 S01E07、1x07 或 07；仍无法识别的文件会进入 Unmatched。</p>
  </section>

  <section class="card">
    <div class="card-heading">
      <div>
        <h3>待整理任务</h3>
        <p class="muted">{{ completedTasks.length }} 个可处理任务 · {{ mediaLibrary.items.length }} 个本地作品</p>
      </div>
      <div class="form-footer"><label class="scan-option"><input v-model="showOrganized" type="checkbox" @change="discoverFiles" />显示已整理任务</label><button class="ghost-button" :disabled="loadingFiles || !!busyTaskId" type="button" @click="discoverFiles">重新扫描</button></div>
    </div>

    <div v-if="!completedTasks.length" class="empty-state">
      <strong>暂时没有可整理任务</strong>
      <span>完成下载后，任务会出现在这里。</span>
    </div>

    <div v-else class="organizer-list">
      <article v-for="task in completedTasks" :key="task.id" class="organizer-row">
        <div class="organizer-main">
          <strong :title="task.sourceUrl">{{ task.filename || task.sourceName || '下载任务' }}</strong>
          <span class="task-meta">下载目录：{{ task.directory }}</span>
          <div class="file-selection">
            <div class="file-selection-heading">
              <span>{{ loadingFiles && !filesByTask[task.id] ? "正在发现文件…" : `发现 ${taskFiles(task).length} 个文件` }}</span>
              <button v-if="taskFiles(task).length" class="small-button" type="button" @click="toggleAll(task)">
                {{ selectedFiles(task).length === taskFiles(task).length ? "取消全选" : "全选" }}
              </button>
            </div>
            <label v-for="file in taskFiles(task)" :key="file" class="file-check">
              <input v-model="selectedFilesByTask[task.id]" type="checkbox" :value="file" :disabled="!!busyTaskId" @change="clearPlan(task.id)" />
              <span :title="file">{{ file }}</span>
              <input
                v-if="selectedMedia(task)?.type === 'anime'"
                v-model="episodeOverrides[episodeKey(task.id, file)]"
                class="episode-input"
                type="text"
                placeholder="集数"
                title="可选：S01E07、1x07 或 07"
                :disabled="!!busyTaskId"
                @input="clearPlan(task.id)"
              />
            </label>
          </div>
        </div>
        <div class="organizer-controls">
          <label>
            <span>关联作品</span>
            <select v-model="selectedMediaByTask[task.id]" :disabled="!!busyTaskId" @change="clearPlan(task.id)">
              <option value="">请选择本地作品</option>
              <option v-for="media in mediaLibrary.items" :key="media.id" :value="media.id">
                [{{ mediaTypeLabel(media.type) }}] {{ media.title }}
              </option>
            </select>
          </label>
          <div class="organizer-actions">
            <button class="small-button" :disabled="!!busyTaskId || !selectedFiles(task).length || !selectedMedia(task)" type="button" @click="buildPlan(task)">预览整理路径</button>
            <button class="primary-button" :disabled="!!busyTaskId || !plans[task.id]?.length || !isTauriRuntime()" type="button" @click="organize(task)">
              {{ busyTaskId === task.id ? "整理中…" : "确认并整理" }}
            </button>
          </div>
        </div>
        <div v-if="plans[task.id]?.length" class="organizer-preview">
          <span v-for="plan in plans[task.id]" :key="plan.sourcePath">{{ plan.sourcePath }} → {{ plan.destinationPath }}</span>
          <span v-if="plans[task.id].some((plan) => plan.warning === 'episode_unresolved')" class="warning-message">部分动画未识别集数，将保留原文件名</span>
        </div>
        <p v-if="errors[task.id]" class="error-message">{{ errors[task.id] }}</p>
        <p v-if="messages[task.id]" class="hint" role="status">{{ messages[task.id] }}</p>
      </article>
    </div>
  </section>

  <section v-if="!mediaLibrary.items.length" class="card note-card">
    <h3>先建立本地作品库</h3>
    <p class="muted">去“作品搜索”收藏作品，整理时即可选择规范化标题和媒体类型。</p>
  </section>

  <section class="card">
    <div class="card-heading">
      <div><h3>最近整理记录</h3><p class="muted">保留最近 {{ history.records.length }} 条记录</p></div>
    </div>
    <div v-if="!history.records.length" class="empty-state"><span>还没有整理记录。</span></div>
    <div v-else class="history-list">
      <article v-for="record in history.records.slice(0, 20)" :key="record.id" class="history-row">
        <div><strong>{{ record.destinationPath }}</strong><span class="muted">{{ record.sourcePath }}</span></div>
        <span class="state-pill" :class="record.status">{{ record.status === 'moved' ? '已移动' : record.status === 'already_present' ? '已存在' : '失败' }}</span>
      </article>
    </div>
  </section>
</template>
