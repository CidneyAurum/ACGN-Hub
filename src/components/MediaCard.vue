<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { Media } from "@/domain/media";
import { getMediaRating } from "@/domain/media-rating";
import MediaPoster from "./MediaPoster.vue";
import { useSearchSessionStore } from "@/stores/search-session";
const props = withDefaults(defineProps<{ media: Media; saved?: boolean; showSave?: boolean }>(), { saved: false, showSave: true });
defineEmits<{ "toggle-save": [media: Media] }>();
const session = useSearchSessionStore();
const destination = computed(() => "/media/" + encodeURIComponent(props.media.id));
const rating = computed(() => getMediaRating(props.media));
const typeLabels = { anime: "动画", manga: "漫画", novel: "轻小说", visual_novel: "Galgame" };
function remember(): void { session.remember([{ media: props.media, score: 100, reason: "exact" }]); }
</script>
<template>
  <article class="subject-card media-card">
    <RouterLink class="subject-cover-link media-cover" :to="destination" :aria-label="'查看' + media.title" @click="remember">
      <MediaPoster :src="media.coverUrl" :alt="media.title + ' 封面'" />
      <span v-if="rating && rating > 0" class="subject-score">★ {{ rating.toFixed(1) }}</span>
      <span class="subject-type">{{ typeLabels[media.type] }}</span>
      <span class="subject-hover-action">查看作品 <span>↗</span></span>
    </RouterLink>
    <button v-if="showSave" class="subject-save" :class="{ saved }" :aria-label="(saved ? '取消收藏' : '收藏') + media.title" type="button" @click="$emit('toggle-save', media)">{{ saved ? '♥' : '+' }}</button>
    <RouterLink class="subject-name" :to="destination" @click="remember">{{ media.title }}</RouterLink>
    <div class="subject-caption"><slot name="footer"><span>{{ media.releaseYear || '年份未定' }}</span><span>{{ media.originalTitle && media.originalTitle !== media.title ? media.originalTitle : typeLabels[media.type] }}</span></slot></div>
  </article>
</template>
<style scoped>
.subject-card.media-card{position:relative;border:none!important;background:none!important;box-shadow:none!important;border-radius:0!important;overflow:visible!important;min-width:0;display:block!important}.subject-cover-link.media-cover{display:block;position:relative;height:auto!important;width:100%;aspect-ratio:2/2.9;border-radius:13px;overflow:hidden;background:#ece9f2;text-decoration:none;box-shadow:0 4px 13px #3423420c;transition:transform .2s,box-shadow .2s}.subject-cover-link:hover{transform:translateY(-4px);box-shadow:0 10px 25px #34234220}.subject-score{position:absolute;top:8px;left:8px;padding:4px 6px;border-radius:5px;background:#26203799;backdrop-filter:blur(8px);color:#fff6d2;font-size:10px;font-weight:650}.subject-type{position:absolute;bottom:9px;left:9px;color:#fff;font-size:10px;background:#1c152f66;backdrop-filter:blur(6px);padding:3px 6px;border-radius:4px}.subject-hover-action{position:absolute;inset:auto 0 0;display:flex;justify-content:space-between;padding:28px 12px 12px;font-size:11px;color:white;background:linear-gradient(transparent,#30233cbf);opacity:0;transition:opacity .2s}.subject-cover-link:hover .subject-hover-action{opacity:1}.subject-cover-link:hover .subject-type{opacity:0}.subject-save{position:absolute;top:8px;right:8px;width:27px;height:27px;border-radius:50%;background:#fffdf5f2;border:0;box-shadow:0 2px 6px #30233c16;color:#685678;font-size:19px;display:grid;place-items:center;line-height:1;opacity:0;transition:opacity .2s;cursor:pointer}.subject-card:hover .subject-save,.subject-save:focus-visible,.subject-save.saved{opacity:1}.subject-save.saved{background:#fff0f5;color:#ee7095;font-size:13px}.subject-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:11px 0 5px;font-size:13px;line-height:1.55;font-weight:600;text-decoration:none;color:#3b3549;min-height:20px}.subject-name:hover{color:#c879a6}.subject-caption{display:flex;gap:6px;font-size:10px;color:#877c94;overflow:hidden;white-space:nowrap}.subject-caption>span+span{overflow:hidden;text-overflow:ellipsis;border-left:1px solid #ddd6e5;padding-left:6px}@media(max-width:700px){.subject-save{opacity:1}}
</style>
