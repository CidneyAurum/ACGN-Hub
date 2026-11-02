<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import MediaPoster from "@/components/MediaPoster.vue";
import SourceGuide from "@/components/SourceGuide.vue";
import { searchSourceCandidates, type SourceCandidate, type SourceFailure } from "@/application/resource-discovery";
import { filterSourcesForPlatform, getSourcePriority, sourcePlatformUnavailableReason, sourceSupportsType } from "@/infrastructure/sources/source-catalog";
import { useSourceConfigStore } from "@/stores/source-config";
import { useMediaLibraryStore } from "@/stores/media-library";
import { useSearchSessionStore } from "@/stores/search-session";
import type { Media, MediaType } from "@/domain/media";
import { isAndroidRuntime, isTauriRuntime } from "@/shared/runtime";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DEFAULT_RESOURCE_SOURCE_CONFIGS } from "@/infrastructure/sources/default-sources";

const route = useRoute();
const router = useRouter();
const sources = useSourceConfigStore();
const library = useMediaLibraryStore();
const session = useSearchSessionStore();
const type = ref<MediaType>("anime");
const keyword = ref("");
const selectedSourceId = ref("");
const loading = ref(false);
const selecting = ref("");
const searched = ref(false);
const error = ref("");
const candidates = ref<SourceCandidate[]>([]);
const failures = ref<SourceFailure[]>([]);
const searchedSourceNames = ref<string[]>([]);
const completedSourceCount = ref(0);
const searchCancelled = ref(false);
let requestGeneration = 0;
let selectionToken = 0;
let sourceInitializationFinished = false;
interface SearchContext { type: MediaType; keyword: string; sourceId: string }
const resultContext = ref<SearchContext>();
const types: Array<{ value: MediaType; label: string }> = [
  { value: "anime", label: "动画" }, { value: "manga", label: "漫画" },
  { value: "novel", label: "小说" }, { value: "visual_novel", label: "Galgame" },
];
const categorySources = computed(() => [...sources.configs, ...DEFAULT_RESOURCE_SOURCE_CONFIGS.filter((preset) =>
  (preset.type === "vndb_release" || sourceSupportsType(preset, "visual_novel") && preset.type !== "rss" || preset.type === "lnovel") &&
  !sources.configs.some((config) => config.id === preset.id || config.type === preset.type && config.url.replace(/\/+$/, "") === preset.url.replace(/\/+$/, "")))].filter((config) => sourceSupportsType(config, type.value))
  .sort((left, right) => Number(right.enabled) - Number(left.enabled) || getSourcePriority(left, type.value) - getSourcePriority(right, type.value)));
const compatibleSources = computed(() => filterSourcesForPlatform(categorySources.value));
const unavailableSources = computed(() => categorySources.value.filter((source) => sourcePlatformUnavailableReason(source)));
const selectedSource = computed(() => compatibleSources.value.find((source) => source.id === selectedSourceId.value));
const enabledSources = computed(() => compatibleSources.value.filter((source) => source.enabled));
const searchingAll = computed(() => selectedSourceId.value === "all");
const publicSearchUrl = computed(() => `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword.value.trim())}`);

async function openPublicSearch(): Promise<void> {
  try {
    if (isTauriRuntime()) await openUrl(publicSearchUrl.value);
    else window.open(publicSearchUrl.value, "_blank", "noopener,noreferrer");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "无法打开B站搜索页面"; }
}

async function openSourceWebsite(): Promise<void> {
  const source = selectedSource.value;
  if (!source) return;
  try {
    const target = new URL(source.url);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) throw new Error("来源网站地址无效");
    if (isTauriRuntime()) await openUrl(target.toString());
    else window.open(target.toString(), "_blank", "noopener,noreferrer");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "无法打开来源网站"; }
}

