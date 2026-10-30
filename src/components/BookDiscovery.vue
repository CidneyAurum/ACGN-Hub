<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import MediaCard from "@/components/MediaCard.vue";
import MediaPoster from "@/components/MediaPoster.vue";
import type { Media } from "@/domain/media";
import { getMediaRating } from "@/domain/media-rating";
import { getBookDiscovery, type BookDiscoveryResult } from "@/infrastructure/metadata/book-discovery-provider";
import { useSearchSessionStore } from "@/stores/search-session";

type BookType = "manga" | "novel";
type BookSort = "heat" | "score" | "recent";
const props = defineProps<{
  type: BookType;
  sort: BookSort;
  saved: Media[];
  saving: Set<string>;
  isSaved: (id: string) => boolean;
}>();
const emit = defineEmits<{ "toggle-save": [media: Media]; "change-sort": [sort: BookSort] }>();
const session = useSearchSessionStore();
const items = ref<Media[]>([]);
const result = ref<BookDiscoveryResult>();
const loading = ref(false);
const error = ref("");
const retryAppend = ref(false);
const picked = ref(0);
const typeName = computed(() => props.type === "manga" ? "漫画" : "轻小说");
const sortOptions: Array<{ value: BookSort; label: string; description: string }> = [
  { value: "heat", label: "热门推荐", description: "看看大家最近在关注什么" },
  { value: "score", label: "高分佳作", description: "读者评价与口碑之选" },
  { value: "recent", label: "近一年热门", description: "发现近一年发售的新故事" },
];
const currentSort = computed(() => sortOptions.find((item) => item.value === props.sort)!);
const highlights = computed(() => items.value.slice(0, 5));
const featured = computed(() => highlights.value[picked.value % Math.max(1, highlights.value.length)]);
let generation = 0;
let controller: AbortController | undefined;
let disposed = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastAttemptAt = 0;
let lastDate = localDate();

