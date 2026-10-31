<script lang="ts">
import { VndbProvider } from "@/infrastructure/metadata/vndb-provider";
const discoveryProvider = new VndbProvider();
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import MediaCard from "@/components/MediaCard.vue";
import MediaPoster from "@/components/MediaPoster.vue";
import type { Media } from "@/domain/media";
import { getMediaRating } from "@/domain/media-rating";
import type { VndbDiscoveryResult, VndbDiscoverySort } from "@/infrastructure/metadata/vndb-provider";
import { useSearchSessionStore } from "@/stores/search-session";

const props = defineProps<{
  sort: VndbDiscoverySort;
  saved: Media[];
  saving: Set<string>;
  isSaved: (id: string) => boolean;
}>();
const emit = defineEmits<{ "toggle-save": [media: Media]; "change-sort": [sort: VndbDiscoverySort] }>();
const session = useSearchSessionStore();
const items = ref<Media[]>([]);
const result = ref<VndbDiscoveryResult>();
const loading = ref(false);
const error = ref("");
const stale = ref(false);
const retryAppend = ref(false);
const picked = ref(0);
const highlights = computed(() => items.value.slice(0, 5));
const featured = computed(() => highlights.value[picked.value % Math.max(1, highlights.value.length)]);
const sortName = computed(() => props.sort === "recent" ? "近两年新作" : "中文可用佳作");
let generation = 0;
let disposed = false;
let timer: ReturnType<typeof setInterval> | undefined;
let lastAttemptAt = 0;
let lastDate = localDate();