onMounted(async () => {
  applyRoute();
  await sources.initialize();
  sourceInitializationFinished = true;
  chooseDefaultSource();
});
onUnmounted(() => { requestGeneration += 1; });
function invalidateSearch(): void {
  selectionToken += 1;
  requestGeneration += 1; loading.value = false; searched.value = false;
  candidates.value = []; failures.value = []; error.value = ""; selecting.value = ""; searchedSourceNames.value = [];
  completedSourceCount.value = 0; searchCancelled.value = false;
  resultContext.value = undefined;
}
function cancelSearch(): void {
  requestGeneration += 1;
  loading.value = false;
  searchCancelled.value = true;
}
watch(type, () => { invalidateSearch(); chooseDefaultSource(); });
watch(selectedSourceId, invalidateSearch);
watch(keyword, invalidateSearch, { flush: "sync" });
watch(() => [route.query.q, route.query.type, route.query.provider, route.query.sourceId], applyRoute);
function applyRoute(): void {
  const requestedType = types.find((item) => item.value === route.query.type)?.value ?? "anime";
  const requestedKeyword = typeof route.query.q === "string" ? route.query.q : "";
  if (type.value !== requestedType || keyword.value !== requestedKeyword) invalidateSearch();
  type.value = requestedType;
  keyword.value = requestedKeyword;
  if (sourceInitializationFinished) chooseDefaultSource();
}
function chooseType(value: MediaType): void {
  if (value === type.value) return;
  type.value = value;
  void router.replace({ query: { ...route.query, type: value, q: keyword.value.trim() || undefined, provider: undefined, sourceId: undefined } });
}

function candidateDetails(choice: SourceCandidate): string[] {
  const raw = choice.candidate.raw;
  if (!raw) return [];
  const authors = Array.isArray(raw.authors) ? raw.authors.filter((value): value is string => typeof value === "string") : [];
  return [authors.length ? `作者：${authors.join(' / ')}` : undefined,
    typeof raw.editionLabel === "string" ? raw.editionLabel : undefined,
    typeof raw.status === "string" ? raw.status : undefined,
    typeof raw.latestChapter === "string" ? `最新：${raw.latestChapter}` : undefined,
    typeof raw.chapterCount === "number" ? `${raw.chapterCount} 条章节` : undefined]
    .filter((value): value is string => Boolean(value));
}
async function rememberRoute(): Promise<void> {
  const provider = selectedSource.value?.type;
  const sourceId = searchingAll.value ? "all" : selectedSource.value?.id;
  await router.replace({ query: { ...route.query, type: type.value, q: keyword.value.trim(), provider, sourceId } });
}
watch(() => sources.configs, () => {
  if (sourceInitializationFinished) chooseDefaultSource();
});
function chooseDefaultSource(): void {
  const requestedSourceId = typeof route.query.sourceId === "string" ? route.query.sourceId : undefined;
  if (requestedSourceId === "all") { selectedSourceId.value = "all"; return; }
  const exactSource = requestedSourceId ? compatibleSources.value.find((source) => source.id === requestedSourceId) : undefined;
  if (exactSource) { selectedSourceId.value = exactSource.id; return; }
  // Older URLs identify only the adapter type. Exact IDs take precedence, while
  // removed/incompatible IDs fall back solely within the active media category.
  const requestedProvider = typeof route.query.provider === "string" ? route.query.provider : undefined;
  const requestedSource = requestedProvider ? compatibleSources.value.find((source) => source.type === requestedProvider) : undefined;
  if (requestedSource) { selectedSourceId.value = requestedSource.id; return; }
  if (route.query.sourceId !== undefined || route.query.provider !== undefined || !compatibleSources.value.some((source) => source.id === selectedSourceId.value)) selectedSourceId.value = type.value === "visual_novel" ? "all" : compatibleSources.value[0]?.id ?? "";
}

