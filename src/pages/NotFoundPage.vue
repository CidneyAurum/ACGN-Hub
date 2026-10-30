<script setup lang="ts">
import { useRouter } from "vue-router";
const router = useRouter();
</script>

<template>
  <section class="card empty-state page-not-found">
    <span class="not-found-code" aria-hidden="true">404</span>
    <h2>这个页面暂时找不到</h2>
    <p class="muted">地址可能已变更。你的收藏和下载记录仍可以从工作台继续访问。</p>
    <div class="form-footer"><RouterLink class="primary-button" to="/">返回工作台</RouterLink><button class="ghost-button" type="button" @click="router.back()">返回上一页</button></div>
  </section>
</template>
