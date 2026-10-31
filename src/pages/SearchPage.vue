<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { BangumiProvider, BangumiProviderError } from "@/infrastructure/metadata/bangumi-provider";
import { BangumiAuthorProvider } from "@/infrastructure/metadata/bangumi-author-provider";
import { matchAuthorName, type Author } from "@/domain/author";
import { VndbProvider, VndbProviderError } from "@/infrastructure/metadata/vndb-provider";
import type { MetadataProvider, SearchCandidate } from "@/application/metadata-ports";
import type { Media, MediaType } from "@/domain/media";
import { LocalMediaIndex, rankMedia } from "@/infrastructure/metadata/search-matcher";
import { useMediaLibraryStore } from "@/stores/media-library";
import { useSearchSessionStore } from "@/stores/search-session";
import MediaCard from "@/components/MediaCard.vue";

const bangumi = new BangumiProvider();
const bangumiAuthors = new BangumiAuthorProvider();
const vndb = new VndbProvider();
const providers: Record<MediaType, readonly MetadataProvider[]> = { anime: [bangumi], manga: [bangumi], novel: [bangumi], visual_novel: [vndb] };
const keyword = ref("");
const type = ref<MediaType>("anime");
const results = ref<SearchCandidate[]>([]);
const loading = ref(false);
const authorLoading = ref(false);
const localReady = ref(false);
const error = ref("");
const notice = ref("");
const searched = ref(false);
const requestId = ref(0);
const library = useMediaLibraryStore();
const searchSession = useSearchSessionStore();
const localIndex = new LocalMediaIndex();
const saveError = ref("");
const authors = ref<Author[]>([]);
const selectedAuthor = ref<Author>();
const authorPage = ref(0);
const authorHasMore = ref(false);
const route = useRoute();
const router = useRouter();
let activeSearch = "";
let searchAbort: AbortController | undefined;
const typeLabels: Record<MediaType, string> = { anime: "动画", manga: "漫画", novel: "小说", visual_novel: "Galgame" };

onMounted(() => { applyRouteSearch(true); void library.initialize(); });
watch(() => [route.path, route.query.q, route.query.type, route.query.mode, route.query.person], () => applyRouteSearch());
onUnmounted(() => { requestId.value++; searchAbort?.abort(); });

function isMediaType(value: unknown): value is MediaType { return value === "anime" || value === "manga" || value === "novel" || value === "visual_novel"; }
function searchKey(value: string, selectedType: MediaType, person = ""): string { return JSON.stringify([value, selectedType, person]); }
function searchLocation(value: string, selectedType: MediaType, person?: string) { return { path: "/search", query: { ...(value ? { q: value } : {}), type: selectedType, ...(person ? { person } : {}) } }; }
function authorViewKey(value: string, selectedType: MediaType): string { return "acgn-hub.author-search-view.v1:" + JSON.stringify([value, selectedType]); }
function rememberAuthorView(): void {
  if (!selectedAuthor.value) return;
  try { sessionStorage.setItem(authorViewKey(keyword.value.trim(), type.value), JSON.stringify({ author: selectedAuthor.value, authors: authors.value, page: authorPage.value, hasMore: authorHasMore.value, storedAt: Date.now() })); } catch { /* Results stay available in the current view. */ }
}
function restoreAuthorView(value: string, selectedType: MediaType): void {
  const linked = results.value.find((candidate) => typeof candidate.media.metadata.authorId === "string" && typeof candidate.media.metadata.authorName === "string")?.media.metadata;
  if (linked) selectedAuthor.value = { id: linked.authorId as string, name: linked.authorName as string, aliases: [] };
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(authorViewKey(value, selectedType)) ?? "null");
    if (!saved || typeof saved !== "object") return;
    const item = saved as Record<string, unknown>;
    const author = item.author as Partial<Author> | undefined;
    if (!author || typeof author.id !== "string" || !/^\d+$/.test(author.id) || typeof author.name !== "string" || !author.name || !Array.isArray(author.aliases) || !author.aliases.every((alias) => typeof alias === "string")
      || typeof item.storedAt !== "number" || !Number.isFinite(item.storedAt) || Date.now() - item.storedAt > 30 * 60_000 || Date.now() - item.storedAt < -60_000
      || typeof item.page !== "number" || !Number.isSafeInteger(item.page) || item.page < 0 || typeof item.hasMore !== "boolean"
      || linked && linked.authorId !== author.id) return;
    selectedAuthor.value = { id: author.id, name: author.name, aliases: author.aliases };
    authors.value = Array.isArray(item.authors) ? item.authors.filter((candidate): candidate is Author => Boolean(candidate && typeof candidate === "object" && typeof candidate.id === "string" && typeof candidate.name === "string" && Array.isArray(candidate.aliases) && candidate.aliases.every((alias: unknown) => typeof alias === "string"))).slice(0, 2) : [selectedAuthor.value];
    authorPage.value = item.page; authorHasMore.value = item.hasMore;
  } catch { /* An optional damaged context cannot discard restored works. */ }
}

