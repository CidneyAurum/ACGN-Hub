<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { BangumiProvider, BangumiProviderError } from "@/infrastructure/metadata/bangumi-provider";
import { VndbProvider, VndbProviderError } from "@/infrastructure/metadata/vndb-provider";
import type { MetadataProvider, SearchCandidate } from "@/application/metadata-ports";
import type { Media, MediaType } from "@/domain/media";
import { LocalMediaIndex, rankMedia } from "@/infrastructure/metadata/search-matcher";
import { useMediaLibraryStore } from "@/stores/media-library";
import { useSearchSessionStore } from "@/stores/search-session";
import MediaCard from "@/components/MediaCard.vue";

const bangumi = new BangumiProvider();
const vndb = new VndbProvider();
const providers: Record<MediaType, readonly MetadataProvider[]> = {
  anime: [bangumi],
  manga: [bangumi],
  novel: [bangumi],
  visual_novel: [vndb],
};
const keyword = ref("");
const type = ref<MediaType>("anime");
const results = ref<SearchCandidate[]>([]);
const loading = ref(false);
const localReady = ref(false);
const error = ref("");
const searched = ref(false);
const requestId = ref(0);
const library = useMediaLibraryStore();
const searchSession = useSearchSessionStore();
const localIndex = new LocalMediaIndex();
const saveError = ref("");
const route = useRoute();
const router = useRouter();
let activeSearch = "";

const typeLabels: Record<MediaType, string> = {
  anime: "动画",
  manga: "漫画",
  novel: "小说",
  visual_novel: "Galgame",
};

onMounted(() => {
  applyRouteSearch(true);
  void library.initialize();
});
watch(() => [route.path, route.query.q, route.query.type], () => applyRouteSearch());
onUnmounted(() => { requestId.value += 1; });

function isMediaType(value: unknown): value is MediaType {
  return value === "anime" || value === "manga" || value === "novel" || value === "visual_novel";
}

function searchKey(value: string, selectedType: MediaType): string { return JSON.stringify([value, selectedType]); }
function searchLocation(value: string, selectedType: MediaType) {
  return { path: "/search", query: { ...(value ? { q: value } : {}), type: selectedType } };
}

function applyRouteSearch(restoreLast = false): void {
  if (route.path !== "/search") { requestId.value += 1; return; }
  const query = typeof route.query.q === "string" ? route.query.q.trim() : "";
  const selectedType = isMediaType(route.query.type) ? route.query.type : "anime";
  const hasRouteSearch = route.query.q !== undefined || route.query.type !== undefined;
  const restored = searchSession.restoreSearch();
  if (!hasRouteSearch && restoreLast && restored) {
    void router.replace(searchLocation(restored.keyword.trim(), restored.type));
    return;
  }
  if (hasRouteSearch && (route.query.type !== selectedType || route.query.q !== (query || undefined))) {
    void router.replace(searchLocation(query, selectedType));
    return;
  }
  const key = searchKey(query, selectedType);
  if (activeSearch === key) return;
  requestId.value += 1;
  activeSearch = key;
  type.value = selectedType;
  keyword.value = query;
  results.value = [];
  loading.value = false;
  error.value = "";
  saveError.value = "";
  searched.value = false;
  localReady.value = false;
  if (!query) return;
  if (restored?.keyword.trim() === query && restored.type === selectedType) {
    results.value = restored.candidates;
    searched.value = true;
    localReady.value = true;
    return;
  }
  void runSearch(query, selectedType);
}

async function submit(): Promise<void> {
  const value = keyword.value.trim();
  if (!value) {
    error.value = "请输入作品名称";
    return;
  }
  keyword.value = value;
  if (route.query.q === value && route.query.type === type.value && activeSearch === searchKey(value, type.value)) {
    await runSearch(value, type.value);
    return;
  }
  await router.push(searchLocation(value, type.value));
}

