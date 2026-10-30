<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useMediaLibraryStore } from "@/stores/media-library";
import { createLibraryFileScanner } from "@/infrastructure/organizer/local-file-scanner";
import { createLocalFileRepository } from "@/infrastructure/database/create-local-file-repository";
import { isTauriRuntime } from "@/shared/runtime";
import { loadSettings } from "@/shared/settings";
import type { LocalFile } from "@/domain/local-file";
import type { Media } from "@/domain/media";
import type { LocalFileRepository } from "@/application/local-file-ports";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import MediaCard from "@/components/MediaCard.vue";
import { useTrackingStore, trackingLabels, type TrackingStatus } from "@/stores/tracking";

const library = useMediaLibraryStore();
const route = useRoute();
const tracking = useTrackingStore();
const statusFilter = ref<"all" | TrackingStatus>("all");
const statusFilters: Array<{ id: "all" | TrackingStatus; title: string }> = [{ id: "all", title: "全部收藏" }, ...Object.entries(trackingLabels).map(([id, title]) => ({ id: id as TrackingStatus, title }))];
const files = ref<LocalFile[]>([]);
const scanning = ref(false);
const scanError = ref("");
const fileActionError = ref("");
const hashScan = ref(false);
const mediaTypeFilter = ref<"all" | Media["type"]>("all");
const mediaFilters: Array<{ id: "all" | Media["type"]; title: string }> = [
  { id: "all", title: "全部" }, { id: "anime", title: "动画" }, { id: "manga", title: "漫画" },
  { id: "novel", title: "小说" }, { id: "visual_novel", title: "Galgame" },
];
const mediaQuery = ref("");
const fileQuery = ref("");
const fileLimit = ref(100);
const fileStatus = ref("all");
const visibleMediaItems = computed(() => library.items.filter((item) => {
  if (statusFilter.value !== "all" && tracking.get(item).status !== statusFilter.value) return false;
  if (mediaTypeFilter.value !== "all" && item.type !== mediaTypeFilter.value) return false;
  const query = mediaQuery.value.trim().toLocaleLowerCase();
  return !query || [item.title, item.originalTitle, ...item.aliases].some((title) => title?.toLocaleLowerCase().includes(query));
}));
const filteredFiles = computed(() => files.value.filter((file) => {
  if (fileStatus.value !== "all" && file.status !== fileStatus.value) return false;
  return !fileQuery.value.trim() || file.path.toLocaleLowerCase().includes(fileQuery.value.trim().toLocaleLowerCase());
}));
const visibleFiles = computed(() => filteredFiles.value.slice(0, fileLimit.value));
const presentFiles = computed(() => files.value.filter((file) => file.status !== "missing").length);
const missingFiles = computed(() => files.value.filter((file) => file.status === "missing").length);
const duplicateFiles = computed(() => files.value.filter((file) => file.status === "duplicate").length);
let fileRepository: LocalFileRepository | undefined;

onMounted(async () => {
  restoreFiltersFromRoute();
  try {
    await library.initialize();
    fileRepository = await createLocalFileRepository();
    files.value = await fileRepository.list();
  } catch (cause) { scanError.value = cause instanceof Error ? cause.message : "本地文件索引读取失败"; }
});
watch(() => [route.query.type, route.query.status], restoreFiltersFromRoute);

function restoreFiltersFromRoute(): void {
  const status = String(route.query.status ?? "all");
  const type = String(route.query.type ?? "all");
  statusFilter.value = statusFilters.some((filter) => filter.id === status) ? status as typeof statusFilter.value : "all";
  mediaTypeFilter.value = mediaFilters.some((filter) => filter.id === type) ? type as typeof mediaTypeFilter.value : "all";
}

async function scanFiles(): Promise<void> {
  scanning.value = true;
  scanError.value = "";
  try {
    fileRepository ??= await createLocalFileRepository();
    const repository = fileRepository;
    if (!isTauriRuntime()) {
      files.value = await repository.list();
      return;
    }
    const entries = await createLibraryFileScanner().scan(loadSettings().libraryDirectory, hashScan.value);
    await repository.replaceScan(entries);
    files.value = await repository.list();
  } catch (cause) {
    scanError.value = cause instanceof Error ? cause.message : "本地文件扫描失败";
  } finally {
    scanning.value = false;
  }
}

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function typeLabel(type: string): string {
  return { anime: "动画", manga: "漫画", novel: "小说", visual_novel: "视觉小说" }[type] ?? type;
}

async function remove(mediaId: string): Promise<void> {
  fileActionError.value = "";
  try { await library.remove(mediaId); }
  catch (cause) { fileActionError.value = cause instanceof Error ? cause.message : "移除收藏失败"; }
}

function mediaTitle(mediaId?: string): string {
  return library.items.find((item) => item.id === mediaId)?.title ?? "未匹配作品";
}