function applyRouteSearch(restoreLast = false): void {
  if (route.path !== "/search") { requestId.value++; searchAbort?.abort(); return; }
  const query = typeof route.query.q === "string" ? route.query.q.trim() : "";
  const selectedType = isMediaType(route.query.type) ? route.query.type : "anime";
  const person = typeof route.query.person === "string" && /^\d+$/.test(route.query.person) ? route.query.person : "";
  const hasRouteSearch = route.query.q !== undefined || route.query.type !== undefined || route.query.mode !== undefined || route.query.person !== undefined;
  const restored = searchSession.restoreSearch();
  if (!hasRouteSearch && restoreLast && restored) { void router.replace(searchLocation(restored.keyword.trim(), restored.type)); return; }
  if (hasRouteSearch && (route.query.type !== selectedType || route.query.q !== (query || undefined) || route.query.mode !== undefined || route.query.person !== (person || undefined))) {
    void router.replace(searchLocation(query, selectedType, person || undefined)); return;
  }
  const key = searchKey(query, selectedType, person);
  if (activeSearch === key) return;
  requestId.value++; searchAbort?.abort(); activeSearch = key;
  type.value = selectedType; keyword.value = query; results.value = [];
  loading.value = false; authorLoading.value = false; error.value = ""; notice.value = ""; saveError.value = "";
  searched.value = false; localReady.value = false; authors.value = []; selectedAuthor.value = undefined;
  authorPage.value = 0; authorHasMore.value = false;
  if (!query) return;
  if (!person && restored?.keyword.trim() === query && restored.type === selectedType && restored.candidates.length > 0) {
    results.value = restored.candidates; searched.value = true; localReady.value = true;
    restoreAuthorView(query, selectedType);
    return;
  }
  void runSearch(query, selectedType, person, results.value);
}

async function submit(): Promise<void> {
  const value = keyword.value.trim();
  if (!value) { error.value = "请输入作品名或作者名"; return; }
  keyword.value = value;
  if (route.query.q === value && route.query.type === type.value && !route.query.person) { await runSearch(value, type.value); return; }
  await router.push(searchLocation(value, type.value));
}

