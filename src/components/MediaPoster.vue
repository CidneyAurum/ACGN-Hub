<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { loadMediaImage, normalizeImageUrl } from "@/infrastructure/media/image-loader";
const props = withDefaults(defineProps<{ src?: string; alt?: string; loading?: "eager" | "lazy" }>(), { alt: "作品封面", loading: "lazy" });
const imageUrl = ref("");
const state = ref<"loading" | "loaded" | "error" | "empty">("loading");
const container = ref<HTMLElement>();
const image = ref<HTMLImageElement>();
const attempt = ref(0);
let generation = 0;
let timeout: ReturnType<typeof setTimeout> | undefined;
let direct = false;
let mounted = false;
let disposed = false;
let observer: IntersectionObserver | undefined;
function stopWaiting(): void {
  observer?.disconnect(); observer = undefined;
  if (timeout) clearTimeout(timeout);
  timeout = undefined;
}
async function prepare(refresh = false): Promise<void> {
  if (disposed) return;
  stopWaiting();
  const current = ++generation;
  attempt.value = current;
  imageUrl.value = ""; direct = false;
  const raw = props.src;
  if (!raw) { state.value = "empty"; return; }
  state.value = "loading";
  timeout = setTimeout(() => { if (current === generation && state.value === "loading") state.value = "error"; }, 25_000);
  try { const source = await loadMediaImage(raw, refresh); if (current === generation && !disposed) imageUrl.value = source; }
  catch { if (current === generation && !disposed) { direct = true; imageUrl.value = normalizeImageUrl(raw); } }
}
function currentImage(event: Event): boolean {
  return !disposed && event.currentTarget === image.value && image.value?.dataset.posterAttempt === String(generation);
}
function fail(event: Event): void {
  if (!currentImage(event)) return;
  if (!direct && props.src) {
    direct = true;
    const fallback = normalizeImageUrl(props.src);
    if (fallback !== imageUrl.value) { imageUrl.value = fallback; return; }
  }
  state.value = "error";
  if (timeout) clearTimeout(timeout);
}
function loaded(event: Event): void { if (currentImage(event)) { state.value = "loaded"; if (timeout) clearTimeout(timeout); } }
function schedule(): void {
  if (!props.src || disposed) return;
  if (props.loading === "eager") { void prepare(); return; }
  if (!mounted || !container.value) return;
  if (typeof IntersectionObserver === "undefined") { void prepare(); return; }
  const current = generation;
  try {
    observer = new IntersectionObserver((entries) => {
      if (disposed || current !== generation) return;
      if (entries.some((entry) => entry.target === container.value && entry.isIntersecting)) void prepare();
    }, { rootMargin: "240px 0px", threshold: 0 });
    observer.observe(container.value);
  } catch { observer?.disconnect(); observer = undefined; void prepare(); }
}
watch(() => [props.src, props.loading], () => {
  generation += 1; attempt.value = generation;
  stopWaiting(); imageUrl.value = ""; direct = false;
  state.value = props.src ? "loading" : "empty";
  schedule();
}, { immediate: true });
onMounted(() => { mounted = true; if (props.loading !== "eager") schedule(); });
onBeforeUnmount(() => { disposed = true; generation += 1; stopWaiting(); });
</script>
<template>
  <span ref="container" class="media-poster" :class="'poster-' + state">
    <img v-if="imageUrl" :key="attempt + ':' + imageUrl" ref="image" :data-poster-attempt="attempt" :src="imageUrl" :alt="alt" :loading="loading" referrerpolicy="no-referrer" @load="loaded" @error="fail" />
    <span v-if="state === 'loading'" class="poster-shimmer" aria-label="封面加载中"></span>
    <span v-else-if="state === 'error' || state === 'empty'" class="poster-fallback"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="3" width="22" height="26" rx="4" /><path d="m10 22 5-6 4 4 3-3M21 10h.01" /></svg><span>{{ state === 'empty' ? '暂无封面' : '封面暂不可用' }}</span><button v-if="state === 'error'" type="button" @click.stop.prevent="prepare(true)">重新加载</button></span>
  </span>
</template>
<style scoped>
.media-poster{display:block;position:relative;width:100%;height:100%;overflow:hidden;background:#eeedf3;border-radius:inherit;isolation:isolate}.media-poster img{display:block;width:100%;height:100%;object-fit:cover;transition:opacity .25s}.poster-loading img{opacity:0}.poster-error img{display:none}.poster-shimmer{position:absolute;inset:0;background:linear-gradient(100deg,#efedf5 20%,#faf9fc 45%,#efedf5 70%);background-size:230% 100%;animation:poster-shimmer 1.7s infinite}.poster-fallback{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:9px;color:#a49bb3;font-size:11px;background:linear-gradient(150deg,#f0ecf6,#e8eaf3)}.poster-fallback svg{width:32px;fill:none;stroke:currentColor;stroke-width:1.5}.poster-fallback button{border:0;border-radius:5px;background:#ffffffb3;color:#8b789e;font-size:10px;padding:5px 8px;cursor:pointer}@keyframes poster-shimmer{to{background-position:-230% 0}}@media(prefers-reduced-motion:reduce){.poster-shimmer{animation:none}}
</style>
