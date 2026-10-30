<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import MediaCard from "@/components/MediaCard.vue";
import MediaPoster from "@/components/MediaPoster.vue";
import AppIcon from "@/components/AppIcon.vue";
import BookDiscovery from "@/components/BookDiscovery.vue";
import { getDiscoveryCalendar, type DiscoveryResult } from "@/infrastructure/metadata/discovery-provider";
import { useMediaLibraryStore } from "@/stores/media-library";
import { useSearchSessionStore } from "@/stores/search-session";
import { readTracking, useTrackingStore } from "@/stores/tracking";
import type { Media } from "@/domain/media";
import { getMediaRating } from "@/domain/media-rating";
import { getCurrentAnimeSeason, getAnimeSeasonLabel, listAnimeSeasons, type AnimeSeason } from "@/domain/anime-season";
import { getSeasonDiscovery, type SeasonDiscoveryResult } from "@/infrastructure/metadata/season-discovery-provider";

const library = useMediaLibraryStore();
const route = useRoute();
const router = useRouter();
const session = useSearchSessionStore();
const tracking = useTrackingStore();
const calendar = ref<DiscoveryResult>();
const loading = ref(true);
const error = ref("");
const saveError = ref("");
const saving = reactive(new Set<string>());
const clock = ref(new Date());
const today = computed(() => clock.value.getDay() || 7);
const day = ref(today.value);
const currentSeason = computed(() => getCurrentAnimeSeason(clock.value));
function seasonFromQuery(value: unknown): AnimeSeason | undefined {
  const match = typeof value === "string" ? value.match(/^(\d{4})-Q([1-4])$/) : undefined;
  if (!match || Number(match[1]) < 1900 || Number(match[1]) > 9998) return;
  return { year: Number(match[1]), quarter: Number(match[2]) as AnimeSeason["quarter"] };
}
const requestedSeason = seasonFromQuery(route.query.season);
const selectedSeason = ref<AnimeSeason>(requestedSeason ?? getCurrentAnimeSeason());
const followCurrentSeason = ref(!requestedSeason);
const seasonResult = ref<SeasonDiscoveryResult>();
const seasonItems = ref<Media[]>([]);
const seasonLoading = ref(true);
const seasonError = ref("");
const seasonKey = (season: AnimeSeason) => `${season.year}-Q${season.quarter}`;
const seasonOptions = computed(() => {
  const options = listAnimeSeasons(clock.value, 12);
  return options.some((item) => seasonKey(item) === seasonKey(selectedSeason.value)) ? options : [...options, selectedSeason.value];
});
const seasonLabel = computed(() => getAnimeSeasonLabel(selectedSeason.value));
let seasonGeneration = 0;
let seasonController: AbortController | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let lastSeasonRequestAt = 0;
let lastCalendarRequestAt = 0;
let disposed = false;
const picked = ref(0);
type DiscoveryMode = "anime" | "manga" | "novel" | "visual_novel";
const mode = computed<DiscoveryMode>(() => route.query.type === "manga" || route.query.type === "novel" || route.query.type === "visual_novel" ? route.query.type : "anime");
const bookSort = computed(() => route.query.bookSort === "score" || route.query.bookSort === "recent" ? route.query.bookSort : "heat");
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const allMedia = computed(() => [...new Map([...(calendar.value?.days.flatMap((value) => value.items) ?? []), ...seasonItems.value].map((item) => [item.id, item])).values()]);
const popular = computed(() => seasonItems.value);
const spotlight = computed(() => popular.value.slice(0, 5));
const featured = computed(() => spotlight.value[picked.value % Math.max(1, spotlight.value.length)]);
const dailyMedia = computed(() => calendar.value?.days.find((value) => value.id === day.value)?.items ?? []);
const following = computed(() => library.items.filter((item) => item.type === "anime" && readTracking(item).status === "watching"));
const savedByType = computed(() => library.items.filter((item) => item.type === mode.value));
const typeNames = { anime: "动画", manga: "漫画", novel: "轻小说", visual_novel: "Galgame" };
onMounted(() => {
  void library.initialize().catch((cause: unknown) => { saveError.value = cause instanceof Error ? cause.message : "书架暂时未能加载，请稍后重试。"; });
  if (mode.value === "anime") { void load(); void loadSeason(); }
  clockTimer = setInterval(syncClock, 60_000);
  window.addEventListener("focus", syncClock);
  document.addEventListener("visibilitychange", onVisibilityChange);
});
watch(mode, (next) => {
  saveError.value = "";
  if (next === "anime") {
    if (!calendar.value) void load();
    if (!seasonResult.value || seasonKey(seasonResult.value.season) !== seasonKey(selectedSeason.value)) void loadSeason();
  } else {
    seasonGeneration++; seasonController?.abort(); seasonLoading.value = false;
  }
});
watch(() => route.query.season, (value) => {
  const requested = seasonFromQuery(value);
  const next = requested ?? currentSeason.value;
  const changed = seasonKey(next) !== seasonKey(selectedSeason.value);
  selectedSeason.value = next; followCurrentSeason.value = !requested;
  if (changed && mode.value === "anime") void loadSeason();
});
onBeforeUnmount(() => {
  disposed = true;
  if (clockTimer) clearInterval(clockTimer);
  seasonGeneration++; seasonController?.abort();
  window.removeEventListener("focus", syncClock);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});