watch(() => [props.type, props.sort] as const, () => {
  items.value = []; result.value = undefined; picked.value = 0;
  void load();
}, { immediate: true });
onMounted(() => {
  refreshTimer = setInterval(refreshIfDue, 60_000);
  window.addEventListener("focus", refreshIfDue);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
  disposed = true; generation++; controller?.abort();
  if (refreshTimer) clearInterval(refreshTimer);
  window.removeEventListener("focus", refreshIfDue);
  window.removeEventListener("online", onOnline);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
function localDate(): string { const now = new Date(); return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`; }
function onVisibilityChange(): void { if (!document.hidden) refreshIfDue(); }
function onOnline(): void {
  if (!loading.value && (!result.value || result.value.stale)) void load(true);
  else refreshIfDue();
}
function refreshIfDue(): void {
  if (disposed || loading.value || document.hidden || Date.now() - lastAttemptAt < 60_000) return;
  const dateChanged = props.sort === "recent" && localDate() !== lastDate;
  const expired = !result.value || Date.now() - Date.parse(result.value.updatedAt) >= 30 * 60_000;
  if (dateChanged || expired) void load(true);
}

async function load(refresh = false, append = false): Promise<void> {
  if (append && (loading.value || !result.value?.hasMore)) return;
  const request = ++generation;
  controller?.abort(); controller = new AbortController();
  const { type, sort } = props;
  const page = append ? (result.value?.page ?? 0) + 1 : 1;
  loading.value = true; error.value = ""; retryAppend.value = append;
  lastAttemptAt = Date.now(); lastDate = localDate();
  try {
    const next = await getBookDiscovery(type, { sort, page, refresh, signal: controller.signal });
    if (disposed || request !== generation || type !== props.type || sort !== props.sort) return;
    items.value = [...new Map([...(append ? items.value : []), ...next.items].map((media) => [media.id, media])).values()];
    result.value = next;
    if (!append) picked.value = 0;
    session.remember(next.items.map((media) => ({ media, score: 100, reason: "exact" as const })));
  } catch (cause) {
    if (!disposed && request === generation && !controller.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : "推荐目录暂时未能加载，请稍后重试。";
    }
  } finally { if (!disposed && request === generation) loading.value = false; }
}
function changeSort(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "heat" || value === "score" || value === "recent") emit("change-sort", value);
}
function remember(media: Media): void { session.remember([{ media, score: 100, reason: "exact" }]); }
function rating(media: Media): string { const value = getMediaRating(media); return value !== undefined && value > 0 ? value.toFixed(1) : "暂无评分"; }
function summary(media: Media): string {
  return media.description?.replace(/\s+/g, " ").trim() || (props.type === "manga"
    ? "让画面带你走进故事。打开作品详情，认识作者、人物与这部漫画的世界。"
    : "从下一页开始，遇见一个新世界。打开作品详情，了解故事、作者与读者评价。");
}
function tags(media: Media): string[] {
  return Array.isArray(media.metadata.tags) ? media.metadata.tags.flatMap((tag) => typeof tag === "string" ? [tag] : []).slice(0, 3) : [];
}
</script>

<template>
  <div class="book-discovery" :class="type" :aria-label="typeName + '发现'">
    <section class="book-intro">
      <div><p class="book-kicker">{{ type === 'manga' ? 'STORIES IN EVERY FRAME' : 'A WORLD BETWEEN THE LINES' }}</p><h2>{{ type === 'manga' ? '把喜欢的故事，翻到下一页。' : '在文字里，遇见另一个世界。' }}</h2><p class="book-intro-copy">{{ type === 'manga' ? '从人气连载到值得重读的经典，找到下一本想看的漫画。' : '人气系列、读者佳评与近一年新作，下一段冒险从这里开始。' }}</p></div>
      <RouterLink :to="{ path: '/search', query: { type } }" class="book-search-link">搜索{{ typeName }} <AppIcon name="arrow" :size="16" /></RouterLink>
    </section>

    <section v-if="featured" class="book-spotlight" :aria-label="typeName + '精选'">
      <div class="book-backdrop" aria-hidden="true"><MediaPoster :src="featured.coverUrl" alt="" loading="eager" /></div>
      <div class="book-feature-copy"><span class="book-feature-kicker">{{ currentSort.label }} <span>·</span> 本期书架</span><h2>{{ featured.title }}</h2><p v-if="featured.originalTitle && featured.originalTitle !== featured.title" class="book-original">{{ featured.originalTitle }}</p><div class="book-feature-meta"><strong>★ {{ rating(featured) }}</strong><span>{{ featured.releaseYear || '年份待定' }}</span><span>{{ typeName }}</span></div><p class="book-description">{{ summary(featured) }}</p><div v-if="tags(featured).length" class="book-tags"><span v-for="tag in tags(featured)" :key="tag">{{ tag }}</span></div><div class="book-feature-actions"><RouterLink class="book-open" :to="'/media/' + encodeURIComponent(featured.id)" @click="remember(featured)">探索这部作品 <AppIcon name="arrow" :size="16" /></RouterLink><button class="book-wish" type="button" :disabled="saving.has(featured.id)" @click="emit('toggle-save', featured)">{{ saving.has(featured.id) ? '保存中…' : isSaved(featured.id) ? '♥ 已收藏' : '＋ 加入书架' }}</button></div><div class="book-picks" aria-label="切换精选作品"><button v-for="(media, index) in highlights" :key="media.id" type="button" :class="{ active: picked === index }" :aria-label="'精选：' + media.title" :aria-pressed="picked === index" @click="picked = index">{{ String(index + 1).padStart(2, '0') }}</button></div></div>
      <div class="book-feature-covers"><div class="book-cover-shadow" aria-hidden="true"></div><RouterLink class="book-feature-cover" :to="'/media/' + encodeURIComponent(featured.id)" :aria-label="'查看精选' + featured.title" @click="remember(featured)"><MediaPoster :src="featured.coverUrl" :alt="featured.title + ' 封面'" loading="eager" /></RouterLink><span class="book-cover-caption">{{ type === 'manga' ? 'ONE MORE CHAPTER' : 'JUST ONE MORE PAGE' }}</span></div>
    </section>
    <section v-else-if="loading" class="book-feature-skeleton" role="status"><div></div><p>正在整理{{ typeName }}推荐书架…</p></section>

    <section class="book-catalog" :aria-label="typeName + '推荐封面墙'">
      <header class="book-section-heading"><div><p class="book-kicker">THE READING LIST</p><h2>{{ currentSort.label }}<small>{{ currentSort.description }}</small></h2></div><div class="book-catalog-actions"><label><span class="sr-only">{{ typeName }}推荐排序</span><select :aria-label="typeName + '推荐排序'" :value="sort" @change="changeSort"><option v-for="option in sortOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label><button class="book-refresh" type="button" :disabled="loading" :aria-label="'刷新' + typeName + '推荐'" @click="load(true)"><AppIcon name="refresh" :size="15" />{{ loading ? '更新中' : '刷新' }}</button></div></header>
      <p v-if="result?.stale" class="book-notice" role="status">网络暂不可用，正在显示已保存的{{ typeName }}目录。更新于 {{ new Date(result.updatedAt).toLocaleString() }}。</p>
      <p v-else-if="result?.warning" class="book-notice" role="status">{{ result.warning }}</p>
      <p v-if="error && items.length" class="book-error" role="alert">{{ error }}<button type="button" :disabled="loading" @click="load(false, retryAppend)">重试</button></p>
      <div v-if="loading && !items.length" class="book-wall" aria-hidden="true"><div v-for="number in 12" :key="number" class="book-poster-skeleton"></div></div>
      <div v-else-if="items.length" class="book-wall"><MediaCard v-for="media in items" :key="media.id" :media="media" :saved="isSaved(media.id)" @toggle-save="emit('toggle-save', $event)" /></div>
      <div v-else class="book-empty"><AppIcon :name="error ? 'warning' : 'manga'" :size="30" /><h3>{{ error ? typeName + '推荐暂时未能加载' : '这个分类暂时没有作品' }}</h3><p>{{ error || '试试其它排序，也可以搜索你想看的作品。' }}</p><div><button type="button" class="book-open" @click="load(true)">重新加载</button><RouterLink :to="{ path: '/search', query: { type } }">搜索{{ typeName }} →</RouterLink></div></div>
      <footer v-if="result && items.length" class="book-catalog-footer"><p>Bangumi 作品资料<span>已显示 {{ items.length }} 部</span><time :datetime="result.updatedAt">更新于 {{ new Date(result.updatedAt).toLocaleString() }}{{ result.cached ? ' · 缓存' : '' }}</time></p><button v-if="result.hasMore" type="button" class="book-more" :disabled="loading" @click="load(false, true)">{{ loading ? '正在加载…' : '加载更多' + typeName }}<AppIcon name="arrow" :size="15" /></button><span v-else class="book-end">这一页的故事，慢慢挑。</span></footer>
    </section>

    <section v-if="saved.length" class="book-shelf" :aria-label="'已收藏的' + typeName"><header class="book-section-heading"><div><p class="book-kicker">YOUR BOOKSHELF</p><h2>接着读，故事还在这里<small>已收藏的{{ typeName }}</small></h2></div><RouterLink :to="{ path: '/library', query: { type } }">查看书架 <AppIcon name="arrow" :size="15" /></RouterLink></header><div class="book-wall"><MediaCard v-for="media in saved.slice(0, 6)" :key="media.id" :media="media" :saved="true" @toggle-save="emit('toggle-save', $event)" /></div></section>
    <aside v-else class="book-shelf-hint"><AppIcon name="manga" :size="20" /><p>遇到喜欢的{{ typeName }}，点 <strong>＋</strong> 收进书架，下次接着看。</p><RouterLink :to="{ path: '/resources', query: { type } }">寻找章节资源 <AppIcon name="arrow" :size="15" /></RouterLink></aside>
  </div>
</template>

<style scoped>
.book-discovery{--book-accent:#8771b1;--book-ink:#453850;--book-soft:#f1ebf8}.book-discovery.novel{--book-accent:#8f6b99;--book-soft:#f5edf5}.book-intro{display:flex;align-items:center;justify-content:space-between;gap:24px;margin:0 0 23px}.book-kicker{font-size:10px;letter-spacing:1.7px;font-weight:650;color:#a28bb4;margin:0 0 8px}.book-intro h2{font-size:25px;letter-spacing:-.5px;line-height:1.4;color:var(--book-ink);margin:0 0 9px}.book-intro-copy{font-size:13px;line-height:1.7;color:#85748f;margin:0}.book-search-link{display:inline-flex;align-items:center;gap:13px;white-space:nowrap;text-decoration:none;font-size:13px;color:#80669b;border:1px solid #e1d7ec;border-radius:9px;padding:12px 15px;background:#ffffff96}.book-spotlight{min-height:330px;position:relative;isolation:isolate;overflow:hidden;border:1px solid #e6dced;background:var(--book-soft);border-radius:20px;display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:36px;padding:30px 42px;margin-bottom:33px;box-shadow:0 8px 25px #52316008}.book-backdrop{position:absolute;inset:-40% -5% -40% 40%;filter:blur(25px);opacity:.23;z-index:-2;transform:rotate(-8deg)}.book-backdrop :deep(img){object-fit:cover;object-position:50% 38%}.book-spotlight:after{position:absolute;inset:0;z-index:-1;content:'';background:linear-gradient(100deg,var(--book-soft) 10%,#f7f2fae8 44%,#f5edf675 100%)}.book-feature-copy{align-self:center;min-width:0}.book-feature-kicker{font-size:11px;font-weight:600;color:var(--book-accent)}.book-feature-kicker>span{padding:0 6px;color:#c0a9ca}.book-feature-copy h2{font-size:30px;line-height:1.35;letter-spacing:-.6px;color:var(--book-ink);margin:12px 0 6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.book-original{font-size:12px;color:#9a85a5;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.book-feature-meta{display:flex;gap:14px;align-items:center;font-size:12px;color:#99839f;margin:15px 0 0}.book-feature-meta strong{font-weight:600;color:#ac7d68}.book-feature-meta span+span{padding-left:14px;border-left:1px solid #d9cce0}.book-description{font-size:13px;line-height:1.85;max-width:620px;color:#816e8a;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:14px 0}.book-tags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 15px}.book-tags>span{font-size:10px;padding:4px 8px;background:#ffffff80;border:1px solid #e3d8e9;border-radius:5px;color:#9c80aa}.book-feature-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.book-open,.book-wish{border-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:11px;padding:11px 17px;font-size:12px;text-decoration:none;cursor:pointer;border:1px solid transparent}.book-open{background:var(--book-accent);color:white;box-shadow:0 4px 10px #76569318}.book-wish{background:#ffffff8c;border-color:#dbcee6;color:#886d9c}.book-wish:disabled{opacity:.6;cursor:wait}.book-picks{display:flex;gap:4px;margin-top:15px}.book-picks>button{padding:5px 9px;font-size:10px;color:#ad99b7;border:0;border-radius:5px;background:none;cursor:pointer;min-height:27px}.book-picks>button.active{background:#ffffff9c;color:var(--book-accent);font-weight:700}.book-feature-covers{position:relative;align-self:center;justify-self:center;width:192px;padding:5px 0 23px}.book-cover-shadow{position:absolute;inset:14px -13px 31px 10px;border-radius:9px;background:linear-gradient(130deg,#d8c5e7,#c4b1d3);transform:rotate(6deg);box-shadow:0 5px 12px #49335a19}.book-feature-cover{display:block;position:relative;width:192px;aspect-ratio:2/2.9;border-radius:9px;overflow:hidden;box-shadow:0 12px 25px #38204b27;transform:rotate(-3deg);transition:transform .2s}.book-feature-cover:hover{transform:rotate(0) translateY(-3px)}.book-cover-caption{position:absolute;left:0;right:0;text-align:center;bottom:0;font-size:8px;letter-spacing:2.2px;color:#9a80a6}.book-catalog,.book-shelf{margin:0 0 32px}.book-section-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:20px}.book-section-heading .book-kicker{font-size:9px;letter-spacing:1.4px;margin-bottom:6px}.book-section-heading h2{font-size:19px;color:var(--book-ink);margin:0;display:flex;align-items:center;gap:15px}.book-section-heading h2:before{content:'';width:4px;height:17px;background:#b6a1d0;border-radius:4px}.book-section-heading h2 small{font-size:11px;color:#a495ad;font-weight:400}.book-catalog-actions{display:flex;gap:9px;align-items:center}.book-catalog-actions select{font:inherit;font-size:12px;border:1px solid #e1d7eb;border-radius:8px;padding:10px 27px 10px 12px;background:#fff;color:#7b658e;max-width:180px}.book-refresh{font:inherit;font-size:12px;color:#8a719f;border:1px solid #e1d7eb;background:#fff;border-radius:8px;display:inline-flex;align-items:center;gap:6px;padding:10px 12px;cursor:pointer}.book-refresh:disabled,.book-more:disabled{opacity:.6;cursor:wait}.book-wall{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:25px 18px}.book-catalog-footer{display:flex;align-items:center;justify-content:space-between;margin-top:24px;gap:18px;border-top:1px solid #e9e2ef;padding-top:18px}.book-catalog-footer>p{font-size:10px;color:#a395ad;margin:0;display:flex;gap:12px;flex-wrap:wrap}.book-catalog-footer>p>span{border-left:1px solid #e0d7e6;padding-left:12px}.book-more{font:inherit;font-size:12px;color:#806596;border:1px solid #dcd0e7;background:#fff;border-radius:8px;padding:10px 18px;display:inline-flex;align-items:center;justify-content:center;gap:13px;cursor:pointer;white-space:nowrap}.book-end{font-size:11px;color:#b4a4be}.book-shelf{border-top:1px solid #e9e2ef;padding-top:27px}.book-section-heading>a{font-size:12px;color:#9c83ad;text-decoration:none;display:inline-flex;align-items:center;gap:8px;white-space:nowrap}.book-shelf-hint{display:flex;align-items:center;gap:13px;padding:17px 20px;border:1px solid #e8e0ee;background:#fbf8fdf0;border-radius:11px;color:#a18aaf}.book-shelf-hint>p{font-size:12px;line-height:1.6;margin:0;flex:1}.book-shelf-hint>a{display:inline-flex;gap:8px;align-items:center;font-size:12px;color:#9273a5;white-space:nowrap;text-decoration:none}.book-notice{font-size:12px;line-height:1.7;color:#a08261;background:#fff8ed;border:1px solid #efe2cd;padding:11px 15px;border-radius:8px;margin:0 0 17px}.book-error{font-size:12px;color:#ba6e86;display:flex;align-items:center;gap:15px;margin:0 0 17px}.book-error>button{border:0;background:none;color:#9b709e;font:inherit;cursor:pointer;text-decoration:underline;flex-shrink:0}.book-empty{padding:40px 25px;border:1px dashed #dfd2e8;border-radius:13px;text-align:center;background:#fcf9fe;color:#a68bb8}.book-empty>svg{display:block;margin:0 auto 14px}.book-empty h3{font-size:17px;font-weight:600;color:#896d9b;margin:0 0 10px}.book-empty p{font-size:12px;line-height:1.8;max-width:650px;margin:0 auto 20px}.book-empty>div{display:flex;justify-content:center;gap:20px;align-items:center}.book-empty a{font-size:12px;color:#9c80ad;text-decoration:none}.book-feature-skeleton{height:330px;border:1px solid #eee6f4;border-radius:20px;background:linear-gradient(110deg,#eee7f5,#faf7fc,#eee7f5);display:flex;justify-content:center;align-items:center;color:#9e86b0;font-size:13px;margin-bottom:33px}.book-poster-skeleton{aspect-ratio:2/3;border-radius:12px;background:linear-gradient(110deg,#eee8f3,#faf7fc,#eee8f3);animation:book-pulse 1.5s infinite alternate}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}@keyframes book-pulse{to{opacity:.5}}@media(max-width:1150px){.book-spotlight{grid-template-columns:minmax(0,1fr) 225px;gap:22px;padding:28px 32px}.book-wall{grid-template-columns:repeat(5,minmax(0,1fr));gap:23px 15px}.book-feature-copy h2{font-size:27px}.book-section-heading h2 small{display:none}}@media(max-width:900px){.book-wall{grid-template-columns:repeat(4,minmax(0,1fr))}.book-intro h2{font-size:22px}.book-intro-copy{font-size:12px}.book-spotlight{grid-template-columns:minmax(0,1fr) 180px;gap:24px;padding:26px}.book-feature-covers,.book-feature-cover{width:155px}.book-feature-copy h2{font-size:25px}.book-description{font-size:12px}.book-open,.book-wish{font-size:11px;padding:10px 12px}.book-tags{display:none}.book-feature-skeleton{height:315px}}@media(max-width:650px){.book-intro{gap:15px;align-items:flex-start}.book-intro h2{font-size:20px}.book-intro-copy{font-size:11px}.book-kicker{font-size:8px}.book-search-link{padding:9px;font-size:11px;gap:5px}.book-spotlight{padding:22px 20px;gap:15px;grid-template-columns:minmax(0,1fr) 110px;min-height:305px}.book-feature-copy h2{font-size:23px}.book-original{font-size:10px}.book-feature-meta{font-size:10px;gap:8px;margin-top:11px}.book-feature-meta span+span{padding-left:8px}.book-description{-webkit-line-clamp:3;font-size:11px}.book-feature-covers,.book-feature-cover{width:105px}.book-cover-caption{font-size:6px;letter-spacing:1px}.book-feature-actions{gap:7px}.book-open,.book-wish{font-size:10px;gap:5px;padding:9px}.book-picks{gap:0;margin-top:10px}.book-picks>button{padding:5px 7px}.book-section-heading{align-items:flex-start;gap:12px}.book-section-heading h2{font-size:17px;gap:8px}.book-catalog-actions{gap:5px}.book-catalog-actions select{font-size:11px;padding:9px 20px 9px 9px;max-width:115px}.book-refresh{padding:9px;font-size:11px;gap:4px}.book-wall{grid-template-columns:repeat(3,minmax(0,1fr));gap:21px 12px}.book-catalog-footer{align-items:flex-start}.book-catalog-footer>p{max-width:55%;font-size:9px;gap:6px}.book-catalog-footer>p>span{border:0;padding:0}.book-more{font-size:11px;padding:10px 12px;gap:7px}.book-end{font-size:10px;max-width:100px}.book-shelf-hint{flex-wrap:wrap;padding:15px;gap:10px}.book-shelf-hint>p{font-size:11px}.book-shelf-hint>a{margin-left:30px;font-size:11px}.book-feature-skeleton{height:305px}.book-empty>div{gap:13px}.book-section-heading>a{font-size:11px}.book-intro .book-kicker{letter-spacing:1px}}@media(prefers-reduced-motion:reduce){.book-feature-cover{transition:none}.book-poster-skeleton{animation:none}}
</style>