async function search(): Promise<void> {
  if (loading.value || selecting.value) return;
  error.value = "";
  if (!keyword.value.trim()) { error.value = "输入作品名称，也可以输入此来源支持的作品 ID 或链接。"; return; }
  const source = selectedSource.value;
  const selectedId = selectedSourceId.value;
  const submitted: SearchContext = { type: type.value, keyword: keyword.value.trim(), sourceId: selectedId };
  const allSources = searchingAll.value;
  if (!allSources && !source) { error.value = "先选择一个适用来源，或到来源管理添加来源。"; return; }
  if (allSources && !enabledSources.value.length) { error.value = "还没有已启用的适用来源。请先选择一个来源，点击“启用此来源并搜索”。"; return; }
  if (isAndroidRuntime() && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  // Persist the selection before capturing the generation: navigation can reuse
  // this component and must not let a previous provider populate the new view.
  await rememberRoute();
  if (!matchesSearchContext(submitted)) return;
  const requestedType = submitted.type;
  const requestedKeyword = submitted.keyword;
  const generation = ++requestGeneration;
  let resultsLocated = false;
  loading.value = true; searched.value = true; candidates.value = []; failures.value = [];
  resultContext.value = submitted;
  completedSourceCount.value = 0; searchCancelled.value = false;
  try {
    let enabled = source;
    if (!allSources && source && !source.enabled) {
      enabled = { ...source, enabled: true, updatedAt: new Date().toISOString() };
      await sources.save(enabled);
    }
    if (generation !== requestGeneration) return;
    const searchSources = allSources ? [...enabledSources.value] : enabled ? [enabled] : [];
    searchedSourceNames.value = searchSources.map((config) => config.name);
    const result = await searchSourceCandidates({ keyword: requestedKeyword, mediaType: requestedType, sources: searchSources,
      onSourceResult: (progress) => {
        if (generation !== requestGeneration) return;
        completedSourceCount.value = progress.completed;
        candidates.value = [...candidates.value, ...progress.candidates].sort((left, right) => right.score - left.score);
        if (progress.failure) failures.value = [...failures.value, progress.failure];
        if (isAndroidRuntime() && candidates.value.length && !resultsLocated) {
          resultsLocated = true;
          void nextTick(() => {
            if (generation === requestGeneration) document.querySelector<HTMLElement>(".resource-result-heading")?.scrollIntoView({ block: "start", behavior: "smooth" });
          });
        }
      },
    });
    if (generation !== requestGeneration) return;
    candidates.value = [...result.candidates].sort((left, right) => right.score - left.score); failures.value = result.failures;
  } catch (cause) { if (generation === requestGeneration) error.value = cause instanceof Error ? cause.message : "来源暂时不可用，请换一个来源重试"; }
  finally { if (generation === requestGeneration) loading.value = false; }
}

async function selectWork(choice: SourceCandidate): Promise<void> {
  const context = resultContext.value;
  if (selecting.value || !context || !matchesSearchContext(context) || !candidates.value.some((current) => current === choice)) return;
  const { candidate, config, provider } = choice;
  const generation = requestGeneration;
  const selectedType = context.type;
  const selectedKeyword = context.keyword;
  const ownedSelection = ++selectionToken;
  selecting.value = candidateKey(choice);
  try {
    const rawDescription = candidate.raw?.description;
    const media: Media = {
      id: `source:${config.id}:${candidate.sourceItemId}`, type: selectedType, title: candidate.title,
      aliases: [...new Set([selectedKeyword, candidate.title, ...(candidate.aliases ?? [])].filter(Boolean))],
      externalIds: [], metadata: { sourceConfigId: config.id, sourceItemId: candidate.sourceItemId,
        ...(candidate.raw?.authors ? { sourceAuthors: candidate.raw.authors } : {}),
        ...(candidate.raw?.editionLabel ? { sourceEdition: candidate.raw.editionLabel } : {}),
        ...(candidate.raw?.chapterCount ? { sourceChapterCount: candidate.raw.chapterCount } : {}),
        sourceProviderId: provider.id, sourceType: config.type, sourceTitle: candidate.title, sourceQuery: selectedKeyword, sourceMatchWarnings: choice.warnings },
      ...(candidate.coverUrl ? { coverUrl: candidate.coverUrl } : {}),
      ...(candidate.releaseYear ? { releaseYear: candidate.releaseYear } : {}),
      ...(typeof rawDescription === "string" ? { description: rawDescription } : {}),
    };
    session.remember([{ media, score: choice.score, reason: "exact" }]);
    try { await library.save(media); }
    catch (cause) {
      media.metadata.sourceSaveError = cause instanceof Error ? cause.message : "作品尚未保存，当前会话仍可查看来源章节";
      session.remember([{ media, score: choice.score, reason: "exact" }]);
    }
    if (generation !== requestGeneration || !matchesSearchContext(context)) return;
    await router.push("/media/" + encodeURIComponent(media.id));
  } finally {
    if (ownedSelection === selectionToken) selecting.value = "";
  }
}
function matchesSearchContext(context: SearchContext): boolean {
  return context.type === type.value && context.keyword === keyword.value.trim() && context.sourceId === selectedSourceId.value;
}
function candidateKey(choice: SourceCandidate): string { return `${choice.config.id}:${choice.candidate.sourceItemId}`; }
</script>

<template>
  <section class="resource-page-intro">
    <div><p class="resource-kicker">直接去来源找作品</p><h1>找资源，先选对作品。</h1><p>输入熟悉的名字，在来源里确认原作，再查看章节、分卷或下载链接。</p></div>
    <RouterLink class="ghost-button" to="/sources">管理我的来源</RouterLink>
  </section>
  <section class="resource-search-panel">
    <div class="resource-type-tabs" aria-label="资源类型"><button v-for="item in types" :key="item.value" :class="{ active: type === item.value }" type="button" @click="chooseType(item.value)">{{ item.label }}</button></div>
    <form @submit.prevent="search">
      <label class="resource-keyword"><span>作品名称 / 来源作品 ID</span><input v-model="keyword" type="search" placeholder="例如：葬送的芙莉莲、我想成为影之强者" autocomplete="off" /></label>
      <label class="resource-source"><span>检索来源</span><select v-model="selectedSourceId"><option value="all">全部已启用来源（{{ enabledSources.length }}）</option><option v-if="!compatibleSources.length" value="">暂无适用来源</option><option v-for="source in compatibleSources" :key="source.id" :value="source.id">{{ source.name }}{{ source.enabled ? '' : ' · 未启用' }}</option></select></label>
      <button class="primary-button" :disabled="loading || sources.loading" type="submit">{{ loading ? '正在检索…' : selectedSource && !selectedSource.enabled ? '启用此来源并搜索' : '搜索来源' }}</button>
      <button v-if="loading" class="ghost-button" type="button" @click="cancelSearch">停止等待</button>
    </form>
    <SourceGuide v-if="selectedSource" :config="selectedSource" compact />
    <p v-for="source in unavailableSources" :key="source.id" class="resource-source-note">{{ sourcePlatformUnavailableReason(source) }}</p>
    <p v-if="searchingAll && !searched" class="resource-source-note">{{ enabledSources.length ? `将同时查询：${enabledSources.map((source) => source.name).join('、')}。各来源的作品与版本分别保留。` : '当前没有已启用来源。可以在上方选择一个来源，明确启用后检索。' }}</p>
    <p v-if="searchedSourceNames.length" class="resource-search-sources" role="status">{{ loading ? '正在查询' : '本次检索' }}：{{ searchedSourceNames.join('、') }}<span v-if="loading"> · 已返回 {{ completedSourceCount }} / {{ searchedSourceNames.length }}，可先查看已有结果</span><span v-else-if="searchCancelled"> · 已停止等待，保留已返回结果</span><span v-else-if="searchingAll"> · 各来源结果分别确认</span></p>
    <p v-if="selectedSource?.type === 'kungal'" class="resource-source-note">公开检索无需账号。资源条目会打开原站分享页，外链的访问权限与获取方式请在原站确认。<a :href="selectedSource.url" target="_blank" rel="noopener noreferrer" @click.prevent="openSourceWebsite">打开来源网站 ↗</a></p>
    <p v-if="selectedSource?.type === 'public_video'" class="resource-source-note">如遇搜索验证，可在官网找到投稿后复制 BV 号或链接回到此处。<a :href="publicSearchUrl" target="_blank" rel="noopener noreferrer" @click.prevent="openPublicSearch">B站官方搜索 ↗</a></p>
    <p v-if="error || sources.error" class="error-message" role="alert">{{ error || sources.error }}</p>
    <p v-for="failure in failures" :key="failure.config.id" class="error-message" role="alert">{{ failure.config.name }}：{{ failure.message }}</p>
  </section>
  <section v-if="loading && !candidates.length" class="resource-state" role="status"><span class="loading-spinner"></span><h2>正在读取来源目录</h2><p>只查询作品列表；确认作品后才会加载章节。</p></section>
  <section v-else-if="searched && !candidates.length && !failures.length && !error" class="resource-state"><h2>{{ searchingAll ? '已启用来源中没有找到对应作品' : '这个来源没有找到对应作品' }}</h2><p>试试中文系列名、原名或更短的关键词，也可以换一个来源。</p></section>
  <section v-else-if="!searched" class="resource-state"><span class="resource-state-symbol">✦</span><h2>不必先找到元数据条目</h2><p>小说、漫画和动画都可以直接查来源。选择原作，避免把同人、番外或另一季当成目标作品。</p></section>
  <section v-if="candidates.length" aria-label="来源作品候选">
    <div class="resource-result-heading"><h2>确认你要的作品</h2><span>{{ candidates.length }} 个候选 · 选择后加入作品库并查看资源</span></div>
    <div class="resource-work-grid">
      <article v-for="choice in candidates" :key="candidateKey(choice)" class="resource-work-card">
        <div class="resource-work-cover" role="button" tabindex="0" :aria-label="'选择 ' + choice.candidate.title + ' 并查看资源'" @click="!selecting && selectWork(choice)" @keydown.enter.prevent="!selecting && selectWork(choice)" @keydown.space.prevent="!selecting && selectWork(choice)"><MediaPoster :src="choice.candidate.coverUrl" :alt="choice.candidate.title + ' 封面'" /></div>
        <div class="resource-work-content"><span class="resource-work-source">{{ choice.config.name }}</span><h3><button class="resource-title-button" type="button" :disabled="!!selecting" @click="selectWork(choice)">{{ choice.candidate.title }}</button></h3><p v-for="detail in candidateDetails(choice)" :key="detail" class="resource-work-year">{{ detail }}</p><p v-if="choice.candidate.raw?.durationLabel || choice.candidate.raw?.uploader" class="resource-work-year">{{ choice.candidate.raw?.durationLabel }}<span v-if="choice.candidate.raw?.uploader"> · {{ choice.candidate.raw.uploader }}</span></p><p v-if="choice.candidate.releaseYear" class="resource-work-year">{{ choice.candidate.releaseYear }}</p><p v-for="warning in choice.warnings" :key="warning" class="resource-match-warning">{{ warning }}</p><button class="small-button" :disabled="!!selecting" type="button" @click="selectWork(choice)">{{ selecting === candidateKey(choice) ? '正在打开…' : '选择作品并查看资源' }}</button></div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.resource-result-heading{scroll-margin-top:110px}
.resource-search-sources{font-size:11px;line-height:1.9;color:#846698;margin:17px 0 0}.resource-search-sources>span{color:#a18caf}
.resource-page-intro{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:28px}.resource-kicker{font-size:11px;letter-spacing:1.8px;color:#a47db8;margin:0 0 10px}.resource-page-intro h1{font-size:29px;color:#4f3e65;margin:0 0 9px;letter-spacing:-.7px}.resource-page-intro p:last-child{color:#96869f;font-size:13px;margin:0}.resource-search-panel{border:1px solid #ecdfef;border-radius:16px;background:linear-gradient(120deg,#fffafd,#faf8ff);padding:23px 25px;margin-bottom:25px}.resource-type-tabs{display:flex;gap:9px;margin-bottom:22px}.resource-type-tabs button{border:1px solid transparent;background:transparent;border-radius:7px;padding:8px 19px;color:#9c8aa6;cursor:pointer}.resource-type-tabs button.active{background:#ede4f5;color:#8d60aa;border-color:#e3d4ed}.resource-search-panel form{display:flex;align-items:flex-end;gap:13px}.resource-search-panel label{display:flex;flex-direction:column;gap:9px}.resource-search-panel label>span{font-size:11px;color:#8e7c9b}.resource-keyword{flex:1;min-width:0}.resource-source{width:230px}.resource-search-panel input,.resource-search-panel select{width:100%;box-sizing:border-box;background:#fff;border:1px solid #e4dcea;border-radius:8px;padding:12px;font-size:13px;color:#645070}.resource-search-panel .primary-button{white-space:nowrap;min-height:42px}.resource-source-note{font-size:11px;line-height:1.8;color:#a38bae;margin:16px 0 0}.resource-state{padding:60px 20px;text-align:center;color:#ad9cb6}.resource-state h2{font-size:17px;font-weight:500;margin-top:16px;color:#8b739c}.resource-state p{font-size:12px;line-height:1.8}.resource-state-symbol{font-size:38px;color:#d2bbdf}.resource-result-heading{display:flex;align-items:center;justify-content:space-between;margin:28px 0 17px}.resource-result-heading h2{font-size:17px;color:#675073}.resource-result-heading span{font-size:11px;color:#ad99b8}.resource-work-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:17px}.resource-work-card{display:flex;gap:17px;padding:16px;background:#fff;border:1px solid #eee5f1;border-radius:13px}.resource-work-cover{width:95px;height:135px;flex-shrink:0;border-radius:7px;overflow:hidden;background:#f2ebf6}.resource-work-cover :deep(img){width:100%;height:100%;object-fit:cover}.resource-work-content{min-width:0;display:flex;flex-direction:column;align-items:flex-start;flex:1}.resource-work-source{font-size:9px;color:#b095c0}.resource-work-content h3{font-size:14px;line-height:1.6;font-weight:600;color:#685176;margin:8px 0 5px;overflow-wrap:anywhere}.resource-work-year{font-size:11px;color:#b5a6bf;margin:0 0 8px}.resource-match-warning{font-size:10px;line-height:1.6;color:#bb8b69;margin:0 0 8px}.resource-work-content button{margin-top:auto;font-size:11px}.resource-work-content .small-button{border-color:#e6d9ef;color:#996cb1;background:#fcf9ff}@media(max-width:900px){.resource-search-panel form{flex-wrap:wrap}.resource-keyword{flex-basis:100%}.resource-source{flex:1}.resource-result-heading{align-items:flex-start;gap:10px;flex-direction:column}.resource-work-grid{grid-template-columns:1fr}}@media(max-width:600px){.resource-page-intro{align-items:flex-start;flex-direction:column}.resource-page-intro h1{font-size:24px}.resource-search-panel{padding:18px}.resource-type-tabs button{padding:8px 13px}.resource-work-grid{grid-template-columns:1fr}.resource-work-cover{width:76px;height:112px}}
</style>

<style scoped>
.resource-work-cover{cursor:pointer}.resource-work-cover:focus-visible{outline:3px solid #d4b8e6;outline-offset:3px}.resource-title-button{padding:0;border:0!important;background:none!important;box-shadow:none!important;color:inherit!important;font:inherit!important;text-align:left;cursor:pointer}.resource-title-button:hover{text-decoration:underline}.resource-title-button:focus-visible{outline:2px solid #d4b8e6;outline-offset:3px}
</style>