function onVisibilityChange(): void { if (!document.hidden) syncClock(); }
function syncClock(): void {
  const previousToday = today.value;
  clock.value = new Date();
  if (day.value === previousToday) day.value = today.value;
  const movedSeason = seasonKey(currentSeason.value) !== seasonKey(selectedSeason.value);
  if (followCurrentSeason.value && movedSeason) {
    selectedSeason.value = currentSeason.value;
    if (mode.value === "anime") void loadSeason(true);
  } else if (mode.value === "anime" && !seasonLoading.value && Date.now() - lastSeasonRequestAt >= 30 * 60_000) void loadSeason(true);
  if (mode.value === "anime" && !loading.value && Date.now() - lastCalendarRequestAt >= 30 * 60_000) void load(true);
}
function chooseMode(next: DiscoveryMode): void {
  if (next === mode.value) return;
  void router.push({ query: { ...route.query, type: next === "anime" ? undefined : next } }).catch(() => undefined);
}
function chooseBookSort(sort: "heat" | "score" | "recent"): void {
  void router.push({ query: { ...route.query, bookSort: sort === "heat" ? undefined : sort } }).catch(() => undefined);
}
function chooseSeason(event: Event): void {
  const key = (event.target as HTMLSelectElement).value;
  const season = seasonOptions.value.find((item) => seasonKey(item) === key);
  if (!season) return;
  void router.push({ query: { ...route.query, season: key === seasonKey(currentSeason.value) ? undefined : key } }).catch(() => undefined);
}
function returnToCurrentSeason(): void {
  clock.value = new Date();
  if (route.query.season) void router.push({ query: { ...route.query, season: undefined } }).catch(() => undefined);
  else { selectedSeason.value = currentSeason.value; followCurrentSeason.value = true; void loadSeason(true); }
}
async function loadSeason(refresh = false, append = false): Promise<void> {
  if (append && (seasonLoading.value || !seasonResult.value?.hasMore)) return;
  const generation = ++seasonGeneration;
  seasonController?.abort(); seasonController = new AbortController();
  const season = { ...selectedSeason.value };
  const page = append ? (seasonResult.value?.page ?? 0) + 1 : 1;
  if (!append && (!seasonResult.value || seasonKey(seasonResult.value.season) !== seasonKey(season))) {
    seasonItems.value = []; seasonResult.value = undefined; picked.value = 0;
  }
  seasonLoading.value = true; seasonError.value = ""; lastSeasonRequestAt = Date.now();
  try {
    const result = await getSeasonDiscovery(season, { page, refresh, signal: seasonController.signal });
    if (generation !== seasonGeneration || seasonKey(season) !== seasonKey(selectedSeason.value)) return;
    seasonItems.value = [...new Map([...(append ? seasonItems.value : []), ...result.items].map((item) => [item.id, item])).values()];
    seasonResult.value = result;
    session.remember(result.items.map((media) => ({ media, score: 100, reason: "exact" as const })));
  } catch (cause) {
    if (generation === seasonGeneration) seasonError.value = cause instanceof Error ? cause.message : "季度新番暂时无法更新，请重试。";
  } finally { if (generation === seasonGeneration) seasonLoading.value = false; }
}
async function load(refresh = false): Promise<void> {
  loading.value = true; error.value = ""; lastCalendarRequestAt = Date.now();
  try {
    const result = await getDiscoveryCalendar({ refresh });
    if (disposed) return;
    calendar.value = result;
    session.remember(allMedia.value.map((media) => ({ media, score: 100, reason: "exact" as const })));
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : "放送表未能加载，请检查网络后重试。"; }
  finally { if (!disposed) loading.value = false; }
}
async function toggleSaved(media: Media): Promise<void> {
  if (saving.has(media.id)) return;
  saving.add(media.id);
  saveError.value = "";
  try { if (library.isSaved(media.id)) await library.remove(media.id); else await tracking.setStatus(media, "wish"); }
  catch (cause) { saveError.value = cause instanceof Error ? cause.message : "收藏没有保存，请重试。"; }
  finally { saving.delete(media.id); }
}
async function nextEpisode(media: Media): Promise<void> {
  try { await tracking.advance(media); } catch (cause) { saveError.value = String(cause); }
}
function score(media: Media): string { const number = getMediaRating(media); return number !== undefined && number > 0 ? number.toFixed(1) : "暂无"; }
function summary(media: Media): string { return media.description?.replace(/\s+/g, " ").trim() || "打开作品详情，看看这一次会遇见怎样的故事。"; }
function remember(media: Media): void { session.remember([{ media, score: 100, reason: "exact" }]); }
</script>