function updateFileMedia(fileId: string, event: Event): void {
  const mediaId = (event.target as HTMLSelectElement).value || undefined;
  fileActionError.value = "";
  void (async () => {
    if (!fileRepository) fileRepository = await createLocalFileRepository();
    await fileRepository.assignMedia(fileId, mediaId);
    files.value = await fileRepository.list();
  })().catch((cause) => {
    fileActionError.value = cause instanceof Error ? cause.message : "本地文件匹配失败";
  });
}

function openFile(file: LocalFile): void {
  if (!isTauriRuntime()) {
    fileActionError.value = "打开本地文件只在桌面端可用";
    return;
  }
  fileActionError.value = "";
  void openPath(file.path).catch((cause) => {
    fileActionError.value = cause instanceof Error ? cause.message : "打开文件失败";
  });
}

function revealFile(file: LocalFile): void {
  if (!isTauriRuntime()) {
    fileActionError.value = "打开文件位置只在桌面端可用";
    return;
  }
  fileActionError.value = "";
  void revealItemInDir(file.path).catch((cause) => {
    fileActionError.value = cause instanceof Error ? cause.message : "打开文件位置失败";
  });
}
</script>

<template>
  <div class="collection-page">
    <header class="collection-heading"><div><span>MY COLLECTION</span><h1>我的追番库 <small>{{ library.items.length }}</small></h1></div><RouterLink to="/search">发现作品 <span>＋</span></RouterLink></header>
    <nav class="collection-status-tabs" aria-label="追番状态"><button v-for="filter in statusFilters" :key="filter.id" :class="{ active: statusFilter === filter.id }" type="button" @click="statusFilter = filter.id">{{ filter.title }}<small>{{ filter.id === 'all' ? library.items.length : library.items.filter(item => tracking.get(item).status === filter.id).length }}</small></button></nav>
    <div class="collection-toolbar"><div class="collection-types" aria-label="内容类型"><button v-for="filter in mediaFilters" :key="filter.id" :class="{ active: mediaTypeFilter === filter.id }" type="button" @click="mediaTypeFilter = filter.id">{{ filter.title }}</button></div><input v-model="mediaQuery" aria-label="搜索收藏作品" type="search" placeholder="在我的收藏中搜索…" /></div>
    <div v-if="library.error || fileActionError" class="collection-warning" role="alert">{{ library.error || fileActionError }}<button v-if="library.error" type="button" @click="library.initialize">重试</button></div>
    <section v-if="library.loading && !library.items.length" class="collection-empty" role="status"><h2>正在打开收藏…</h2></section>
    <section v-else-if="!library.items.length" class="collection-empty"><h2>这里，等着你喜欢的作品。</h2><p>收藏一部动画、漫画、小说或 Galgame，为它记下自己的进度。</p><RouterLink class="primary-button" to="/search">去发现第一部作品</RouterLink></section>
    <section v-else-if="visibleMediaItems.length" class="collection-grid" aria-label="收藏作品"><MediaCard v-for="item in visibleMediaItems" :key="item.id" :media="item" :saved="true" @toggle-save="remove(item.id)"><template #footer><span>{{ trackingLabels[tracking.get(item).status] }}</span><span v-if="tracking.get(item).episode">{{ tracking.get(item).episode }}{{ tracking.get(item).total ? ' / ' + tracking.get(item).total : '' }} 集</span><span v-else>{{ item.releaseYear || typeLabel(item.type) }}</span></template></MediaCard></section>
    <section v-else class="collection-empty"><h2>这个分组还没有作品</h2><p>切换筛选，或在作品详情中更新追番状态。</p><button class="ghost-button" type="button" @click="statusFilter = 'all'; mediaTypeFilter = 'all'; mediaQuery = ''">查看全部收藏</button></section>  <details class="library-files-panel"><summary>本地文件 <span>索引与扫描 · {{ presentFiles }} 个文件</span></summary>
    <div class="card-heading">
      <div><h3>本地文件索引</h3><p class="muted">扫描范围：{{ loadSettings().libraryDirectory || "未设置" }} · 存在 {{ presentFiles }} · 缺失 {{ missingFiles }} · 重复 {{ duplicateFiles }}</p></div>
      <label class="scan-option"><input v-model="hashScan" type="checkbox" /><span>计算 SHA-256（较慢）</span></label>
      <button class="ghost-button" :disabled="scanning" type="button" @click="scanFiles">{{ scanning ? "扫描中…" : "扫描 Library" }}</button>
    </div>
    <p v-if="scanError" class="error-message">{{ scanError }}</p>
    <p v-if="fileActionError" class="error-message">{{ fileActionError }}</p>
    <div class="list-toolbar"><input v-model="fileQuery" aria-label="筛选本地文件" type="search" placeholder="搜索本地文件路径" /><select v-model="fileStatus" aria-label="本地文件状态"><option value="all">全部状态</option><option value="present">存在</option><option value="missing">缺失</option><option value="duplicate">重复</option></select></div>
    <div v-if="!files.length && !scanError" class="empty-state"><span>{{ isTauriRuntime() ? "尚无扫描记录。点击“扫描 Library”建立本地文件索引。" : "浏览器开发模式不会访问本地文件系统。" }}</span></div>
    <div v-else-if="files.length && !filteredFiles.length" class="empty-state"><span>没有符合当前筛选的文件。</span></div>
    <div v-else class="file-index-list">
      <div v-for="file in visibleFiles" :key="file.id" class="file-index-row">
        <div class="file-index-main">
          <span :title="file.path">{{ file.path }}</span>
          <code>{{ file.status === 'missing' ? '缺失' : file.status === 'duplicate' ? '重复' : '存在' }} · {{ formatBytes(file.sizeBytes) }} · {{ mediaTitle(file.mediaId) }}</code>
        </div>
        <div class="file-index-actions">
          <select :value="file.mediaId ?? ''" aria-label="手动匹配作品" @change="updateFileMedia(file.id, $event)">
            <option value="">未匹配</option>
            <option v-for="media in library.items" :key="media.id" :value="media.id">{{ media.title }}</option>
          </select>
          <button class="small-button" :disabled="file.status === 'missing'" type="button" @click="openFile(file)">打开文件</button>
          <button class="small-button" :disabled="file.status === 'missing'" type="button" @click="revealFile(file)">文件位置</button>
        </div>
      </div>
    </div>
    <div v-if="filteredFiles.length > visibleFiles.length" class="form-footer"><button class="ghost-button" type="button" @click="fileLimit += 100">再显示 100 个</button><span class="muted">已显示 {{ visibleFiles.length }} / {{ filteredFiles.length }}</span></div>
  </details>
  </div>