async function runSearch(value: string, selectedType: MediaType): Promise<void> {
  const currentRequest = ++requestId.value;
  searched.value = true;
  error.value = "";
  localReady.value = false;
  const localCandidates = rankMedia(value, [
    ...library.items.filter((item) => item.type === selectedType),
    ...localIndex.search(value, selectedType).map((item) => item.media),
  ]);
  results.value = dedupe(localCandidates);
  localReady.value = true;
  loading.value = true;

  const remoteResults = await Promise.allSettled(
    providers[selectedType].map((provider) => provider.search({ keyword: value, type: selectedType, pageSize: 30 })),
  );
  if (currentRequest !== requestId.value || selectedType !== type.value || activeSearch !== searchKey(value, selectedType)) return;

  const remoteMedia = remoteResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const merged = rankMedia(value, [...results.value.map((item) => item.media), ...remoteMedia]);
  results.value = dedupe(merged);
  localIndex.remember(remoteMedia);
  searchSession.rememberSearch(value, selectedType, results.value);
  const failures = remoteResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (!results.value.length && failures.length) error.value = providerError(failures[0].reason);
  loading.value = false;
}

function changeType(selectedType: MediaType): void {
  if (selectedType === type.value) return;
  requestId.value += 1;
  void router.push(searchLocation(keyword.value.trim(), selectedType));
}

function dedupe(candidates: SearchCandidate[]): SearchCandidate[] {
  const best = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    if (candidate.media.type !== type.value) continue;
    const existing = best.get(candidate.media.id);
    if (!existing || candidate.score > existing.score) best.set(candidate.media.id, candidate);
  }
  return [...best.values()].sort((left, right) => right.score - left.score);
}

function providerError(cause: unknown): string {
  return cause instanceof BangumiProviderError || cause instanceof VndbProviderError
    ? cause.message
    : "搜索服务暂时不可用，已显示本地缓存结果";
}

async function toggleSaved(media: Media): Promise<void> {
  saveError.value = "";
  try { await (library.isSaved(media.id) ? library.remove(media.id) : library.save(media)); }
  catch (cause) { saveError.value = cause instanceof Error ? cause.message : "收藏保存失败，请重试"; }
}

function matchLabel(candidate: SearchCandidate): string {
  return { exact: "标题匹配", alias: "别名匹配", prefix: "标题接近", contains: "相关标题", pinyin: "拼音匹配", fuzzy: "相似标题" }[candidate.reason];
}
</script>

<template>
  <div class="discover-search-page">
    <header class="search-page-heading"><div><span class="search-kicker">发现下一部心动</span><h1>搜索作品</h1></div><RouterLink to="/resources">直接找资源 <span>↗</span></RouterLink></header>
    <div class="search-type-tabs" aria-label="作品分类"><button v-for="(label, mediaType) in typeLabels" :key="mediaType" :class="{ active: type === mediaType }" type="button" @click="changeType(mediaType)">{{ label }}</button></div>
    <form class="poster-search-form" @submit.prevent="submit"><span aria-hidden="true">⌕</span><input v-model="keyword" type="search" :aria-label="typeLabels[type] + '名称'" :placeholder="type === 'visual_novel' ? '搜索游戏名、原名或别名' : '输入作品名、中文名或别名…'" autocomplete="off" autofocus /><button type="submit" :disabled="loading">{{ loading ? '搜索中…' : '搜索' }}</button></form>
    <div class="search-meta"><span>{{ type === 'visual_novel' ? 'VNDB 作品资料' : 'Bangumi 作品资料' }}</span><span v-if="results.length">{{ results.length }} 部作品</span><span v-else>先找到作品，再决定收藏或下载</span></div>
    <p v-if="error" class="search-notice error-message" role="alert">{{ error }} <button v-if="!loading" type="button" @click="submit">重试</button></p>
    <p v-if="library.error || saveError" class="search-notice error-message" role="alert">{{ saveError || library.error }}；作品仍可点击查看。</p>
    <p v-if="localReady && loading && results.length" class="search-notice" role="status">已显示本地记录，正在补充远端结果…</p>
    <div v-if="searched && loading && !results.length" class="search-skeleton-grid" role="status" aria-label="正在读取搜索结果"><div v-for="index in 12" :key="index"><span></span><i></i><i></i></div></div>
    <section v-else-if="!searched" class="search-resting"><h2>想看什么，就从名字开始。</h2><p>搜索动画、漫画、小说和 Galgame。也可以直接进入资源搜索，选择来源里的准确作品。</p><RouterLink to="/resources">打开资源搜索 <span>→</span></RouterLink></section>
    <section v-else-if="!loading && !results.length && !error" class="search-resting"><h2>这次没有找到</h2><p>试试更短的作品名、日文原名，或从资源来源直接检索。</p><RouterLink :to="{ path: '/resources', query: { q: keyword, type } }">用这个关键词找资源 →</RouterLink></section>
    <section v-if="results.length" class="poster-results-grid" aria-label="作品搜索结果"><MediaCard v-for="candidate in results" :key="candidate.media.id" :media="candidate.media" :saved="library.isSaved(candidate.media.id)" @toggle-save="toggleSaved"><template #footer><span>{{ candidate.media.releaseYear || typeLabels[candidate.media.type] }}</span><span>{{ matchLabel(candidate) }}</span></template></MediaCard></section>
  </div>