function confidentAuthors(value: string, people: Author[]): Author[] {
  const scored = people.map((author, order) => ({ author, score: matchAuthorName(author, value), order }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  const best = scored[0]?.score;
  const seen = new Set<string>();
  return scored.filter((item) => item.score === best && !seen.has(item.author.id) && (seen.add(item.author.id), true)).slice(0, 2).map((item) => item.author);
}

function mergeResults(titleCandidates: SearchCandidate[], works: Media[]): SearchCandidate[] {
  const merged = new Map<string, SearchCandidate>();
  for (const candidate of titleCandidates) if (candidate.media.type === type.value) merged.set(candidate.media.id, candidate);
  // An author relation is direct metadata, never title-ranked against the name.
  for (const media of works) {
    if (media.type !== type.value) continue;
    const previous = merged.get(media.id);
    merged.set(media.id, { media: previous ? { ...previous.media, ...media, metadata: { ...previous.media.metadata, ...media.metadata } } : media, score: previous?.score ?? 100, reason: previous?.reason ?? "exact" });
  }
  return [...merged.values()];
}

async function runSearch(value: string, selectedType: MediaType, person = "", restored: SearchCandidate[] = []): Promise<void> {
  const request = ++requestId.value;
  searchAbort?.abort(); searchAbort = new AbortController();
  const signal = searchAbort.signal;
  searched.value = true; error.value = ""; notice.value = "";
  authors.value = []; selectedAuthor.value = undefined; authorPage.value = 0; authorHasMore.value = false;
  const localCandidates = rankMedia(value, [...library.items.filter((item) => item.type === selectedType), ...localIndex.search(value, selectedType).map((item) => item.media)]);
  results.value = restored.length ? restored : localCandidates;
  localReady.value = true; loading.value = true; authorLoading.value = selectedType !== "visual_novel";
  const titleTask = (async () => {
    const remote = await Promise.allSettled(providers[selectedType].map((provider) => provider.search({ keyword: value, type: selectedType, pageSize: 30 })));
    if (request !== requestId.value || signal.aborted) return;
    const media = remote.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const titles = rankMedia(value, [...localCandidates.map((item) => item.media), ...media]);
    results.value = mergeResults(titles, results.value.filter((candidate) => typeof candidate.media.metadata.authorId === "string").map((candidate) => candidate.media));
    localIndex.remember(media);
    const failures = remote.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (!results.value.length && failures.length) error.value = providerError(failures[0].reason);
    loading.value = false;
    if (results.value.length) searchSession.rememberSearch(value, selectedType, results.value);
  })();
  const authorTask = selectedType === "visual_novel" ? Promise.resolve() : (async () => {
    try {
      const people = await bangumiAuthors.searchPeople(value, { signal });
      if (request !== requestId.value || signal.aborted) return;
      authors.value = confidentAuthors(value, people);
      const author = authors.value.find((item) => item.id === person) ?? authors.value[0];
      if (!author) return;
      selectedAuthor.value = author;
      await fetchAuthorWorks(author, selectedType, 1, request, signal, true);
    } catch (cause) {
      if (request === requestId.value && !signal.aborted && !results.value.length) notice.value = cause instanceof Error ? "作者关联检索暂不可用：" + cause.message : "作者关联检索暂不可用";
    } finally { if (request === requestId.value) authorLoading.value = false; }
  })();
  await Promise.allSettled([titleTask, authorTask]);
  if (request !== requestId.value || signal.aborted) return;
  loading.value = false; authorLoading.value = false;
  if (results.value.length) error.value = "";
  searchSession.rememberSearch(value, selectedType, results.value);
  rememberAuthorView();
}

async function fetchAuthorWorks(author: Author, selectedType: MediaType, startPage: number, request = requestId.value, signal = searchAbort?.signal, initial = false): Promise<void> {
  authorLoading.value = true;
  let page = startPage;
  try {
    for (let batch = 0; batch < (initial ? 2 : 1); batch++) {
      const result = await bangumiAuthors.listWorks(author.id, selectedType, { page, pageSize: 20, signal });
      if (request !== requestId.value || signal?.aborted) return;
      authorPage.value = page; authorHasMore.value = result.hasMore;
      const works = result.items.map((media) => ({ ...media, metadata: { ...media.metadata, authorName: author.name, authorId: author.id } }));
      results.value = mergeResults(results.value, works);
      if (result.warning) notice.value = result.warning;
      if (works.length || !result.hasMore || !initial) break;
      page++;
    }
    if (request === requestId.value) {
      const hasWorks = results.value.some((candidate) => candidate.media.metadata.authorId === author.id);
      if (!hasWorks) notice.value = authorHasMore.value ? "当前批次暂无此分类作品，可以继续读取后续关联作品。" : "该作者没有找到此分类的关联作品。";
      if (results.value.length) error.value = "";
      searchSession.rememberSearch(keyword.value.trim(), selectedType, results.value);
      rememberAuthorView();
    }
  } catch (cause) {
    if (request === requestId.value && !signal?.aborted) notice.value = cause instanceof Error ? cause.message : "作者作品读取失败";
  } finally { if (request === requestId.value) authorLoading.value = false; }
}

function chooseAuthor(event: Event): void { void router.push(searchLocation(keyword.value.trim(), type.value, (event.target as HTMLSelectElement).value)); }
function changeType(selectedType: MediaType): void {
  if (selectedType === type.value) return;
  requestId.value++; searchAbort?.abort();
  const person = typeof route.query.person === "string" ? route.query.person : undefined;
  void router.push(searchLocation(keyword.value.trim(), selectedType, person));
}
function providerError(cause: unknown): string { return cause instanceof BangumiProviderError || cause instanceof VndbProviderError ? cause.message : "搜索服务暂时不可用，已显示本地缓存结果"; }
async function toggleSaved(media: Media): Promise<void> {
  saveError.value = "";
  try { await (library.isSaved(media.id) ? library.remove(media.id) : library.save(media)); }
  catch (cause) { saveError.value = cause instanceof Error ? cause.message : "收藏保存失败，请重试"; }
}
function matchLabel(candidate: SearchCandidate): string {
  if (typeof candidate.media.metadata.authorName === "string") return "作者：" + candidate.media.metadata.authorName + (typeof candidate.media.metadata.authorRole === "string" ? " · " + candidate.media.metadata.authorRole : "");
  return { exact: "标题匹配", alias: "别名匹配", prefix: "标题接近", contains: "相关标题", pinyin: "拼音匹配", fuzzy: "相似标题" }[candidate.reason];
}
</script>

<template>
  <div class="discover-search-page">
    <header class="search-page-heading"><div><span class="search-kicker">发现下一部心动</span><h1>搜索作品</h1></div><RouterLink to="/resources">直接找资源 <span>↗</span></RouterLink></header>
    <div class="search-type-tabs" aria-label="作品分类"><button v-for="(label, mediaType) in typeLabels" :key="mediaType" :class="{ active: type === mediaType }" type="button" @click="changeType(mediaType)">{{ label }}</button></div>
    <form class="poster-search-form" @submit.prevent="submit"><span aria-hidden="true">⌕</span><input v-model="keyword" type="search" :aria-label="typeLabels[type] + '名称'" :placeholder="type === 'visual_novel' ? '搜索游戏名、原名或别名' : '输入作品名或作者名…'" autocomplete="off" autofocus /><button type="submit">搜索</button></form>
    <div class="search-meta"><span>{{ type === 'visual_novel' ? 'VNDB 作品资料' : 'Bangumi 作品与作者资料' }}</span><span v-if="results.length">{{ results.length }} 部作品</span><span v-else>作品名与作者名，都可以直接搜索</span></div>
    <div v-if="selectedAuthor" class="author-works-heading"><h2>{{ selectedAuthor.name }}的作品 <small>{{ typeLabels[type] }}</small></h2><label v-if="authors.length > 1">同名作者<select :value="selectedAuthor.id" aria-label="同名作者" @change="chooseAuthor"><option v-for="author in authors" :key="author.id" :value="author.id">{{ author.name }}{{ author.aliases.length ? ' · ' + author.aliases[0] : '' }}</option></select></label></div>
    <p v-if="error" class="search-notice error-message" role="alert">{{ error }} <button v-if="!loading" type="button" @click="submit">重试</button></p>
    <p v-if="notice" class="search-notice" role="status">{{ notice }}</p>
    <p v-if="library.error || saveError" class="search-notice error-message" role="alert">{{ saveError || library.error }}；作品仍可点击查看。</p>
    <p v-if="localReady && loading && results.length" class="search-notice" role="status">已显示部分作品，正在补充关联结果…</p>
    <div v-if="searched && (loading || authorLoading) && !results.length" class="search-skeleton-grid" role="status" aria-label="正在读取搜索结果"><div v-for="index in 12" :key="index"><span></span><i></i><i></i></div></div>
    <section v-else-if="!searched" class="search-resting"><h2>想看什么，就从名字开始。</h2><p>输入作品名或作者名，直接查看动画、漫画、小说的作品结果；Galgame 支持游戏名搜索。</p><RouterLink to="/resources">打开资源搜索 <span>→</span></RouterLink></section>
    <section v-else-if="!loading && !authorLoading && !results.length && !error" class="search-resting"><h2>这次没有找到</h2><p>试试完整的作品名、作者原名或别名，也可以直接从资源来源检索。</p><RouterLink :to="{ path: '/resources', query: { q: keyword, type } }">用这个关键词找资源 →</RouterLink></section>
    <section v-if="results.length" class="poster-results-grid" aria-label="作品搜索结果"><MediaCard v-for="candidate in results" :key="candidate.media.id" :media="candidate.media" :saved="library.isSaved(candidate.media.id)" @toggle-save="toggleSaved"><template #footer><span>{{ candidate.media.releaseYear || typeLabels[candidate.media.type] }}</span><span :title="matchLabel(candidate)">{{ matchLabel(candidate) }}</span></template></MediaCard></section>
    <button v-if="selectedAuthor && authorHasMore" class="author-more" type="button" :disabled="authorLoading || loading" @click="fetchAuthorWorks(selectedAuthor, type, authorPage + 1)">{{ authorLoading ? '读取中…' : '加载更多关联作品' }}</button>
  </div>
</template>

<style scoped>
.discover-search-page{max-width:1500px;margin:0 auto}.search-page-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:3px 0 26px}.search-kicker{color:#a79aac;font-size:11px;letter-spacing:1.5px}.search-page-heading h1{font-size:28px;font-weight:680;letter-spacing:-1px;color:#3c344e;margin:8px 0 0}.search-page-heading>a{color:#a88fae;text-decoration:none;font-size:12px}.search-page-heading>a span{margin-left:7px}.search-type-tabs{display:flex;gap:28px;margin:0 0 22px;padding-bottom:0;border-bottom:1px solid #ece6f0}.search-type-tabs button{position:relative;border:0;background:none;color:#a49bac;padding:0 2px 13px;font-size:13px}.search-type-tabs button.active{color:#806cb0;font-weight:650}.search-type-tabs button.active:after{content:'';position:absolute;bottom:-1px;height:3px;left:0;right:0;background:#aa95d1;border-radius:5px}.poster-search-form{display:flex;gap:13px;align-items:center;background:#fff;border:1px solid #e5deeb;border-radius:13px;padding:7px 8px 7px 19px;box-shadow:0 3px 16px #39214904}.poster-search-form>span{font-size:27px;line-height:1;color:#ab9db8}.poster-search-form input{flex:1;min-width:0;border:none;box-shadow:none;background:none;padding:11px 0;font-size:14px;color:#54465f}.poster-search-form button{padding:12px 26px;border:0;border-radius:9px;background:#9280be;color:#fff;font-size:12px}.poster-search-form button:disabled{opacity:.55}.search-meta{display:flex;justify-content:space-between;gap:15px;margin:14px 1px 28px;color:#b0a6b7;font-size:11px}.poster-results-grid,.search-skeleton-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:26px 20px}.search-notice{padding:12px 0;color:#9e91a8;font-size:12px;line-height:1.7}.search-notice.error-message{color:#c07391}.search-notice button{border:0;background:#f5eaf1;color:#b47798;border-radius:6px;margin-left:8px;padding:4px 10px}.search-resting{padding:70px 25px;text-align:center;color:#a89caf}.search-resting h2{font-size:19px;font-weight:550;color:#81718f;margin-bottom:13px}.search-resting p{max-width:460px;margin:0 auto;font-size:12px;line-height:1.9}.search-resting a{display:inline-block;text-decoration:none;color:#9b83b5;font-size:12px;margin-top:23px}.search-skeleton-grid>div{display:grid;gap:10px}.search-skeleton-grid span{aspect-ratio:2/2.9;border-radius:13px;background:linear-gradient(100deg,#ebe7f0 35%,#f5f2f7 50%,#ebe7f0 65%);background-size:200% 100%;animation:search-shimmer 1.7s infinite}.search-skeleton-grid i{height:9px;border-radius:4px;background:#ede8f1;width:85%}.search-skeleton-grid i:last-child{width:45%}@keyframes search-shimmer{to{background-position:-200% 0}}@media(min-width:1400px){.poster-results-grid,.search-skeleton-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}@media(max-width:700px){.search-page-heading{margin-bottom:22px}.search-page-heading h1{font-size:24px}.search-type-tabs{gap:23px}.poster-results-grid,.search-skeleton-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:20px 13px}.poster-search-form button{padding:12px 16px}.search-meta{font-size:10px}.search-meta span:last-child{max-width:50%;text-align:right}.search-page-heading>a{font-size:11px}}@media(max-width:430px){.poster-results-grid,.search-skeleton-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(prefers-reduced-motion:reduce){.search-skeleton-grid span{animation:none}}
.author-works-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:24px 0 22px}.author-works-heading h2{font-size:18px;color:#715182;margin:0}.author-works-heading h2 small{font-size:11px;font-weight:400;color:#aa91b8;margin-left:9px}.author-works-heading label{font-size:11px;color:#a78bb7;display:flex;align-items:center;gap:9px}.author-works-heading select{font:inherit;font-size:11px;border:1px solid #e4d6ee;border-radius:7px;padding:8px;color:#8e70a1;background:#fff;max-width:270px}.author-more{font:inherit;font-size:12px;border:1px solid #dfcfe9;background:#faf5fd;color:#9573a8;border-radius:8px;padding:11px 22px;display:block;margin:27px auto 10px;cursor:pointer}.author-more:disabled{opacity:.5;cursor:default}@media(max-width:700px){.author-works-heading{align-items:flex-start;flex-direction:column;gap:12px}}
</style>
