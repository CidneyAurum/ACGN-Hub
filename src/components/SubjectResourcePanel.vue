<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ResourceItem } from "@/domain/resource";
import type { MediaType } from "@/domain/media";
import type { SourceConfig } from "@/domain/source";
import { emptyGalgameResourceFilters, type GalgameResourceFilters } from "@/domain/galgame-resource";
import { isAndroidRuntime } from "@/shared/runtime";
const android = isAndroidRuntime();
interface SourceOption { config: SourceConfig; providerId: string; description: string }
const props = defineProps<{
  options: SourceOption[]; source: string; keyword: string; resources: ResourceItem[];
  selected: string[]; loading: boolean; queried: boolean; error: string; notice: string;
  adding: string; batchAdding: boolean; filter: string; protocol: string;
  sourceNames: Record<string, string>; groupTitles: Record<string, string>; warnings: Record<string, string[]>;
  manualUrl: string; manualTitle: string; manualAdding: boolean; exact?: boolean;
  mediaType?: MediaType;
  galgameFilters?: GalgameResourceFilters;
  totalCount?: number;
  work?: string;
}>();
const emit = defineEmits<{
  search: []; enable: [config: SourceConfig]; add: [resource: ResourceItem]; batch: []; toggle: [id: string]; toggleAll: [];
  "update:source": [value: string]; "update:keyword": [value: string]; "update:filter": [value: string]; "update:protocol": [value: string];
  "update:manualUrl": [value: string]; "update:manualTitle": [value: string]; manual: [];
  "update:galgameFilters": [value: GalgameResourceFilters];
  "update:work": [value: string];
}>();
const effectiveGalgameFilters = computed(() => props.galgameFilters ?? emptyGalgameResourceFilters());
const hasGalgameFilters = computed(() => props.mediaType === "visual_novel" && (effectiveGalgameFilters.value.chinese || effectiveGalgameFilters.value.windows || effectiveGalgameFilters.value.game || effectiveGalgameFilters.value.acquisition !== "all"));
function updateGalgameFilter<K extends keyof GalgameResourceFilters>(key: K, value: GalgameResourceFilters[K]): void {
  emit("update:galgameFilters", { ...effectiveGalgameFilters.value, [key]: value });
}
function clearFilters(): void {
  emit("update:filter", ""); emit("update:protocol", "all"); emit("update:galgameFilters", emptyGalgameResourceFilters());
}
const enabledOptions = computed(() => props.options.filter((option) => option.config.enabled));
const disabledOptions = computed(() => props.options.filter((option) => !option.config.enabled));
const resultPage = ref(1);
const selectedWork = computed({ get: () => props.work ?? "all", set: (value: string) => emit("update:work", value) });
const pageSize = 40;
const workOptions = computed(() => {
  const workMap = new Map<string, { key: string; label: string; count: number }>();
  for (const item of props.resources) {
    const key = `${item.sourceId}:${item.sourceItemId}`;
    const edition = props.mediaType !== "visual_novel" && typeof item.metadata.editionLabel === "string" ? item.metadata.editionLabel : "";
    const title = props.groupTitles[item.id] || String(item.metadata.seriesTitle || item.title);
    const current = workMap.get(key) ?? { key, label: title + (edition ? ` · ${edition}` : ` · ${item.sourceItemId}`), count: 0 };
    current.count++; workMap.set(key, current);
  }
  return [...workMap.values()];
});
const selectedResources = computed(() => selectedWork.value === "all" ? props.resources : props.resources.filter((item) => `${item.sourceId}:${item.sourceItemId}` === selectedWork.value));
function androidUnsupported(resource: ResourceItem): boolean {
  return isAndroidRuntime() && (resource.protocol !== "http" || ["public_video", "jmcomic_cbz"].includes(String(resource.metadata.downloadMode)));
}
const downloadableResources = computed(() => selectedResources.value.filter((resource) => resource.metadata.downloadMode !== "external_link" && !androidUnsupported(resource)));
const pageCount = computed(() => Math.max(1, Math.ceil(selectedResources.value.length / pageSize)));
watch(() => [props.source, props.filter, props.protocol, props.resources.length, props.galgameFilters], () => { resultPage.value = 1; });
watch(selectedWork, () => { resultPage.value = 1; });
watch(workOptions, () => { if (!workOptions.value.some((item) => item.key === selectedWork.value)) selectedWork.value = "all"; });
const groups = computed(() => {
  const grouped = new Map<string, { title: string; sourceName: string; resources: ResourceItem[]; warnings: string[] }>();
  for (const resource of selectedResources.value.slice((resultPage.value - 1) * pageSize, resultPage.value * pageSize)) {
    const edition = props.mediaType !== "visual_novel" && typeof resource.metadata.editionLabel === "string" ? resource.metadata.editionLabel : "";
    const baseTitle = props.groupTitles[resource.id] || String(resource.metadata.seriesTitle || "");
    const title = baseTitle + (edition ? ` · ${edition}` : "");
    const sourceName = props.sourceNames[resource.id] || resource.sourceId;
    const key = `${resource.sourceId}:${resource.sourceItemId}`;
    const group = grouped.get(key) ?? { title: title || sourceName, sourceName, resources: [], warnings: [] };
    group.resources.push(resource);
    group.warnings = [...new Set([...group.warnings, ...(props.warnings[resource.id] ?? [])])];
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([key, group]) => ({ ...group, key }));
});
const selectedCount = computed(() => downloadableResources.value.filter((resource) => props.selected.includes(resource.id)).length);
const allSelected = computed(() => downloadableResources.value.length > 0 && selectedCount.value === downloadableResources.value.length);
function actionLabel(resource: ResourceItem): string {
  if (androidUnsupported(resource)) return "需电脑版";
  if (resource.metadata.downloadMode === "external_link") return typeof resource.metadata.actionLabel === "string" ? resource.metadata.actionLabel : "打开来源";
  if (resource.metadata.downloadMode === "public_video") return "下载视频";
  if (resource.metadata.downloadMode === "novel_txt") return resource.metadata.contentScope === "free-chapters-only" ? "下载免费章节" : "下载本卷";
  if (["manga_cbz", "jmcomic_cbz"].includes(String(resource.metadata.downloadMode))) return "下载章节";
  return resource.protocol === "magnet" ? "磁力下载" : resource.protocol === "torrent" ? "种子下载" : "直接下载";
}
function resourceChips(resource: ResourceItem): string[] {
  const language = ({ zh: "中文", "zh-hk": "繁体中文", "zh-tw": "繁体中文", "zh-Hant": "繁体中文", en: "英文", ja: "日文" } as Record<string, string>)[resource.language ?? ""] || resource.language;
  const pages = resource.metadata.pages;
  const label = typeof resource.metadata.resourceLabel === "string" ? resource.metadata.resourceLabel.trim() : undefined;
  const text = (key: string) => typeof resource.metadata[key] === "string" ? String(resource.metadata[key]).trim() : undefined;
  const list = (key: string) => Array.isArray(resource.metadata[key]) ? resource.metadata[key].filter((value): value is string => typeof value === "string").join(" / ") : undefined;
  return [...new Set([label, text("resourceTypeLabel"), ...(props.mediaType === "visual_novel" ? [text("editionLabel"), text("translationLabel"), text("formLabel")] : []), resource.resolution, list("languageLabels") || language, list("platformLabels") || text("platform"), list("runtimeLabels"), resource.format, typeof pages === "number" && pages > 0 ? `${pages} 页` : undefined, resource.sizeBytes ? formatBytes(resource.sizeBytes) : text("size"),
    list("providerNames"),
    resource.metadata.downloadMode === "novel_txt" && typeof resource.metadata.chapterCount === "number" ? `${resource.metadata.chapterCount} 章正文` : undefined,
    resource.metadata.downloadMode === "novel_txt" && typeof resource.metadata.restrictedChapterCount === "number" && resource.metadata.restrictedChapterCount > 0 ? `${resource.metadata.restrictedChapterCount} 章受限，不包含` : undefined,
    resource.metadata.downloadMode === "novel_txt" ? text("contentNote") : undefined,
    resource.protocol === "magnet" ? "Magnet" : resource.protocol === "torrent" ? "Torrent" : undefined].filter((item): item is string => Boolean(item)))];
}
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}
function sourceFiles(resource: ResourceItem): Array<{ name: string; sha256?: string }> {
  if (props.mediaType !== "visual_novel" || !Array.isArray(resource.metadata.files)) return [];
  return resource.metadata.files.slice(0, 100).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const file = value as Record<string, unknown>;
    if (typeof file.fileName !== "string" || !file.fileName.trim()) return [];
    return [{ name: file.fileName.trim(), ...(typeof file.sha256 === "string" && /^[a-f\d]{64}$/i.test(file.sha256) ? { sha256: file.sha256.toLowerCase() } : {}) }];
  });
}
</script>

