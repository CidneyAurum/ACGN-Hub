<script setup lang="ts">
import { computed, onErrorCaptured, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import BrandMark from "@/components/BrandMark.vue";
import LegacyImportNotice from "@/components/LegacyImportNotice.vue";
import { useDownloadStore } from "@/stores/download";
import { useRuntimeStore } from "@/stores/runtime";
import { SETTINGS_CHANGED_EVENT } from "@/shared/settings";
import { needsBackgroundDownloadRefresh } from "@/shared/download-refresh";

const route = useRoute();
const router = useRouter();
const downloads = useDownloadStore();
const runtime = useRuntimeStore();
const globalKeyword = ref("");
const pageError = ref("");
const mainNav = [
  { path: "/", label: "发现", icon: "home", caption: "发现下一部好故事" },
  { path: "/library", label: "我的收藏", icon: "library", caption: "属于你的番剧与书架" },
  { path: "/resources", label: "找资源", icon: "search", caption: "从来源直接寻找作品" },
  { path: "/downloads", label: "下载", icon: "download", caption: "离线收藏的每一步" },
];
const toolNav = [
  { path: "/sources", label: "来源管理", icon: "source" },
  { path: "/feeds", label: "RSS 订阅", icon: "feed" },
  { path: "/organizer", label: "整理文件", icon: "organizer" },
  { path: "/manga", label: "漫画打包", icon: "manga" },
  { path: "/games", label: "Galgame 工具", icon: "games" },
];
const activeCount = computed(() => downloads.tasks.filter((task) => ["queued", "downloading"].includes(task.state)).length);
const pageTitle = computed(() => route.path.startsWith("/viewer/") ? "本地阅读与播放" : route.path.startsWith("/media/") ? "作品详情" : route.path === "/search" ? "搜索" : route.path === "/settings" ? "设置" : [...mainNav, ...toolNav].find((item) => item.path === route.path)?.label ?? "发现");
const navPath = computed(() => route.path.startsWith("/viewer/") ? "/downloads" : route.path === "/search" || route.path.startsWith("/media/") ? "/" : route.path);
const toolsOpen = ref(false);
watch(() => route.fullPath, () => { pageError.value = ""; if (toolNav.some((item) => item.path === route.path)) toolsOpen.value = true; });
onErrorCaptured((error) => { pageError.value = error instanceof Error ? error.message : "页面没有正确加载，请重试"; return false; });
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let pollGeneration = 0;
async function poll(generation: number): Promise<void> {
  if (stopped || generation !== pollGeneration || runtime.phase !== "ready") return;
  try { if (downloads.tasks.some(needsBackgroundDownloadRefresh)) await downloads.refreshAll(); }
  catch { /* The download page exposes the operation's error. */ }
  finally { if (!stopped && generation === pollGeneration && runtime.phase === "ready") timer = setTimeout(() => { void poll(generation); }, runtime.settings?.pollIntervalMs ?? 2500); }
}
function updatePolling(): void { pollGeneration += 1; if (timer) clearTimeout(timer); if (!stopped && runtime.phase === "ready") void poll(pollGeneration); }
watch(() => runtime.phase, updatePolling);
function onSettingsChanged(): void { runtime.reloadSettings(); updatePolling(); }
function search(): void {
  const keyword = globalKeyword.value.trim();
  if (!keyword) return;
  const contextType = typeof route.query.type === "string" && ["anime", "manga", "novel", "visual_novel"].includes(route.query.type) ? route.query.type : undefined;
  void router.push({ path: "/search", query: { q: keyword, ...(contextType ? { type: contextType } : {}) } });
}
function exportSettings(): void {
  const raw = localStorage.getItem("acgn-hub.settings.v1") ?? "";
  const link = document.createElement("a"); const url = URL.createObjectURL(new Blob([raw], { type: "application/json;charset=utf-8" }));
  link.href = url; link.download = "acgn-hub-settings-backup.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function rebuildSettings(): void {
  if (!window.confirm("重建设置会恢复默认目录和连接配置，不会删除作品、任务或本地文件。建议先导出当前设置。继续吗？")) return;
  const raw = localStorage.getItem("acgn-hub.settings.v1");
  if (raw !== null) localStorage.setItem("acgn-hub.settings.backup." + Date.now(), raw);
  localStorage.removeItem("acgn-hub.settings.v1"); void runtime.initialize();
}
onMounted(async () => { await runtime.initialize(); window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged); });
onUnmounted(() => { stopped = true; if (timer) clearTimeout(timer); window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged); });
</script>
<template>
  <div class="anime-shell workspace-shell">
    <aside class="anime-sidebar">
      <RouterLink class="anime-brand" to="/" aria-label="ACGN Hub 发现"><span class="anime-brand-mark"><BrandMark :size="36" /></span><span><b>ACGN<span>Hub</span></b><small>每一份热爱，都值得收藏</small></span></RouterLink>
      <nav class="anime-main-nav" aria-label="主导航"><RouterLink v-for="item in mainNav" :key="item.path" :to="item.path" :class="{ active: navPath === item.path }" :title="item.caption"><AppIcon :name="item.icon" :size="20" /><span>{{ item.label }}</span><small v-if="item.path === '/downloads' && activeCount">{{ activeCount }}</small></RouterLink></nav>
      <div class="anime-nav-separator"></div>
      <button class="anime-tools-toggle" :aria-expanded="toolsOpen" @click="toolsOpen = !toolsOpen"><span>更多工具</span><span>{{ toolsOpen ? '⌃' : '⌄' }}</span></button>
      <nav v-if="toolsOpen" class="anime-tool-nav" aria-label="更多工具"><RouterLink v-for="item in toolNav" :key="item.path" :to="item.path" :class="{ active: route.path === item.path }"><AppIcon :name="item.icon" :size="16" /><span>{{ item.label }}</span></RouterLink></nav>
      <div class="anime-sidebar-bottom"><div v-if="activeCount" class="sidebar-download-status"><span class="pulse-dot"></span><RouterLink to="/downloads">{{ activeCount }} 个活动任务</RouterLink></div><RouterLink to="/settings" class="anime-settings-link" :class="{ active: route.path === '/settings' }"><AppIcon name="settings" :size="19" /><span>设置</span><small>0.4.0</small></RouterLink><p>我的收藏 · 我的设备</p></div>
    </aside>
    <div class="anime-main">
      <header class="anime-topbar"><div class="anime-topbar-context"><span class="breadcrumb-home">我的空间</span><span>/</span><strong>{{ pageTitle }}</strong></div><form class="anime-global-search" @submit.prevent="search"><AppIcon name="search" :size="16" /><input v-model="globalKeyword" aria-label="全局搜索作品" placeholder="搜索番剧、漫画、轻小说…" /><kbd>↵</kbd></form><RouterLink class="anime-library-shortcut" to="/library" title="我的收藏">♡</RouterLink></header>
      <main id="main-content" class="anime-content workspace-content">
        <div v-if="runtime.phase === 'starting'" class="app-loading" role="status"><div class="app-loading-ring"></div><p>正在打开你的收藏空间…</p></div>
        <section v-else-if="runtime.phase === 'failed'" class="app-recovery" role="alert"><AppIcon name="warning" :size="32" /><h1>本地配置没有正确加载</h1><p>{{ runtime.startupError }}</p><div><button class="primary-button" @click="runtime.initialize()">重试</button><button class="ghost-button" @click="exportSettings">导出当前设置</button><button class="ghost-button" @click="rebuildSettings">重建设置</button></div></section>
        <template v-else>
          <div v-if="runtime.startupError" class="app-data-notice"><AppIcon name="warning" :size="16" /><span>{{ runtime.startupError }}</span><button @click="runtime.initialize()">重试读取</button></div>
          <LegacyImportNotice />
          <section v-if="pageError" class="app-recovery" role="alert"><h1>这个页面暂时没能打开</h1><p>{{ pageError }}</p><div><button class="primary-button" @click="pageError = ''">重新加载页面</button><RouterLink class="ghost-button" to="/">返回发现</RouterLink></div></section>
          <RouterView v-else />
        </template>
      </main>
      <footer class="anime-footer"><span>ACGN Hub <i>·</i> 为喜欢的故事留一个位置</span><span>作品资料来自 Bangumi / VNDB</span></footer>
    </div>
  </div>
