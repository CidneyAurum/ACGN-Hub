<script setup lang="ts">
import { computed } from "vue";
import type { Media, MediaDetails } from "@/domain/media";
import type { Tracking, TrackingStatus } from "@/stores/tracking";
import { trackingLabels } from "@/stores/tracking";
import MediaPoster from "./MediaPoster.vue";

const props = defineProps<{ media: Media; details?: MediaDetails; saved: boolean; tracking: Tracking; busy?: boolean }>();
defineEmits<{ save: []; resources: []; status: [status: TrackingStatus]; advance: [] }>();
const labels = { anime: "动画", manga: "漫画", novel: "轻小说", visual_novel: "Galgame" };
const score = computed(() => {
  const raw = props.media.metadata.raw as { rating?: { score?: number } } | undefined;
  return props.details?.rating?.score ?? (typeof props.media.metadata.rating === "number" ? props.media.metadata.rating : raw?.rating?.score);
});
const summary = computed(() => props.details?.summary || props.media.description || "这部作品的简介尚未补全，可以先收藏，或查看来源中的资源。");
const episodeLabel = computed(() => props.media.type === "visual_novel" ? "进度" : props.media.type === "novel" ? "章" : "集");
</script>

<template>
  <section class="subject-hero">
    <div v-if="media.coverUrl" class="subject-backdrop" aria-hidden="true"><MediaPoster :src="media.coverUrl" alt="" loading="eager" /></div><div class="subject-backdrop-wash"></div>
    <div class="subject-hero-body">
      <div class="subject-large-poster"><MediaPoster :src="media.coverUrl" :alt="media.title + ' 封面'" loading="eager" /></div>
      <div class="subject-hero-copy"><div class="subject-meta-line"><span>{{ labels[media.type] }}</span><span v-if="media.releaseYear">{{ media.releaseYear }}</span><span v-if="details?.episodes">全 {{ details.episodes }} 话</span><span v-if="media.id.startsWith('source:')">来源作品</span></div><h1>{{ media.title }}</h1><p v-if="media.originalTitle && media.originalTitle !== media.title" class="subject-native-title">{{ media.originalTitle }}</p>
        <div v-if="score" class="subject-hero-rating"><strong>{{ score.toFixed(1) }}</strong><span>★<small>{{ details?.rating?.count ? details.rating.count.toLocaleString() + ' 人评分' : '作品评分' }}</small></span></div>
        <p class="subject-hero-summary">{{ summary }}</p>
        <div v-if="details?.tags.length" class="subject-hero-tags"><span v-for="tag in details.tags.slice(0, 5)" :key="tag">{{ tag }}</span></div>
        <div class="subject-hero-actions"><button class="subject-find-button" type="button" @click="$emit('resources')">查找资源 <span>↗</span></button><button class="subject-save-button" :class="{ saved }" :disabled="busy" type="button" @click="$emit('save')">{{ saved ? '♥ 已收藏' : '♡ 收藏作品' }}</button><select :value="saved ? tracking.status : ''" :disabled="busy" aria-label="追番状态" @change="$emit('status', ($event.target as HTMLSelectElement).value as TrackingStatus)"><option v-if="!saved" value="" disabled>加入追番…</option><option v-for="(label, value) in trackingLabels" :key="value" :value="value">{{ label }}</option></select></div>
        <div v-if="saved" class="subject-tracking"><span>已{{ media.type === 'novel' || media.type === 'manga' ? '读' : '看' }} {{ tracking.episode }}{{ tracking.total || details?.episodes ? ' / ' + (tracking.total || details?.episodes) : '' }} {{ episodeLabel }}</span><button :disabled="busy || (!!tracking.total && tracking.episode >= tracking.total)" type="button" @click="$emit('advance')">标记下一{{ episodeLabel }} <span>＋</span></button></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.subject-hero{position:relative;isolation:isolate;border-radius:19px;overflow:hidden;margin:0 0 28px;background:#f1edf6;min-height:360px}.subject-backdrop{position:absolute;inset:-90px -30px -100px 20%;z-index:-2;filter:blur(36px);opacity:.26;transform:scale(1.13)}.subject-backdrop :deep(.media-poster){height:100%;aspect-ratio:auto}.subject-backdrop-wash{position:absolute;inset:0;background:linear-gradient(90deg,#f5f1f9 12%,#f5f1f9c9 50%,#f6f2f98c);z-index:-1}.subject-hero-body{position:relative;display:grid;grid-template-columns:185px minmax(0,1fr);gap:30px;padding:32px}.subject-large-poster{aspect-ratio:2/2.92;align-self:start;overflow:hidden;border-radius:12px;box-shadow:0 8px 24px #4833581a}.subject-large-poster :deep(.media-poster){height:100%}.subject-hero-copy{min-width:0;padding:2px 0}.subject-meta-line{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:10px;color:#a995b9}.subject-meta-line span+span:before{content:'·';margin-right:10px;color:#c4b5cf}.subject-hero h1{font-size:clamp(23px,2.4vw,34px);line-height:1.4;letter-spacing:-.7px;color:#483552;margin:9px 0 8px;font-weight:700;overflow-wrap:anywhere}.subject-native-title{font-size:11px;color:#a58fac;margin-bottom:13px;line-height:1.6}.subject-hero-rating{display:flex;gap:10px;align-items:center;margin:9px 0 13px;color:#c59185}.subject-hero-rating strong{font-size:29px;line-height:1;font-weight:650;letter-spacing:-1px}.subject-hero-rating>span{display:grid;gap:3px;font-size:12px}.subject-hero-rating small{font-size:9px;color:#aa93a8}.subject-hero-summary{color:#8d7a98;font-size:12px;line-height:1.9;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;max-width:750px}.subject-hero-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.subject-hero-tags span{font-size:9px;color:#a38ab3;background:#ffffff80;border:1px solid #e8dfee;padding:3px 7px;border-radius:5px}.subject-hero-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:21px}.subject-hero-actions button,.subject-hero-actions select{font-size:11px;padding:11px 17px;border-radius:8px;cursor:pointer;white-space:nowrap}.subject-find-button{border:0;background:#9a80c3;color:white;box-shadow:0 3px 11px #8063a323}.subject-find-button span{margin-left:23px}.subject-save-button{border:1px solid #dfd2e8;background:#fff9;color:#a68ab8}.subject-save-button.saved{border-color:#edcddc;background:#fff0f6;color:#c886a3}.subject-hero-actions select{width:auto;border:1px solid #dfd3e8;background:#ffffff70;color:#a18cae;box-shadow:none;padding-right:27px}.subject-tracking{display:flex;align-items:center;gap:16px;margin-top:15px;font-size:10px;color:#aa93b7}.subject-tracking button{font-size:10px;border:0;background:transparent;color:#9b7db5;padding:3px 0}.subject-tracking button span{margin-left:7px}button:disabled,select:disabled{opacity:.5;cursor:not-allowed}@media(max-width:800px){.subject-hero-body{grid-template-columns:150px 1fr;padding:24px;gap:23px}.subject-hero-actions{gap:7px}.subject-hero-actions button,.subject-hero-actions select{padding:9px 12px}.subject-find-button span{margin-left:8px}}@media(max-width:580px){.subject-hero-body{grid-template-columns:100px minmax(0,1fr);padding:20px;gap:17px}.subject-hero-copy{display:contents}.subject-large-poster{grid-row:1/5}.subject-meta-line,.subject-hero h1,.subject-native-title,.subject-hero-rating{grid-column:2;margin:0}.subject-hero h1{font-size:21px}.subject-meta-line{font-size:9px}.subject-hero-summary,.subject-hero-tags,.subject-hero-actions,.subject-tracking{grid-column:1/-1}.subject-hero-summary{font-size:11px}.subject-hero-actions{margin-top:0}.subject-tracking{margin-top:0}.subject-backdrop{left:0}}
</style>