<template>
  <section id="subject-resources" class="subject-resources-panel" aria-label="作品资源" :data-total="resources.length">
    <header><div><span class="section-kicker">RESOURCE</span><h2>{{ exact ? '这部作品的资源' : '查找资源' }}</h2><p>{{ mediaType === 'visual_novel' ? '中文 Windows 本体优先。文件直链使用内置下载器；官网、商店和分享页在浏览器打开。' : exact ? '已选择来源中的准确作品，下面只读取它的章节或文件。' : '选择来源检索，先核对作品、季数与语言，再加入下载。' }}</p></div><RouterLink :to="{ path: '/resources', query: { type: mediaType, q: keyword.trim() || undefined } }">{{ exact && mediaType === 'visual_novel' ? '跨来源寻找这个作品 ↗' : '直接在来源中选作品 ↗' }}</RouterLink></header>
    <p v-if="exact && mediaType === 'visual_novel'" class="resource-exact-note">准确来源作品 · {{ options[0]?.config.name || '当前来源' }}<span>其他来源需重新确认作品和版本。</span></p>
    <form v-if="enabledOptions.length" class="resource-search-bar" @submit.prevent="$emit('search')"><input :value="keyword" :disabled="loading || exact" aria-label="资源检索词" placeholder="作品名、原名或别名" @input="$emit('update:keyword', ($event.target as HTMLInputElement).value)" /><select :value="source" :disabled="loading || exact" aria-label="资源来源" @change="$emit('update:source', ($event.target as HTMLSelectElement).value)"><option value="all">全部已启用来源</option><option v-for="option in enabledOptions" :key="option.config.id" :value="option.providerId">{{ option.config.name }}</option></select><button :disabled="loading" type="submit">{{ loading ? '检索中…' : queried ? '重新检索' : '搜索资源' }}</button></form>
    <div v-if="disabledOptions.length && (!enabledOptions.length || !resources.length)" class="source-suggestions"><h3>{{ enabledOptions.length ? '也可以试试这些来源' : '选择一个来源开始' }}</h3><p>点击会启用所选来源并查询当前作品。</p><div class="source-suggestion-grid"><article v-for="option in disabledOptions" :key="option.config.id"><div><strong>{{ option.config.name }}</strong><small>{{ option.description }}</small></div><button :disabled="loading" type="button" @click="$emit('enable', option.config)">启用并搜索 →</button></article></div></div>
    <p v-if="!options.length" class="resource-panel-note">暂没有适用于当前类型的来源配置。可以使用手动链接，或到 <RouterLink to="/sources">来源管理</RouterLink> 添加自己的 RSS。</p>
    <p v-if="error" class="resource-panel-error" role="alert">{{ error }}</p><p v-if="notice" class="resource-panel-note" role="status">{{ notice }}</p>
    <div v-if="loading" class="resource-search-progress" role="status"><span></span><div><strong>正在读取来源…</strong><small>检索与章节列表按来源返回，网络较慢时可以保留本页等待。</small></div></div>
    <div v-if="mediaType === 'visual_novel' && (queried || resources.length || totalCount)" class="galgame-resource-filters" aria-label="Galgame 资源条件">
      <div class="galgame-filter-switches"><button type="button" :aria-pressed="effectiveGalgameFilters.chinese" @click="updateGalgameFilter('chinese', !effectiveGalgameFilters.chinese)">中文</button><button type="button" :aria-pressed="effectiveGalgameFilters.windows" @click="updateGalgameFilter('windows', !effectiveGalgameFilters.windows)">Windows</button><button type="button" :aria-pressed="effectiveGalgameFilters.game" @click="updateGalgameFilter('game', !effectiveGalgameFilters.game)">游戏本体</button></div>
      <label><span>获取方式</span><select :value="effectiveGalgameFilters.acquisition" aria-label="Galgame 获取方式" @change="updateGalgameFilter('acquisition', ($event.target as HTMLSelectElement).value as GalgameResourceFilters['acquisition'])"><option value="all">全部获取方式</option><option value="direct">文件直链</option><option value="external">站外页面</option></select></label>
      <small>按来源标明的语言、平台和版本筛选。</small>
    </div>
    <div v-if="resources.length || filter || protocol !== 'all' || hasGalgameFilters" class="resource-result-tools"><input :value="filter" type="search" aria-label="筛选资源" :placeholder="mediaType === 'visual_novel' ? '搜索版本、网盘… 空格可组合多个词' : '筛选章节、字幕、清晰度…'" @input="$emit('update:filter', ($event.target as HTMLInputElement).value)" /><select :value="protocol" aria-label="资源协议" @change="$emit('update:protocol', ($event.target as HTMLSelectElement).value)"><option value="all">全部格式</option><option value="http">HTTP / 章节 / 来源入口</option><option value="magnet">Magnet</option><option value="torrent">Torrent</option></select><button v-if="filter || protocol !== 'all' || hasGalgameFilters" class="resource-clear-filters" type="button" @click="clearFilters">清除筛选</button><label v-if="downloadableResources.length"><input type="checkbox" :checked="allSelected" @change="$emit('toggleAll')" />全选</label><button v-if="downloadableResources.length" :disabled="!!adding || batchAdding || !selectedCount" type="button" @click="$emit('batch')">{{ batchAdding ? '正在添加…' : `下载所选 ${selectedCount || ''}` }}</button></div>
    <label v-if="workOptions.length > 1" class="resource-edition-choice"><span>作品 / 改编版本</span><select v-model="selectedWork" :disabled="batchAdding || !!adding" aria-label="作品改编版本"><option value="all">查看全部 {{ workOptions.length }} 个版本 / 作品</option><option v-for="work in workOptions" :key="work.key" :value="work.key">{{ work.label }} · {{ work.count }} 条资源</option></select></label>
    <div v-if="resources.length" class="resource-pagination"><span>共 {{ selectedResources.length }} 条<template v-if="totalCount !== undefined && totalCount > resources.length"> · 已筛选，总计 {{ totalCount }} 条</template><template v-if="pageCount > 1"> · 第 {{ resultPage }} / {{ pageCount }} 页</template></span><div v-if="pageCount > 1"><button :disabled="resultPage <= 1" @click="resultPage--">上一页</button><button :disabled="resultPage >= pageCount" @click="resultPage++">下一页</button></div></div>
    <section v-for="group in groups" :key="group.key" class="resource-title-group"><div class="resource-group-heading"><h3>{{ group.title }}</h3><span>{{ group.sourceName }}</span></div><p v-for="warning in group.warnings" :key="warning" class="resource-match-warning">{{ warning }}</p><article v-for="resource in group.resources" :key="resource.id" class="subject-resource-item"><label v-if="resource.metadata.downloadMode !== 'external_link' && !androidUnsupported(resource)"><input type="checkbox" :checked="selected.includes(resource.id)" :aria-label="'选择 ' + resource.title" @change="$emit('toggle', resource.id)" /></label><div><strong>{{ resource.title }}</strong><div class="resource-meta-chips"><span v-for="chip in resourceChips(resource)" :key="chip">{{ chip }}</span></div><details v-if="sourceFiles(resource).length" class="resource-source-files"><summary>原站文件与校验信息</summary><p>以下为来源记录，不代表已校验本地下载文件。</p><ul><li v-for="(file, index) in sourceFiles(resource)" :key="index"><span>{{ file.name }}</span><code v-if="file.sha256">SHA-256 {{ file.sha256 }}</code><small v-else>来源未提供 SHA-256</small></li></ul><small v-if="Number(resource.metadata.fileCount) > 100">仅展开前 100 项；完整文件目录请查看原站。</small></details></div><button :disabled="!!adding || batchAdding || androidUnsupported(resource)" type="button" @click="$emit('add', resource)">{{ adding === resource.id ? '处理中…' : actionLabel(resource) }} <span>{{ resource.metadata.downloadMode === 'external_link' ? '↗' : '↓' }}</span></button></article></section>
    <div v-if="(queried || totalCount) && !loading && !resources.length && !error" class="resource-no-match"><strong>{{ filter || protocol !== 'all' || hasGalgameFilters ? '没有符合这些条件的资源' : '这次没有找到匹配资源' }}</strong><p>{{ filter || protocol !== 'all' || hasGalgameFilters ? '试试减少条件；未标明语言或平台的条目不会被认定为中文 Windows 版本。' : '可以缩短检索词或换个来源。先从来源里选择准确作品，再查看对应章节、文件或发行入口。' }}</p><RouterLink :to="{ path: '/resources', query: { type: mediaType, q: keyword } }">去来源中选择作品 →</RouterLink></div>
    <details class="resource-manual-entry"><summary>我有资源链接，手动添加</summary><p>{{ android ? '安卓端支持 HTTP/HTTPS 文件直链，应用会关联当前作品；磁力和种子请使用电脑版。' : '支持 HTTP 文件、Magnet 和 .torrent 链接，应用会关联当前作品。' }}</p><form @submit.prevent="$emit('manual')"><input :value="manualUrl" aria-label="手动资源链接" placeholder="粘贴资源链接" required @input="$emit('update:manualUrl', ($event.target as HTMLInputElement).value)" /><input :value="manualTitle" aria-label="手动资源名称" placeholder="资源名称（可选）" @input="$emit('update:manualTitle', ($event.target as HTMLInputElement).value)" /><button :disabled="manualAdding || !manualUrl.trim()" type="submit">{{ manualAdding ? '添加中…' : '加入下载' }}</button></form></details>
  </section>