<template>
  <div class="discovery-page">
    <header class="discover-heading"><div><p>DISCOVER YOUR NEXT STORY</p><h1>发现好故事<span>✧</span></h1></div><nav class="discover-kind-switch" aria-label="发现作品分类"><button v-for="(label, key) in typeNames" :key="key" type="button" :class="{ active: mode === key }" :aria-pressed="mode === key" @click="chooseMode(key)">{{ label }}</button></nav></header>
    <p v-if="saveError" class="error-message" role="alert">{{ saveError }}</p>

    <template v-if="mode === 'anime'">
      <section class="season-toolbar" aria-label="季度新番设置">
        <div><p class="season-kicker">随季更新 · Bangumi</p><h2>{{ seasonLabel }}新番</h2><p>{{ followCurrentSeason ? '正在跟随当前季度，新一季到来时自动更新。' : '正在查看所选季度，可随时回到当前季度。' }}</p></div>
        <div class="season-controls"><label><span>首播季度</span><select aria-label="番剧季度" :value="seasonKey(selectedSeason)" @change="chooseSeason"><option v-for="season in seasonOptions" :key="seasonKey(season)" :value="seasonKey(season)">{{ getAnimeSeasonLabel(season) }}</option></select></label><button v-if="!followCurrentSeason" class="ghost-button" type="button" @click="returnToCurrentSeason">回到本季</button><button class="ghost-button" type="button" :disabled="seasonLoading" @click="loadSeason(true)">{{ seasonLoading ? '更新中…' : '刷新季度' }}</button></div>
      </section>
      <p v-if="seasonResult?.cached" class="discovery-cache-note" role="status"><template v-if="seasonResult.stale">网络暂不可用，正在显示 {{ seasonLabel }}的已保存目录。</template>更新于 {{ new Date(seasonResult.updatedAt).toLocaleString() }}。</p>
      <p v-if="seasonError && featured" class="error-message" role="alert">{{ seasonError }}</p>
      <section v-if="featured" class="anime-spotlight" aria-label="热门番剧">
        <div class="spotlight-backdrop"><MediaPoster :src="featured.coverUrl" :alt="featured.title" loading="eager" /></div>
        <div class="spotlight-copy"><span class="spotlight-eyebrow"><i></i> 大家在关注</span><h2>{{ featured.title }}</h2><p v-if="featured.originalTitle" class="spotlight-original">{{ featured.originalTitle }}</p><div class="spotlight-meta"><strong>★ {{ score(featured) }}</strong><span>{{ featured.releaseYear || '放送年份待定' }}</span><span>Bangumi</span></div><p class="spotlight-description">{{ summary(featured) }}</p><div class="spotlight-actions"><RouterLink class="spotlight-open" :to="'/media/' + encodeURIComponent(featured.id)" @click="remember(featured)">探索这部作品 <AppIcon name="arrow" :size="16" /></RouterLink><button class="spotlight-wish" :disabled="saving.has(featured.id)" @click="toggleSaved(featured)">{{ saving.has(featured.id) ? '保存中…' : library.isSaved(featured.id) ? '♥ 已想看' : '＋ 加入想看' }}</button></div><div class="spotlight-dots"><button v-for="(item, index) in spotlight" :key="item.id" :class="{ active: picked === index }" :aria-label="'切换到' + item.title" :aria-pressed="picked === index" @click="picked = index"></button></div></div>
        <RouterLink class="spotlight-poster" :to="'/media/' + encodeURIComponent(featured.id)" :aria-label="'查看' + featured.title" @click="remember(featured)"><MediaPoster :src="featured.coverUrl" :alt="featured.title + '封面'" loading="eager" /></RouterLink>
      </section>
      <section v-else-if="seasonLoading" class="spotlight-skeleton" role="status"><div></div><p>正在载入季度新番…</p></section>
      <section v-else class="discovery-load-error"><AppIcon name="warning" :size="24" /><div><h2>{{ seasonError ? '季度新番暂时未能加载' : '这个季度暂时没有收录作品' }}</h2><p>{{ seasonError || '可以切换其它季度，或稍后刷新。' }}</p></div><button class="ghost-button" @click="loadSeason(true)">重新加载</button><RouterLink to="/search">直接搜索作品 →</RouterLink></section>

      <section class="discovery-section season-catalog" aria-label="季度新番">
        <div class="discovery-section-heading"><div><span class="section-marker pink"></span><h2>这一季，想追什么？</h2><small>按首播季度 · 人气排序<template v-if="seasonResult"> · 已显示 {{ seasonItems.length }} / {{ seasonResult.total }} 部</template></small></div></div>
        <div v-if="seasonLoading && !seasonItems.length" class="poster-wall"><div v-for="number in 6" :key="number" class="poster-skeleton"></div></div>
        <div v-else-if="seasonItems.length" class="poster-wall"><MediaCard v-for="media in seasonItems" :key="media.id" :media="media" :saved="library.isSaved(media.id)" @toggle-save="toggleSaved" /></div>
        <div v-if="seasonResult?.hasMore" class="season-more"><button class="ghost-button" type="button" :disabled="seasonLoading" @click="loadSeason(false, true)">{{ seasonLoading ? '正在加载…' : '加载更多新番' }}</button></div>
      </section>

      <section v-if="following.length" class="discovery-section continue-section">
        <div class="discovery-section-heading"><div><span class="section-marker pink"></span><h2>继续追番</h2><small>上次的故事，还在等你</small></div><RouterLink to="/library?status=watching">全部在看 <AppIcon name="arrow" :size="15" /></RouterLink></div>
        <div class="continue-row"><article v-for="media in following.slice(0, 4)" :key="media.id" class="continue-card"><RouterLink :to="'/media/' + encodeURIComponent(media.id)"><MediaPoster :src="media.coverUrl" :alt="media.title" /><div><h3>{{ media.title }}</h3><p>看到第 {{ tracking.get(media).episode }} 集<template v-if="tracking.get(media).total"> / {{ tracking.get(media).total }} 集</template></p><span>继续了解作品 →</span></div></RouterLink><button :aria-label="media.title + '进度加一集'" @click="nextEpisode(media)">＋1 集</button></article></div>
      </section>

      <section class="discovery-section schedule-section" id="schedule">
        <div class="discovery-section-heading"><div><span class="section-marker"></span><h2>每周放送</h2><small>这周，也有值得期待的相遇</small></div><button class="discovery-text-button" :disabled="loading" @click="load(true)"><AppIcon name="refresh" :size="14" /> {{ loading ? '刷新中' : '刷新' }}</button></div>
        <div class="schedule-days" aria-label="选择放送日"><button v-for="(label, index) in weekdays" :key="label" :class="{ active: day === index + 1, today: today === index + 1 }" @click="day = index + 1"><span>周{{ label }}</span><small v-if="today === index + 1">今天</small><i v-else></i></button><span class="schedule-origin">放送计划 · Bangumi</span></div>
        <p v-if="calendar?.cached" class="discovery-cache-note">网络暂不可用，正在显示 {{ new Date(calendar.updatedAt).toLocaleDateString() }} 缓存的放送表。</p>
        <div v-if="loading && !calendar" class="poster-wall"><div v-for="number in 6" :key="number" class="poster-skeleton"></div></div>
        <div v-else-if="dailyMedia.length" class="poster-wall"><MediaCard v-for="media in dailyMedia.slice(0, 12)" :key="media.id" :media="media" :saved="library.isSaved(media.id)" @toggle-save="toggleSaved"><template #footer><span>{{ media.releaseYear || '待定' }}</span><span>{{ Number(media.metadata.watching) > 0 ? media.metadata.watching + ' 人在看' : '放送计划' }}</span></template></MediaCard></div>
        <div v-else class="schedule-empty">{{ error || '这一天暂时没有放送计划。可以看看其它日期，或者搜索喜欢的作品。' }}</div>
      </section>
    </template>
    <BookDiscovery v-else-if="mode === 'manga' || mode === 'novel'" :type="mode" :sort="bookSort" :saved="savedByType" :saving="saving" :is-saved="library.isSaved" @toggle-save="toggleSaved" @change-sort="chooseBookSort" />
    <template v-else>
      <section class="other-type-intro"><div><span>Galgame · 你的收藏</span><h2>下一段故事，由你选择。</h2><p>搜索作品资料，或直接从来源寻找准确的作品。</p><div><RouterLink class="primary-button" :to="{ path: '/search', query: { type: mode } }">搜索 Galgame</RouterLink><RouterLink class="ghost-button" :to="{ path: '/resources', query: { type: mode } }">直接寻找资源</RouterLink></div></div><AppIcon name="games" :size="110" /></section>
      <section class="discovery-section"><div class="discovery-section-heading"><div><span class="section-marker"></span><h2>已收藏的{{ typeNames[mode] }}</h2></div><RouterLink :to="{ path: '/library', query: { type: mode } }">查看全部 →</RouterLink></div><div v-if="savedByType.length" class="poster-wall"><MediaCard v-for="media in savedByType" :key="media.id" :media="media" :saved="true" @toggle-save="toggleSaved" /></div><div v-else class="schedule-empty">这里还没有收藏。搜索一部喜欢的作品，从第一本开始。</div></section>
    </template>
  </div>
