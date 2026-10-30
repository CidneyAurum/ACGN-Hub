<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { GameInstall, GameScanResult } from "@/domain/game";
import { useMediaLibraryStore } from "@/stores/media-library";
import { createGameService } from "@/infrastructure/games/tauri-game-service";
import { createGameInstallRepository } from "@/infrastructure/database/create-game-install-repository";
import { isTauriRuntime } from "@/shared/runtime";
import { loadSettings } from "@/shared/settings";
import { sanitizeFileName } from "@/domain/organization";

const title = ref("");
const mediaId = ref("");
const rootPath = ref("");
const launchPath = ref("");
const savePathText = ref("");
const scan = ref<GameScanResult>();
const installs = ref<GameInstall[]>([]);
const busy = ref(false);
const error = ref("");
const message = ref("");
const mediaLibrary = useMediaLibraryStore();
const visualNovels = computed(() => mediaLibrary.items.filter((item) => item.type === "visual_novel"));

onMounted(() => void initialize());
watch(rootPath, (value) => {
  if (scan.value && value.trim().toLowerCase() !== scan.value.rootPath.toLowerCase()) {
    scan.value = undefined;
    launchPath.value = "";
  }
});

async function initialize(): Promise<void> {
  try {
    const [repository] = await Promise.all([createGameInstallRepository(), mediaLibrary.initialize()]);
    installs.value = await repository.list();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Galgame 安装记录读取失败";
  }
}

async function scanGame(): Promise<void> {
  clearNotice();
  if (!isTauriRuntime()) {
    error.value = "Galgame 本地扫描只在桌面端可用";
    return;
  }
  if (!isAbsoluteWindowsPath(rootPath.value)) {
    error.value = "请填写游戏安装目录的 Windows 绝对路径";
    return;
  }
  busy.value = true;
  const requestedRoot = rootPath.value.trim();
  scan.value = undefined;
  launchPath.value = "";
  try {
    const scanned = await createGameService().scan(requestedRoot);
    if (rootPath.value.trim() !== requestedRoot) throw new Error("安装目录已变化，请重新扫描当前目录");
    scan.value = scanned;
    rootPath.value = scan.value.rootPath;
    launchPath.value = scan.value.launchCandidates[0] ?? "";
    message.value = `扫描完成：${engineLabel(scan.value.engine)}，找到 ${scan.value.launchCandidates.length} 个候选启动文件`;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Galgame 扫描失败";
  } finally {
    busy.value = false;
  }
}