</template>

<style scoped>
.resource-source-files{margin-top:10px;font-size:10px;color:#9d87ad}.resource-source-files summary{cursor:pointer;color:#9675ad}.resource-source-files p{line-height:1.8;color:#aa99b4}.resource-source-files ul{padding-left:16px;margin-bottom:4px}.resource-source-files li{padding:5px 0;overflow-wrap:anywhere}.resource-source-files code{display:block;margin-top:5px;font-size:9px;line-height:1.7;color:#9983a7;user-select:text}.resource-source-files small{font-size:9px;color:#b2a1bd}
.resource-exact-note{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px;color:#846397;font-size:11px}.resource-exact-note span{color:#a393af}.galgame-resource-filters{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:16px 0 0}.galgame-filter-switches{display:flex;gap:7px}.galgame-filter-switches button{border:1px solid #e5daee;background:#fff;border-radius:7px;padding:8px 13px;font-size:11px;color:#9678a8;cursor:pointer}.galgame-filter-switches button[aria-pressed="true"]{background:#eee5f8;border-color:#ba9fce;color:#6f468f}.galgame-resource-filters>label{display:flex;align-items:center;gap:8px;color:#9c84ab;font-size:10px}.galgame-resource-filters select{border:1px solid #e4d9ec;border-radius:7px;background:#fcfaff;padding:8px;color:#83639a;font-size:11px}.galgame-resource-filters>small{color:#a89ab2;font-size:10px}.resource-result-tools>.resource-clear-filters{background:transparent;color:#9470ad;padding-inline:5px}
.resource-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:17px;color:#9a83a8;font-size:11px}.resource-pagination>div{display:flex;gap:7px}.resource-pagination button{border:1px solid #e9ddef;background:#fff;border-radius:6px;padding:6px 10px;color:#9876ab;font-size:10px}.subject-resource-item strong{color:#6e5a7e!important;font-size:12px!important}.subject-resource-item>button{color:#9873ae!important;font-size:11px!important}
.resource-edition-choice{display:grid;gap:7px;margin-top:18px;color:#9277a3;font-size:11px}.resource-edition-choice select{width:100%;border:1px solid #dfd2e8;border-radius:8px;padding:11px;background:#faf6fd;color:#775a8c;font-size:12px}
.subject-resources-panel{scroll-margin-top:25px;padding:28px;border:1px solid #eae3ef;background:#fff;border-radius:15px}.subject-resources-panel>header{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:22px}.section-kicker{font-size:9px;letter-spacing:2px;color:#baa9c7}.subject-resources-panel h2{font-size:19px;color:#60496f;margin:7px 0 6px;font-weight:650}.subject-resources-panel>header p{font-size:11px;color:#b0a2b9;line-height:1.8}.subject-resources-panel>header>a{font-size:11px;white-space:nowrap;text-decoration:none;color:#b19ac2}.resource-search-bar{display:grid;grid-template-columns:1.5fr 1fr auto;gap:9px}.resource-search-bar input,.resource-search-bar select,.resource-result-tools input,.resource-result-tools select,.resource-manual-entry input{font-size:11px;border:1px solid #e9e1ef;background:#fcfbfd;color:#94809f;border-radius:8px;padding:11px 12px;box-shadow:none}.resource-search-bar button{border:0;background:#9d87c2;border-radius:8px;padding:10px 21px;color:#fff;font-size:11px;white-space:nowrap}.source-suggestions{margin-top:21px}.source-suggestions>h3{font-size:13px;color:#967ca8;margin-bottom:6px}.source-suggestions>p{font-size:10px;color:#b7a8c1}.source-suggestion-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:9px;margin-top:12px}.source-suggestion-grid article{border:1px solid #eee7f3;border-radius:10px;padding:13px 15px;background:#fcfafd;display:flex;align-items:center;gap:15px}.source-suggestion-grid article>div{flex:1;min-width:0}.source-suggestion-grid strong{display:block;font-size:11px;color:#8d749d;font-weight:600}.source-suggestion-grid small{display:block;line-height:1.7;color:#b4a5be;font-size:9px;margin-top:5px}.source-suggestion-grid button{white-space:nowrap;color:#aa8ebf;background:#f1eaf7;border:0;border-radius:6px;padding:8px;font-size:9px}.resource-panel-note,.resource-panel-error{font-size:11px;line-height:1.9;margin-top:16px;white-space:pre-wrap;color:#a796b3}.resource-panel-error{color:#c3819b}.resource-panel-note a{color:#ac8ebe}.resource-search-progress{display:flex;align-items:center;gap:12px;padding:24px 0;color:#b29dc0}.resource-search-progress>span{width:22px;height:22px;border:2px solid #eee7f4;border-top-color:#ba9dce;border-radius:50%;animation:resource-spin .8s linear infinite}.resource-search-progress strong{display:block;font-size:11px;font-weight:550}.resource-search-progress small{display:block;font-size:9px;color:#c2b4cb;margin-top:5px}.resource-result-tools{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:22px;padding-bottom:13px;border-bottom:1px solid #f0ebf3}.resource-result-tools>input{flex:1;min-width:180px}.resource-result-tools>select{width:auto}.resource-result-tools>label{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:10px;color:#b8a9c1;margin:0 3px}.resource-result-tools>label input,.subject-resource-item>label input{width:auto;accent-color:#b199c8}.resource-result-tools>button{border:0;background:#f3ecf8;color:#a88bbb;font-size:10px;padding:10px 12px;border-radius:7px}.resource-title-group{margin-top:20px}.resource-group-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:7px}.resource-group-heading h3{font-size:13px;color:#8c719e;line-height:1.6}.resource-group-heading>span{font-size:9px;color:#bdadc7;white-space:nowrap}.resource-match-warning{font-size:10px;line-height:1.8;color:#c29890;padding:7px 10px;background:#fff8f4;border-radius:6px;margin:7px 0}.subject-resource-item{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #f3eef6}.subject-resource-item>div{min-width:0;flex:1}.subject-resource-item strong{display:block;color:#9a88a6;font-size:11px;font-weight:500;overflow-wrap:anywhere;line-height:1.75}.resource-meta-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.resource-meta-chips span{font-size:8px;background:#f6f2f9;color:#b5a0c4;padding:3px 6px;border-radius:4px}.subject-resource-item>button{border:1px solid #eadef1;background:white;border-radius:7px;padding:8px 12px;color:#ad94bf;font-size:10px;white-space:nowrap}.subject-resource-item>button span{margin-left:13px}.resource-no-match{text-align:center;padding:34px 15px}.resource-no-match strong{font-size:13px;color:#a187b2;font-weight:550}.resource-no-match p{font-size:10px;line-height:1.9;color:#b8a8c2;max-width:450px;margin:10px auto}.resource-no-match>a{display:inline-block;margin-top:7px;font-size:10px;color:#b18fc7;text-decoration:none}.resource-manual-entry{border-top:1px solid #eee7f2;margin-top:25px;padding-top:18px}.resource-manual-entry summary{cursor:pointer;font-size:11px;color:#b19cbd}.resource-manual-entry p{font-size:10px;line-height:1.8;color:#c0afca;margin:13px 0 10px}.resource-manual-entry form{display:grid;grid-template-columns:1.7fr 1fr auto;gap:8px}.resource-manual-entry button{border:0;border-radius:7px;background:#f0e8f7;color:#ac90bf;font-size:10px;padding:10px 15px}button:disabled{opacity:.45;cursor:not-allowed}@keyframes resource-spin{to{transform:rotate(360deg)}}@media(max-width:700px){.subject-resources-panel{padding:20px}.subject-resources-panel>header{flex-direction:column;align-items:flex-start;gap:10px}.resource-search-bar{grid-template-columns:1fr auto}.resource-search-bar>input{grid-column:1/-1}.resource-manual-entry form{grid-template-columns:1fr}.resource-group-heading{flex-wrap:wrap;gap:4px}.subject-resource-item{gap:9px}.subject-resource-item>button{padding:8px}.subject-resource-item>button span{margin-left:5px}.source-suggestion-grid{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.resource-search-progress>span{animation:none}}
</style>
