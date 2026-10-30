<script setup lang="ts">
import { computed } from "vue";
import type { SourceConfig } from "@/domain/source";
import { getSourceUsage } from "@/infrastructure/sources/source-catalog";

const props = defineProps<{ config: SourceConfig; compact?: boolean }>();
const usage = computed(() => getSourceUsage(props.config));
</script>

<template>
  <div class="source-guide" :class="{ compact }">
    <div class="source-guide-tags"><span :class="'usage-' + usage.tier">{{ usage.label }}</span><span>{{ usage.format }}</span><span>{{ usage.language }}</span></div>
    <p>{{ usage.description }}</p>
    <span v-if="usage.requirements.length" class="source-guide-requirements">使用条件：{{ usage.requirements.join('；') }}</span>
  </div>
</template>

<style scoped>
.source-guide{margin-top:10px;max-width:760px}.source-guide-tags{display:flex;flex-wrap:wrap;gap:6px}.source-guide-tags>span{padding:4px 7px;border-radius:5px;background:#f1edf6;color:#7e6b96;font-size:10px;line-height:1.4}.source-guide-tags>span:first-child{background:#eae2f5;color:#77559f}.source-guide-tags>.usage-backup,.source-guide-tags>.usage-optional{background:#f2edf3;color:#89748b}.source-guide-tags>.usage-index{background:#f8eef2;color:#a3768c}.source-guide>p{font-size:12px;color:#887994;line-height:1.8;margin:9px 0 6px}.source-guide-requirements{display:block;font-size:11px;color:#9c8aa6;line-height:1.8}.source-guide.compact>p{font-size:11px}.source-guide.compact .source-guide-requirements{font-size:10px}
</style>