</template>

<style scoped>
.discover-search-page{max-width:1500px;margin:0 auto}.search-page-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:3px 0 26px}.search-kicker{color:#a79aac;font-size:11px;letter-spacing:1.5px}.search-page-heading h1{font-size:28px;font-weight:680;letter-spacing:-1px;color:#3c344e;margin:8px 0 0}.search-page-heading>a{color:#a88fae;text-decoration:none;font-size:12px}.search-page-heading>a span{margin-left:7px}.search-type-tabs{display:flex;gap:28px;margin:0 0 22px;padding-bottom:0;border-bottom:1px solid #ece6f0}.search-type-tabs button{position:relative;border:0;background:none;color:#a49bac;padding:0 2px 13px;font-size:13px}.search-type-tabs button.active{color:#806cb0;font-weight:650}.search-type-tabs button.active:after{content:'';position:absolute;bottom:-1px;height:3px;left:0;right:0;background:#aa95d1;border-radius:5px}.poster-search-form{display:flex;gap:13px;align-items:center;background:#fff;border:1px solid #e5deeb;border-radius:13px;padding:7px 8px 7px 19px;box-shadow:0 3px 16px #39214904}.poster-search-form>span{font-size:27px;line-height:1;color:#ab9db8}.poster-search-form input{flex:1;min-width:0;border:none;box-shadow:none;background:none;padding:11px 0;font-size:14px;color:#54465f}.poster-search-form button{padding:12px 26px;border:0;border-radius:9px;background:#9280be;color:#fff;font-size:12px}.poster-search-form button:disabled{opacity:.55}.search-meta{display:flex;justify-content:space-between;gap:15px;margin:14px 1px 28px;color:#b0a6b7;font-size:11px}.poster-results-grid,.search-skeleton-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:26px 20px}.search-notice{padding:12px 0;color:#9e91a8;font-size:12px;line-height:1.7}.search-notice.error-message{color:#c07391}.search-notice button{border:0;background:#f5eaf1;color:#b47798;border-radius:6px;margin-left:8px;padding:4px 10px}.search-resting{padding:70px 25px;text-align:center;color:#a89caf}.search-resting h2{font-size:19px;font-weight:550;color:#81718f;margin-bottom:13px}.search-resting p{max-width:460px;margin:0 auto;font-size:12px;line-height:1.9}.search-resting a{display:inline-block;text-decoration:none;color:#9b83b5;font-size:12px;margin-top:23px}.search-skeleton-grid>div{display:grid;gap:10px}.search-skeleton-grid span{aspect-ratio:2/2.9;border-radius:13px;background:linear-gradient(100deg,#ebe7f0 35%,#f5f2f7 50%,#ebe7f0 65%);background-size:200% 100%;animation:search-shimmer 1.7s infinite}.search-skeleton-grid i{height:9px;border-radius:4px;background:#ede8f1;width:85%}.search-skeleton-grid i:last-child{width:45%}@keyframes search-shimmer{to{background-position:-200% 0}}@media(min-width:1400px){.poster-results-grid,.search-skeleton-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}@media(max-width:700px){.search-page-heading{margin-bottom:22px}.search-page-heading h1{font-size:24px}.search-type-tabs{gap:23px}.poster-results-grid,.search-skeleton-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:20px 13px}.poster-search-form button{padding:12px 16px}.search-meta{font-size:10px}.search-meta span:last-child{max-width:50%;text-align:right}.search-page-heading>a{font-size:11px}}@media(max-width:430px){.poster-results-grid,.search-skeleton-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(prefers-reduced-motion:reduce){.search-skeleton-grid span{animation:none}}
</style>