</template>
<style scoped>
.discovery-page{max-width:1280px;margin:0 auto}.discover-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;gap:15px}.discover-heading p{font-size:9px;letter-spacing:1.8px;color:#aaa0ba;margin:0 0 8px;font-weight:600}.discover-heading h1{font-size:27px;font-weight:700;letter-spacing:-1px;color:#3e344b;margin:0}.discover-heading h1>span{font-size:24px;color:#c9a8d6;margin-left:10px;font-weight:400}.discover-kind-switch{display:flex;gap:4px;border-radius:10px;background:#eeecf3;padding:4px}.discover-kind-switch button{border:0;border-radius:7px;background:transparent;color:#93889f;padding:8px 14px;font-size:11px;cursor:pointer}.discover-kind-switch button.active{background:white;color:#7f68b6;box-shadow:0 2px 5px #44315d0c;font-weight:650}.anime-spotlight{height:294px;position:relative;border-radius:19px;overflow:hidden;background:#eee9f5;isolation:isolate;margin-bottom:33px;box-shadow:0 8px 25px #52316009}.spotlight-backdrop{position:absolute;inset:-30% -5% -30% 27%;z-index:-2;opacity:.4;filter:blur(18px)}.spotlight-backdrop :deep(img){object-position:center 38%}.anime-spotlight:after{content:'';position:absolute;inset:0;z-index:-1;background:linear-gradient(95deg,#f1ecf8 1%,#f1ecf8eb 32%,#f2eef6a6 55%,#ebe8f354)}.spotlight-copy{padding:27px 35px;width:69%;height:100%;position:relative;z-index:2}.spotlight-eyebrow{display:flex;gap:6px;align-items:center;color:#a082b4;font-size:10px}.spotlight-eyebrow i{width:5px;height:5px;border-radius:50%;background:#c58fba}.spotlight-copy h2{font-size:28px;letter-spacing:-.6px;color:#4a385a;margin:13px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.spotlight-original{font-size:11px;color:#a18ba9;margin:0}.spotlight-meta{display:flex;gap:13px;align-items:center;margin-top:13px;font-size:10px;color:#a18ca7}.spotlight-meta strong{color:#b48270;font-size:12px;font-weight:600}.spotlight-meta span+span{border-left:1px solid #d6c9dd;padding-left:13px}.spotlight-description{font-size:11px;line-height:1.9;color:#8e7c99;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:11px 0 16px;max-width:510px}.spotlight-actions{display:flex;gap:10px;align-items:center}.spotlight-open,.spotlight-wish{display:inline-flex;gap:9px;align-items:center;padding:10px 15px;border-radius:7px;text-decoration:none;font-size:11px;border:0;cursor:pointer}.spotlight-open{background:#8d78ba;color:white;box-shadow:0 3px 9px #8a6bb127}.spotlight-wish{background:#ffffff7a;color:#9984a8;border:1px solid #d8cde4}.spotlight-dots{display:flex;gap:5px;margin-top:17px}.spotlight-dots button{height:4px;width:13px;border-radius:5px;border:0;background:#cdbedb;padding:0;cursor:pointer}.spotlight-dots button.active{width:25px;background:#9c83ba}.spotlight-poster{position:absolute;right:9%;top:19px;width:174px;height:255px;border-radius:9px;overflow:hidden;transform:rotate(5deg);box-shadow:0 10px 28px #3f255b35;z-index:1}.discovery-section{margin:0 0 35px}.discovery-section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.discovery-section-heading>div{display:flex;align-items:center;gap:9px}.discovery-section-heading h2{font-size:17px;font-weight:650;color:#46394f;margin:0;letter-spacing:-.3px}.discovery-section-heading small{font-size:10px;color:#afa3b7;margin-left:5px}.discovery-section-heading>a,.discovery-text-button{display:flex;gap:6px;align-items:center;color:#9c8baf;font-size:10px;text-decoration:none}.discovery-text-button{border:0;background:none;cursor:pointer;padding:0}.section-marker{height:14px;width:4px;border-radius:3px;background:#baa6d7}.section-marker.pink{background:#eab2c4}.schedule-days{display:flex;align-items:center;gap:7px;margin:0 0 18px;padding:0 0 15px;border-bottom:1px solid #eae6ef}.schedule-days button{display:flex;align-items:center;gap:5px;justify-content:center;border:0;border-radius:7px;background:none;color:#9b8ea8;min-width:62px;padding:9px 12px;font-size:11px;cursor:pointer}.schedule-days button.active{background:#eee6f7;color:#9874bb;font-weight:650}.schedule-days small{font-size:8px;padding:2px 3px;border-radius:3px;background:#e8d8f2;color:#a381b9}.schedule-origin{margin-left:auto;font-size:9px;color:#bbb1c3}.poster-wall{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:22px 17px}.schedule-empty{border:1px dashed #e4ddeb;border-radius:12px;padding:35px;text-align:center;color:#ac9db7;font-size:12px;line-height:1.9}.discovery-cache-note{font-size:10px;color:#b59476;margin:0 0 13px}.continue-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.continue-card{position:relative;border:1px solid #eee6ef;border-radius:11px;background:white;padding:10px}.continue-card>a{display:flex;gap:11px;text-decoration:none;align-items:center}.continue-card :deep(.media-poster){width:49px;height:69px;border-radius:6px;flex-shrink:0}.continue-card h3{font-size:12px;color:#776380;margin:0 0 8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:170px}.continue-card p{font-size:10px;color:#ad9eb8;margin:0 0 6px}.continue-card a>div>span{font-size:9px;color:#bc9cb6}.continue-card>button{position:absolute;bottom:12px;right:10px;border:0;background:#f8eef4;color:#c28da6;border-radius:5px;padding:5px;font-size:9px;cursor:pointer}.spotlight-skeleton{height:294px;border-radius:19px;background:linear-gradient(110deg,#ece7f1,#f7f4fa,#eee8f4);display:grid;place-items:center;color:#ad9cbb;font-size:12px;margin-bottom:33px}.poster-skeleton{aspect-ratio:2/3;background:linear-gradient(100deg,#eeeaf3,#f8f6fb,#eeeaf3);border-radius:12px;animation:skeleton-pulse 1.5s infinite alternate}.discovery-load-error{display:flex;gap:15px;align-items:center;padding:30px;border:1px solid #e8dfed;background:#fff9fd;border-radius:15px;margin-bottom:30px;color:#b394b7;flex-wrap:wrap}.discovery-load-error h2{font-size:16px;color:#8e6c95;margin:0 0 5px}.discovery-load-error p{font-size:11px;margin:0}.discovery-load-error>a{font-size:11px;color:#b085ae;margin-left:auto}.other-type-intro{border:1px solid #e8e0f1;background:linear-gradient(115deg,#f4effa,#fcf7fb);border-radius:16px;display:flex;justify-content:space-between;align-items:center;padding:35px;margin-bottom:35px;gap:20px}.other-type-intro span{font-size:11px;color:#b19aba}.other-type-intro h2{font-size:24px;color:#75617f;letter-spacing:-.5px}.other-type-intro p{font-size:12px;color:#a495ad;margin-bottom:25px}.other-type-intro>svg{color:#d9cce5}.other-type-intro>div>div{display:flex;gap:10px}.other-type-intro .primary-button,.other-type-intro .ghost-button{text-decoration:none;font-size:11px}@keyframes skeleton-pulse{to{opacity:.5}}@media(min-width:1500px){.anime-spotlight{height:315px}.spotlight-copy{padding-top:34px}.spotlight-poster{height:277px;width:190px}.spotlight-description{max-width:600px}}@media(max-width:1100px){.poster-wall{grid-template-columns:repeat(5,minmax(0,1fr));gap:17px 14px}.discovery-section-heading small{display:none}.spotlight-poster{right:5%;width:153px;height:224px;top:34px}.spotlight-copy{padding-left:25px;width:70%}.spotlight-copy h2{font-size:24px}.schedule-days{gap:3px}.schedule-days button{min-width:53px;padding:8px}.continue-row{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:800px){.poster-wall{grid-template-columns:repeat(4,minmax(0,1fr))}.discover-kind-switch button{padding:7px 9px}.discover-heading h1{font-size:23px}.schedule-origin{display:none}.spotlight-poster{right:4%;width:125px;height:187px;top:46px}.spotlight-copy{width:72%;padding:25px 20px}.anime-spotlight{height:280px}.spotlight-copy h2{font-size:22px}.spotlight-description{max-width:300px}.continue-row{grid-template-columns:1fr}.other-type-intro>svg{display:none}}@media(max-width:600px){.discover-heading{align-items:flex-start;flex-direction:column;gap:14px}.discover-heading p{font-size:8px}.discover-kind-switch{width:100%;justify-content:space-around}.anime-spotlight{height:272px}.spotlight-poster{width:95px;height:143px;top:40px;right:15px;opacity:.8}.spotlight-copy{width:100%;padding:22px 18px}.spotlight-copy h2{max-width:70%;font-size:20px}.spotlight-original{max-width:70%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.spotlight-description{max-width:68%;-webkit-line-clamp:3;font-size:10px;min-height:50px}.spotlight-actions{margin-top:15px}.spotlight-wish,.spotlight-open{font-size:10px;padding:9px}.poster-wall{grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 11px}.schedule-days{justify-content:space-between;gap:0;overflow:auto}.schedule-days button{min-width:38px;padding:7px 4px}.schedule-days small{display:none}.discovery-section-heading h2{font-size:16px}.discovery-section-heading>a{font-size:9px}.other-type-intro{padding:24px}.other-type-intro h2{font-size:21px}}
</style>

<style scoped>
.season-toolbar{display:flex;align-items:center;justify-content:space-between;gap:22px;padding:19px 23px;margin-bottom:20px;border:1px solid #e9e1f0;border-radius:14px;background:linear-gradient(115deg,#fcfaff,#fffafc)}.season-kicker{font-size:10px;letter-spacing:1px;color:#ac95bb!important;margin:0 0 7px!important}.season-toolbar h2{font-size:20px;letter-spacing:-.4px;color:#69517e;margin:0 0 7px}.season-toolbar p{font-size:11px;color:#a18eae;line-height:1.6;margin:0}.season-controls{display:flex;align-items:flex-end;gap:9px;flex-wrap:wrap}.season-controls label{display:flex;flex-direction:column;gap:6px;font-size:10px;color:#a28aaf}.season-controls select{background:#fff;color:#755c89;border:1px solid #e3d6ed;border-radius:8px;padding:9px 30px 9px 11px;font:inherit;font-size:12px;min-width:165px}.season-controls .ghost-button{font-size:11px;padding:9px 12px;white-space:nowrap}.season-more{display:flex;justify-content:center;margin-top:25px}.season-more button{min-width:170px;font-size:12px}.season-catalog{margin-top:28px}@media(max-width:800px){.season-toolbar{align-items:flex-start;flex-direction:column;gap:15px;padding:18px}.season-controls{width:100%;gap:8px}.season-controls label{flex:1}.season-controls select{width:100%;min-width:140px}.season-toolbar h2{font-size:18px}}
</style>

<style scoped>
.discover-kind-switch button{font-size:13px;min-height:38px;padding:9px 16px}.discover-kind-switch button:focus-visible,.spotlight-dots button:focus-visible{outline:2px solid #a082bd;outline-offset:3px}.spotlight-eyebrow,.spotlight-original,.spotlight-meta,.spotlight-open,.spotlight-wish{font-size:12px}.spotlight-description{font-size:13px;line-height:1.8}.anime-spotlight{min-height:335px;height:auto}.spotlight-copy{padding-top:29px;padding-bottom:24px}.spotlight-poster{top:36px}.spotlight-wish:disabled{opacity:.65;cursor:wait}.discovery-section-heading small,.discovery-section-heading>a,.discovery-text-button,.season-toolbar p,.season-controls .ghost-button{font-size:12px}.discovery-section-heading{gap:16px}.season-toolbar h2{font-size:22px}.season-controls select{font-size:13px}.discovery-cache-note{font-size:12px;line-height:1.7}.schedule-empty{font-size:13px}.schedule-days button{font-size:12px}@media(max-width:800px){.discover-kind-switch button{font-size:12px;padding:8px 11px}.anime-spotlight{min-height:330px}.spotlight-poster{top:42px}.spotlight-description{font-size:12px}}@media(max-width:600px){.discover-kind-switch button{padding:8px 10px}.anime-spotlight{min-height:310px}.spotlight-copy{padding:22px 18px}.spotlight-description{font-size:11px}.spotlight-open,.spotlight-wish{font-size:11px}.discovery-section-heading>a{font-size:11px}.season-toolbar h2{font-size:20px}}
</style>