</template>
<style scoped>
.anime-shell{display:flex;min-height:100vh;background:#f8f7fb;color:#514759;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}.anime-sidebar{position:fixed;inset:0 auto 0 0;width:187px;background:#fffefe;border-right:1px solid #eee9f2;display:flex;flex-direction:column;z-index:30}.anime-brand{display:flex;gap:9px;align-items:center;padding:31px 18px 38px;text-decoration:none;color:#51405e}.anime-brand-mark{height:36px;width:36px;flex-shrink:0;color:#c18dbe}.anime-brand-mark :deep(img){width:100%;height:100%}.anime-brand b{font-size:19px;letter-spacing:-.8px;font-weight:700}.anime-brand b>span{font-weight:450;color:#c0a3c7;margin-left:3px}.anime-brand small{display:block;color:#b8aabf;font-size:8px;margin-top:5px;letter-spacing:.4px}.anime-main-nav{display:flex;flex-direction:column;gap:7px;padding:0 15px}.anime-main-nav>a{display:flex;align-items:center;gap:12px;padding:13px 15px;color:#a297af;text-decoration:none;border-radius:10px;font-size:13px;transition:background .15s,color .15s}.anime-main-nav>a:hover{background:#fbf7fc;color:#ad87b1}.anime-main-nav>a.active{background:#f2eaf7;color:#9b7db3;font-weight:650}.anime-main-nav>a.active>svg{color:#b390c3}.anime-main-nav small{margin-left:auto;background:#eadcec;border-radius:5px;padding:2px 5px;font-size:9px}.anime-nav-separator{height:1px;background:#f2edf4;margin:27px 25px 16px}.anime-tools-toggle{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#baadbf;background:none;border:none;padding:0 29px;margin-bottom:12px;cursor:pointer}.anime-tool-nav{display:flex;flex-direction:column;gap:3px;padding:0 18px}.anime-tool-nav>a{display:flex;gap:10px;align-items:center;color:#b4a6ba;text-decoration:none;font-size:10px;padding:10px 12px;border-radius:7px}.anime-tool-nav>a:hover,.anime-tool-nav>a.active{background:#faf5fa;color:#b18ab4}.anime-sidebar-bottom{margin-top:auto;padding:22px 17px 18px}.anime-settings-link{display:flex;gap:11px;align-items:center;text-decoration:none;font-size:11px;padding:11px 13px;color:#ab9bb5;border-radius:8px}.anime-settings-link.active{background:#f5eef7;color:#ad83b2}.anime-settings-link small{margin-left:auto;font-size:8px;color:#cebfda}.anime-sidebar-bottom>p{text-align:center;font-size:8px;color:#d1c4da;margin:14px 0 0;letter-spacing:1px}.sidebar-download-status{display:flex;align-items:center;gap:7px;font-size:9px;margin-bottom:12px;padding:0 12px}.sidebar-download-status>a{text-decoration:none;color:#b79ac2}.pulse-dot{height:5px;width:5px;border-radius:50%;background:#cfa1c3;box-shadow:0 0 0 3px #faf0f7}.anime-main{margin-left:187px;width:calc(100% - 187px);display:flex;flex-direction:column;min-height:100vh;min-width:0}.anime-topbar{height:68px;min-height:68px;display:flex;align-items:center;gap:18px;padding:0 35px;background:#ffffffbe;border-bottom:1px solid #eee9f3}.anime-topbar-context{display:flex;gap:11px;align-items:center;font-size:10px;color:#c5b8ce;white-space:nowrap}.anime-topbar-context strong{font-weight:500;color:#8b759d;font-size:12px}.anime-global-search{margin-left:auto;display:flex;align-items:center;gap:9px;background:#f7f4fa;border:1px solid #ede7f2;border-radius:8px;padding:0 11px;width:270px;height:34px;color:#bdaccb}.anime-global-search input{font-size:12px;border:none!important;background:none!important;padding:0!important;height:100%;width:100%;outline:none!important;box-shadow:none!important;color:#927e9f;min-width:0}.anime-global-search input::placeholder{color:#c1b2cd}.anime-global-search kbd{font-family:inherit;font-size:9px;border:1px solid #e8dff0;padding:0 4px;border-radius:3px;color:#c7b7d1}.anime-library-shortcut{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#fcf1f6;color:#d9a3ba;font-size:22px;text-decoration:none;border:1px solid #f3e4ed}.anime-content{padding:29px 35px 35px;width:100%;max-width:1450px;box-sizing:border-box;flex:1;margin:0 auto}.anime-footer{padding:0 35px 18px;display:flex;justify-content:space-between;font-size:8px;color:#c8bcd3;gap:20px}.anime-footer i{font-style:normal;margin:0 6px}.app-loading{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:65vh;color:#b39bc2;font-size:12px;gap:14px}.app-loading-ring{width:27px;height:27px;border:2px solid #eee4f4;border-top-color:#ba96ce;border-radius:50%;animation:spin 1s linear infinite}.app-recovery{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 20px;min-height:60vh;color:#b59ac1}.app-recovery h1{font-size:21px;color:#9b78ad}.app-recovery p{font-size:12px;max-width:570px;line-height:1.9}.app-recovery>div{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:20px}.app-recovery a{text-decoration:none}.app-data-notice{display:flex;gap:9px;align-items:center;border:1px solid #f1e0c9;border-radius:8px;padding:12px;margin-bottom:18px;font-size:11px;color:#b99b7e;background:#fffaf3}.app-data-notice>button{margin-left:auto;background:none;border:0;color:#c09771;white-space:nowrap;cursor:pointer}@keyframes spin{to{transform:rotate(360deg)}}@media(min-width:1600px){.anime-sidebar{width:205px}.anime-main{margin-left:205px;width:calc(100% - 205px)}.anime-brand{padding-left:23px}.anime-main-nav{padding:0 20px}.anime-content{padding-top:35px}}@media(max-width:1000px){.anime-sidebar{width:167px}.anime-main{margin-left:167px;width:calc(100% - 167px)}.anime-brand{padding-left:14px}.anime-brand b{font-size:17px}.anime-brand small{font-size:7px}.anime-main-nav{padding:0 10px}.anime-content{padding:24px}.anime-topbar{padding:0 24px}.anime-footer{padding:0 24px 18px}}@media(max-width:700px){.anime-sidebar{width:63px}.anime-brand-mark{width:32px;height:32px}.anime-main{margin-left:63px;width:calc(100% - 63px)}.anime-brand{padding:22px 15px 28px}.anime-brand>span+span{display:none}.anime-main-nav{padding:0 8px}.anime-main-nav>a{justify-content:center;padding:13px 0}.anime-main-nav>a>span,.anime-main-nav small,.anime-tools-toggle,.anime-nav-separator,.anime-tool-nav{display:none}.anime-sidebar-bottom{padding:12px 7px}.anime-sidebar-bottom>p,.anime-settings-link>span,.anime-settings-link>small,.sidebar-download-status{display:none}.anime-settings-link{justify-content:center;padding:12px 0}.anime-topbar{padding:0 16px;height:57px;min-height:57px;gap:12px}.anime-topbar-context .breadcrumb-home,.anime-topbar-context>span:nth-child(2){display:none}.anime-global-search{width:100%;max-width:240px}.anime-global-search input{font-size:10px}.anime-global-search kbd,.anime-library-shortcut{display:none}.anime-content{padding:22px 16px}.anime-footer{padding:0 16px 17px;font-size:7px}.anime-footer>span+span{display:none}}
</style>