</template>

<style scoped>
.collection-page{max-width:1500px;margin:0 auto}.collection-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:2px 0 28px}.collection-heading>div>span{font-size:10px;letter-spacing:2px;color:#b5a9be}.collection-heading h1{font-size:28px;color:#40354e;letter-spacing:-1px;margin:9px 0 0;font-weight:680}.collection-heading h1 small{font-weight:400;color:#b0a0bc;font-size:16px;margin-left:6px}.collection-heading>a{color:#9a83b0;text-decoration:none;border:1px solid #e4dcea;background:#fff;padding:10px 15px;border-radius:9px;font-size:12px}.collection-heading>a span{margin-left:8px}.collection-status-tabs{display:flex;gap:28px;overflow-x:auto;border-bottom:1px solid #eae4ef}.collection-status-tabs button{position:relative;white-space:nowrap;padding:0 1px 15px;border:0;background:none;color:#a397ad;font-size:13px}.collection-status-tabs button.active{font-weight:650;color:#8466a6}.collection-status-tabs button.active:after{content:'';height:3px;background:#bc98c7;position:absolute;bottom:-1px;left:0;right:0;border-radius:3px}.collection-status-tabs small{font-size:10px;margin-left:7px;color:#b7a9c2;font-weight:400}.collection-toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:21px 0 26px}.collection-types{display:flex;gap:4px;flex-wrap:wrap}.collection-types button{background:transparent;border:0;border-radius:7px;padding:7px 12px;color:#ac9fb6;font-size:11px}.collection-types button.active{background:#eee7f5;color:#9376ad}.collection-toolbar input{max-width:240px;font-size:11px;background:#fff;border-color:#e9e1ee;padding:9px 12px;border-radius:9px}.collection-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:27px 20px}.collection-empty{padding:65px 20px;text-align:center;color:#aa9bb3}.collection-empty h2{font-size:19px;font-weight:550;color:#8b769e;margin-bottom:12px}.collection-empty p{font-size:12px;line-height:1.8;margin-bottom:23px}.collection-empty a{font-size:12px;text-decoration:none}.collection-warning{font-size:12px;line-height:1.8;color:#c27b92;padding:12px 0}.collection-warning button{margin-left:9px;border:0;background:#f6eaf1;color:#bc829d;padding:4px 10px;border-radius:6px}.library-files-panel{margin-top:44px;padding-top:20px;border-top:1px solid #e8e1ee}.library-files-panel>summary{cursor:pointer;font-size:13px;color:#8e7b9c;list-style-position:inside}.library-files-panel>summary span{margin-left:10px;font-size:10px;color:#b8adbf}.library-files-panel[open]>summary{margin-bottom:22px}.library-files-panel .card-heading h3{font-size:14px}.library-files-panel .muted,.library-files-panel .hint{font-size:11px}.library-files-panel .card-heading{flex-wrap:wrap}.library-files-panel .list-toolbar{margin:17px 0}.library-files-panel .error-message{font-size:12px}@media(min-width:1400px){.collection-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}@media(max-width:700px){.collection-status-tabs{gap:22px}.collection-toolbar{flex-direction:column;align-items:stretch;gap:12px}.collection-toolbar input{max-width:none}.collection-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:20px 12px}.collection-heading h1{font-size:24px}.collection-types button{padding:6px 10px}.library-files-panel>summary span{display:inline-block;font-size:9px}}@media(max-width:430px){.collection-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