watch(() => props.sort, () => {
  items.value = []; result.value = undefined; picked.value = 0; stale.value = false;
  void load();
}, { immediate: true });
onMounted(() => {
  timer = setInterval(refreshIfDue, 60_000);
  window.addEventListener("focus", refreshIfDue);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
  disposed = true; generation++;
  if (timer) clearInterval(timer);
  window.removeEventListener("focus", refreshIfDue);
  window.removeEventListener("online", onOnline);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
function localDate(): string { const date = new Date(); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; }
function onVisibilityChange(): void { if (!document.hidden) refreshIfDue(); }
function onOnline(): void {
  if (!loading.value && (!result.value || stale.value)) void load(true);
  else refreshIfDue();
}
function refreshIfDue(): void {
  if (disposed || loading.value || document.hidden || Date.now() - lastAttemptAt < 60_000) return;
  if (localDate() !== lastDate || !result.value || Date.now() - Date.parse(result.value.updatedAt) >= 30 * 60_000) void load(true);
}
async function load(refresh = false, append = false): Promise<void> {
  if (append && (loading.value || !result.value?.hasMore)) return;
  const request = ++generation;
  const sort = props.sort;
  const page = append ? (result.value?.page ?? 0) + 1 : 1;
  lastAttemptAt = Date.now(); lastDate = localDate();
  loading.value = true; error.value = ""; retryAppend.value = append;
  try {
    const next = await discoveryProvider.discover({ sort, page, refresh });
    if (disposed || request !== generation || sort !== props.sort) return;
    items.value = [...new Map([...(append ? items.value : []), ...next.items].map((media) => [media.id, media])).values()];
    result.value = next; stale.value = false;
    if (!append) picked.value = 0;
    session.remember(next.items.map((media) => ({ media, score: 100, reason: "exact" as const })));
  } catch (cause) {
    if (!disposed && request === generation) {
      error.value = cause instanceof Error ? cause.message : "Galgame 推荐暂时未能加载，请稍后重试。";
      stale.value = items.value.length > 0;
    }
  } finally { if (!disposed && request === generation) loading.value = false; }
}
function changeSort(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "rating" || value === "recent") emit("change-sort", value);
}
function remember(media: Media): void { session.remember([{ media, score: 100, reason: "exact" }]); }
function rating(media: Media): string { const score = getMediaRating(media); return score !== undefined && score > 0 ? score.toFixed(1) : "暂无评分"; }
</script>

<template>
  <div class="gal-discovery" aria-label="Galgame 发现">
    <section class="gal-intro"><div><p class="gal-kicker">A STORY ONLY YOU CAN CHOOSE</p><h2>下一次相遇，从选择开始。</h2><p>从中文可用的经典到近两年新作，挑一段想亲自走过的故事。</p></div><div class="gal-intro-actions"><RouterLink :to="{ path: '/search', query: { type: 'visual_novel' } }">搜索作品 <AppIcon name="search" :size="15" /></RouterLink><RouterLink :to="{ path: '/resources', query: { type: 'visual_novel' } }">寻找资源 <AppIcon name="arrow" :size="15" /></RouterLink></div></section>
    <section v-if="featured" class="gal-spotlight" aria-label="Galgame 精选">
      <div class="gal-backdrop" aria-hidden="true"><MediaPoster :src="featured.coverUrl" alt="" loading="eager" /></div>
      <div class="gal-feature-copy"><p class="gal-kicker">{{ sortName }} · VNDB</p><h2>{{ featured.title }}</h2><p v-if="featured.originalTitle && featured.originalTitle !== featured.title" class="gal-original">{{ featured.originalTitle }}</p><div class="gal-feature-meta"><strong>★ {{ rating(featured) }}</strong><span>{{ featured.releaseYear || '年份待定' }}</span><span>视觉小说</span></div><p class="gal-description">{{ featured.description?.replace(/\s+/g, ' ').trim() || '打开作品详情，了解故事、开发团队与登场人物，再选择适合自己的版本。' }}</p><div class="gal-feature-actions"><RouterLink class="gal-primary" :to="'/media/' + encodeURIComponent(featured.id)" @click="remember(featured)">探索这部作品 <AppIcon name="arrow" :size="16" /></RouterLink><button type="button" class="gal-secondary" :disabled="saving.has(featured.id)" @click="emit('toggle-save', featured)">{{ saving.has(featured.id) ? '保存中…' : isSaved(featured.id) ? '♥ 已收藏' : '＋ 加入想玩' }}</button></div><div class="gal-picks" aria-label="切换 Galgame 精选"><button v-for="(media, index) in highlights" :key="media.id" type="button" :class="{ active: picked === index }" :aria-pressed="picked === index" :aria-label="'精选：' + media.title" @click="picked = index">{{ String(index + 1).padStart(2, '0') }}</button></div></div>
      <RouterLink class="gal-feature-cover" :to="'/media/' + encodeURIComponent(featured.id)" :aria-label="'查看精选' + featured.title" @click="remember(featured)"><MediaPoster :src="featured.coverUrl" :alt="featured.title + ' 封面'" loading="eager" /></RouterLink>
    </section>
    <section class="gal-catalog" aria-label="Galgame 推荐封面墙">
      <header class="gal-section-heading"><div><p class="gal-kicker">YOUR NEXT ROUTE</p><h2>{{ sortName }}</h2></div><div class="gal-catalog-actions"><label><span class="sr-only">Galgame 推荐排序</span><select aria-label="Galgame 推荐排序" :value="sort" @change="changeSort"><option value="rating">中文可用佳作</option><option value="recent">近两年新作</option></select></label><button type="button" class="gal-refresh" :disabled="loading" aria-label="刷新 Galgame 推荐" @click="load(true)"><AppIcon name="refresh" :size="15" />{{ loading ? '更新中' : '刷新' }}</button></div></header>
      <p class="gal-catalog-note">{{ sort === 'recent' ? '按原作近两年发售日期排序，至少 5 人评分。' : '按 VNDB 评分排序，至少 50 人评分。' }}中文可用包含官方与民间翻译，版本、语言和获取条件请在资源入口核对。</p>
      <p v-if="stale && result" class="gal-notice" role="status">更新未完成，保留上次加载的目录。更新于 {{ new Date(result.updatedAt).toLocaleString() }}。</p>
      <p v-if="error && items.length" class="gal-error" role="alert">{{ error }}<button type="button" :disabled="loading" @click="load(false, retryAppend)">重试</button></p>
      <div v-if="loading && !items.length" class="gal-wall" role="status" aria-label="正在加载 Galgame 推荐"><div v-for="number in 12" :key="number" class="gal-poster-skeleton"></div></div>
      <div v-else-if="items.length" class="gal-wall"><MediaCard v-for="media in items" :key="media.id" :media="media" :saved="isSaved(media.id)" @toggle-save="emit('toggle-save', $event)" /></div>
      <div v-else class="gal-empty"><AppIcon :name="error ? 'warning' : 'games'" :size="30" /><h3>{{ error ? 'Galgame 推荐暂时未能加载' : '这个分类暂时没有作品' }}</h3><p>{{ error || '可以切换排序，也可以搜索喜欢的作品。' }}</p><div><button type="button" class="gal-primary" @click="load(true)">重新加载</button><RouterLink :to="{ path: '/search', query: { type: 'visual_novel' } }">搜索 Galgame →</RouterLink></div></div>
      <footer v-if="result && items.length" class="gal-catalog-footer"><p>VNDB 官方作品资料<span>已显示 {{ items.length }} 部</span><time :datetime="result.updatedAt">更新于 {{ new Date(result.updatedAt).toLocaleString() }}{{ result.cached ? ' · 缓存' : '' }}</time></p><button v-if="result.hasMore" type="button" class="gal-secondary" :disabled="loading" @click="load(false, true)">{{ loading ? '正在加载…' : '加载更多 Galgame' }}<AppIcon name="arrow" :size="15" /></button><span v-else class="gal-end">这一段旅程，慢慢挑。</span></footer>
    </section>
    <slot name="resources" />
    <section v-if="saved.length" class="gal-shelf" aria-label="已收藏的 Galgame"><header class="gal-section-heading"><div><p class="gal-kicker">YOUR PERSONAL ROUTES</p><h2>想玩的故事，收在这里</h2></div><RouterLink :to="{ path: '/library', query: { type: 'visual_novel' } }">查看收藏 <AppIcon name="arrow" :size="15" /></RouterLink></header><div class="gal-wall"><MediaCard v-for="media in saved.slice(0, 6)" :key="media.id" :media="media" :saved="true" @toggle-save="emit('toggle-save', $event)" /></div></section>
  </div>
</template>

<style scoped>
.gal-discovery{--gal-accent:#8572b5;--gal-ink:#4b3c5b}.gal-intro{display:flex;justify-content:space-between;align-items:center;gap:22px;margin-bottom:24px}.gal-kicker{font-size:10px;letter-spacing:1.6px;font-weight:650;color:#a38db7;margin:0 0 9px}.gal-intro h2{font-size:25px;letter-spacing:-.5px;color:var(--gal-ink);margin:0 0 9px}.gal-intro>div>p:last-child{color:#8d7e9a;font-size:13px;line-height:1.8;margin:0}.gal-intro-actions{display:flex;gap:9px;flex-shrink:0}.gal-intro-actions a,.gal-section-heading>a{display:inline-flex;gap:9px;align-items:center;font-size:12px;color:#8d72a3;text-decoration:none}.gal-intro-actions a{border:1px solid #e4daee;border-radius:9px;padding:11px 13px;background:#fff}.gal-spotlight{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) 215px;gap:40px;align-items:center;padding:32px 42px;min-height:315px;background:#f0eaf8;border:1px solid #e8dff1;border-radius:20px;margin-bottom:32px}.gal-backdrop{position:absolute;inset:-50% -5% -50% 32%;filter:blur(28px);opacity:.24;z-index:-2}.gal-spotlight:after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,#f1ebf9 12%,#f7f2fae8 53%,#eee6f38c);z-index:-1}.gal-feature-copy{min-width:0}.gal-feature-copy h2{font-size:29px;letter-spacing:-.5px;line-height:1.35;color:var(--gal-ink);margin:12px 0 7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.gal-original{font-size:12px;color:#a08baa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0}.gal-feature-meta{display:flex;gap:14px;align-items:center;font-size:12px;color:#a08aa9;margin-top:15px}.gal-feature-meta strong{color:#ad7d6b;font-weight:600}.gal-feature-meta span+span{padding-left:14px;border-left:1px solid #d8cce2}.gal-description{font-size:13px;line-height:1.85;color:#85728f;margin:14px 0 20px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.gal-feature-actions{display:flex;gap:10px;flex-wrap:wrap}.gal-primary,.gal-secondary{display:inline-flex;gap:10px;align-items:center;justify-content:center;padding:11px 16px;border:1px solid transparent;border-radius:8px;font:inherit;font-size:12px;text-decoration:none;cursor:pointer}.gal-primary{background:var(--gal-accent);color:white;box-shadow:0 4px 12px #6d4b8d15}.gal-secondary{background:#ffffffb5;border-color:#ded1e9;color:#8c70a0}.gal-picks{display:flex;gap:4px;margin-top:17px}.gal-picks button{border:0;border-radius:5px;background:none;color:#b19bbd;font-size:10px;padding:5px 9px;min-height:27px;cursor:pointer}.gal-picks button.active{background:#ffffffa0;color:var(--gal-accent);font-weight:700}.gal-feature-cover{display:block;width:190px;max-height:285px;aspect-ratio:2/2.9;justify-self:center;border-radius:10px;overflow:hidden;box-shadow:0 13px 30px #47305e25;transform:rotate(3deg);transition:transform .2s}.gal-feature-cover:hover{transform:rotate(0)}.gal-catalog,.gal-shelf{margin-bottom:32px}.gal-section-heading{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:14px}.gal-section-heading h2{font-size:19px;color:var(--gal-ink);margin:0;display:flex;gap:10px;align-items:center}.gal-section-heading h2:before{content:'';height:17px;width:4px;border-radius:4px;background:#b7a1d3}.gal-catalog-actions{display:flex;gap:9px;align-items:center}.gal-catalog-actions select,.gal-refresh{font:inherit;font-size:12px;color:#836897;border:1px solid #e1d7eb;border-radius:8px;padding:10px 12px;background:white}.gal-catalog-actions select{padding-right:26px}.gal-refresh{display:flex;gap:6px;align-items:center;cursor:pointer}.gal-catalog-note{font-size:12px;line-height:1.8;color:#a08cab;margin:0 0 20px;max-width:900px}.gal-wall{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:24px 18px}.gal-catalog-footer{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:24px;padding-top:18px;border-top:1px solid #e9e2ef}.gal-catalog-footer>p{display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:#a494af;margin:0}.gal-catalog-footer>p>span{padding-left:12px;border-left:1px solid #ded4e7}.gal-end{font-size:11px;color:#b4a3bd}.gal-notice{font-size:12px;line-height:1.7;color:#a28463;background:#fff8ed;border:1px solid #efe2cd;padding:11px 15px;border-radius:8px;margin:0 0 17px}.gal-error{font-size:12px;line-height:1.7;color:#b77991;display:flex;gap:12px;align-items:center}.gal-error button{border:0;background:none;text-decoration:underline;font:inherit;color:#9876a2;cursor:pointer}.gal-empty{padding:40px 25px;border:1px dashed #e1d4e9;border-radius:13px;text-align:center;background:#fcf9fe;color:#a78eb8}.gal-empty>svg{display:block;margin:0 auto 14px}.gal-empty h3{font-size:17px;font-weight:600;color:#886e9a;margin:0 0 10px}.gal-empty p{font-size:12px;line-height:1.8;margin:0 0 20px}.gal-empty>div{display:flex;justify-content:center;align-items:center;gap:20px}.gal-empty a{font-size:12px;color:#997ca9;text-decoration:none}.gal-poster-skeleton{aspect-ratio:2/2.9;border-radius:12px;background:linear-gradient(110deg,#ede7f2,#f8f5fb,#eee7f4);animation:gal-pulse 1.5s infinite alternate}.gal-shelf{border-top:1px solid #e9e2ef;padding-top:26px}.gal-shelf .gal-section-heading{margin-bottom:20px}button:disabled{opacity:.6;cursor:wait}button:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid #ac8dc6;outline-offset:3px}@keyframes gal-pulse{to{opacity:.55}}@media(max-width:1100px){.gal-wall{grid-template-columns:repeat(5,minmax(0,1fr))}.gal-spotlight{gap:24px;padding:30px}.gal-feature-copy h2{font-size:26px}.gal-intro{align-items:flex-start;flex-direction:column;gap:15px}}@media(max-width:800px){.gal-wall{grid-template-columns:repeat(4,minmax(0,1fr));gap:20px 14px}.gal-spotlight{grid-template-columns:minmax(0,1fr) 150px;gap:20px;padding:25px}.gal-feature-cover{width:145px}.gal-feature-copy h2{font-size:23px}.gal-description{font-size:12px}}@media(max-width:600px){.gal-intro h2{font-size:22px}.gal-intro-actions{width:100%}.gal-intro-actions>a{flex:1;justify-content:center}.gal-spotlight{grid-template-columns:minmax(0,1fr) 90px;gap:14px;padding:20px}.gal-feature-cover{width:90px}.gal-feature-copy h2{font-size:20px}.gal-feature-copy>.gal-kicker{font-size:9px}.gal-original{font-size:10px}.gal-feature-meta{font-size:10px;gap:8px}.gal-feature-meta span+span{padding-left:8px}.gal-description{font-size:11px;-webkit-line-clamp:3}.gal-feature-actions{gap:7px}.gal-primary,.gal-secondary{font-size:11px;padding:9px 11px}.gal-feature-cover{align-self:start;margin-top:30px}.gal-wall{grid-template-columns:repeat(3,minmax(0,1fr));gap:20px 11px}.gal-section-heading{align-items:flex-start;flex-direction:column;gap:13px}.gal-catalog-actions{width:100%}.gal-catalog-actions label{flex:1}.gal-catalog-actions select{width:100%}.gal-catalog-footer{align-items:flex-start;flex-direction:column}.gal-catalog-note{font-size:11px}.gal-section-heading h2{font-size:18px}}@media(prefers-reduced-motion:reduce){.gal-poster-skeleton{animation:none}.gal-feature-cover{transition:none}}
</style>