async function saveInstall(): Promise<void> {
  clearNotice();
  if (!scan.value || !title.value.trim()) {
    error.value = "请先扫描游戏并填写游戏名称";
    return;
  }
  try {
    const repository = await createGameInstallRepository();
    const existing = installs.value.find((item) => item.path.toLowerCase() === scan.value?.rootPath.toLowerCase());
    const timestamp = new Date().toISOString();
    const install: GameInstall = {
      id: existing?.id ?? `game:${scan.value.rootPath.toLowerCase()}`,
      path: scan.value.rootPath,
      title: title.value.trim(),
      ...(mediaId.value ? { mediaId: mediaId.value } : {}),
      ...(selectedVisualNovel.value?.coverUrl ? { coverUrl: selectedVisualNovel.value.coverUrl } : {}),
      engine: scan.value.engine,
      ...(launchPath.value ? { launchPath: launchPath.value } : {}),
      detectedFiles: scan.value.detectedFiles,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await repository.upsert(install);
    installs.value = await repository.list();
    message.value = "安装记录已保存";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "安装记录保存失败";
  }
}

async function launchGame(): Promise<void> {
  clearNotice();
  if (!scan.value || !launchPath.value) {
    error.value = "请先扫描并选择一个启动文件";
    return;
  }
  if (!window.confirm(`确认启动“${title.value.trim() || scan.value.rootPath}”吗？`)) return;
  busy.value = true;
  try {
    await createGameService().launch(scan.value.rootPath, launchPath.value);
    message.value = "已发送启动请求；应用不会自动再次启动或注入参数";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "游戏启动失败";
  } finally {
    busy.value = false;
  }
}

async function backupSaves(): Promise<void> {
  clearNotice();
  if (!scan.value) {
    error.value = "请先扫描游戏安装目录";
    return;
  }
  const savePaths = [...new Set(savePathText.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
  if (!savePaths.length) {
    error.value = "请填写游戏目录内的存档文件或目录，每行一个相对路径";
    return;
  }
  const settings = loadSettings();
  if (!isAbsoluteWindowsPath(settings.backupDirectory)) {
    error.value = "请先在设置中填写存档备份根目录";
    return;
  }
  if (!window.confirm(`确认备份 ${savePaths.length} 个存档路径吗？已有备份不会被覆盖。`)) return;
  busy.value = true;
  try {
    const backupName = `${sanitizeFileName(title.value.trim() || "game")}-${Date.now()}`;
    const backupPath = await createGameService().backupSaves(scan.value.rootPath, savePaths, settings.backupDirectory, backupName);
    message.value = `存档备份完成：${backupPath}`;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "存档备份失败";
  } finally {
    busy.value = false;
  }
}

function loadInstall(install: GameInstall): void {
  clearNotice();
  title.value = install.title;
  mediaId.value = install.mediaId ?? "";
  rootPath.value = install.path;
  launchPath.value = install.launchPath ?? "";
  savePathText.value = "";
  scan.value = {
    rootPath: install.path,
    engine: install.engine,
    launchCandidates: install.launchPath ? [install.launchPath] : [],
    detectedFiles: install.detectedFiles,
  };
}

const selectedVisualNovel = computed(() => visualNovels.value.find((item) => item.id === mediaId.value));

function selectVisualNovel(): void {
  const selected = selectedVisualNovel.value;
  if (selected) title.value = selected.title;
}

function clearNotice(): void {
  error.value = "";
  message.value = "";
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value.trim()) && !value.includes("..") && value.trim().length < 4096;
}

function engineLabel(engine: GameScanResult["engine"]): string {
  return { renpy: "Ren'Py", kirikiri: "KiriKiri", unity: "Unity", unknown: "未识别" }[engine];
}

</script>

<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">从收藏，到下一次启动</p>
      <h2>Galgame 管理</h2>
      <p class="muted">扫描本地安装目录，识别常见引擎并保存启动配置。只有你明确点击并确认后才会启动 EXE。</p>
    </div>
  </section>

  <section class="card">
    <form class="game-form" @submit.prevent="scanGame">
      <label><span>关联视觉小说（可选）</span><select v-model="mediaId" @change="selectVisualNovel"><option value="">不关联本地作品库</option><option v-for="item in visualNovels" :key="item.id" :value="item.id">{{ item.title }}</option></select></label>
      <label><span>游戏名称</span><input v-model="title" type="text" placeholder="例如：我的视觉小说" required /></label>
      <label><span>安装目录</span><input v-model="rootPath" type="text" placeholder="例如 D:\\Games\\Title" required /></label>
      <div class="form-footer"><button class="primary-button" :disabled="busy" type="submit">{{ busy ? "处理中…" : "扫描安装目录" }}</button><button class="ghost-button" :disabled="busy || !scan" type="button" @click="saveInstall">保存安装记录</button></div>
    </form>
    <p v-if="scan" class="game-summary"><strong>{{ engineLabel(scan.engine) }}</strong> · {{ scan.rootPath }} · 检测到 {{ scan.detectedFiles.length }} 个引擎线索</p>
    <label v-if="scan" class="wide-field"><span>启动文件（仅允许游戏目录内 EXE）</span><select v-model="launchPath"><option value="">不设置</option><option v-for="candidate in scan.launchCandidates" :key="candidate" :value="candidate">{{ candidate }}</option></select></label>
    <p v-if="error" class="error-message">{{ error }}</p>
    <p v-if="message" class="success-message">{{ message }}</p>
  </section>

  <section v-if="scan" class="card">
    <div class="card-heading"><div><h3>明确操作</h3><p class="muted">启动不会自动发生；存档备份使用新的时间目录，发现同名文件直接失败。</p></div></div>
    <div class="game-actions"><button class="primary-button" :disabled="busy || !launchPath" type="button" @click="launchGame">确认启动游戏</button><button class="ghost-button" :disabled="busy" type="button" @click="backupSaves">备份存档</button></div>
    <label class="wide-field"><span>存档路径（相对于安装目录，每行一个；也可填目录）</span><textarea v-model="savePathText" rows="4" placeholder="save&#10;game/saves"></textarea></label>
  </section>

  <section class="card">
    <div class="card-heading"><div><h3>已保存安装</h3><p class="muted">{{ installs.length }} 条记录</p></div></div>
    <div v-if="!installs.length" class="empty-state"><strong>还没有安装记录</strong><span>扫描并保存一个本地 Galgame。</span></div>
    <div v-else class="game-install-list">
      <article v-for="install in installs" :key="install.id" class="game-install-row">
        <div><strong>{{ install.title }}</strong><p class="muted">{{ engineLabel(install.engine) }} · {{ install.path }}</p><RouterLink v-if="install.mediaId" class="small-link" :to="`/media/${install.mediaId}`">打开作品详情</RouterLink></div>
        <button class="small-button" type="button" @click="loadInstall(install)">载入配置</button>
      </article>
    </div>
  </section>
</template>
