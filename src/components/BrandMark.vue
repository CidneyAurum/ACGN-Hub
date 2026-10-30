<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 36 });
</script>

<template>
  <img
    class="brand-mark"
    src="/brand/acgn-mark.svg"
    :width="size"
    :height="size"
    alt=""
    aria-hidden="true"
    draggable="false"
  />
</template>

<style scoped>
.brand-mark {
  display: block;
  flex: 0 0 auto;
  object-fit: contain;
}
</style>
