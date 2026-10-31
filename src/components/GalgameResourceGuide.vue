<script setup lang="ts">
import { ref } from "vue";
import { RouterLink } from "vue-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useDownloadStore } from "@/stores/download";
import { isTauriRuntime } from "@/shared/runtime";
import { loadSettings } from "@/shared/settings";

const downloads = useDownloadStore();
const adding = ref(false);
const message = ref("");
const error = ref("");
const selections = [
  { title: "ATRI -My Dear Moments-", label: "免费试玩", language: "简体 / 繁体中文", note: "Windows · Steam 试玩版", url: "https://store.steampowered.com/app/1263470/" },
  { title: "千恋＊万花", label: "免费试玩", language: "简体 / 繁体中文", note: "Windows · Steam 试玩版", url: "https://store.steampowered.com/app/1221010/" },
  { title: "Narcissu 1st & 2nd", label: "免费完整发行", language: "英文 / 日文", note: "Windows / macOS / Linux · Steam", url: "https://store.steampowered.com/app/264380/" },
  { title: "Doki Doki Literature Club!", label: "免费原版", language: "英文", note: "Windows / macOS · Steam", url: "https://store.steampowered.com/app/698780/" },
];
async function openWebsite(url: string): Promise<void> {
  error.value = "";
  try {
    if (isTauriRuntime()) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "来源页面暂时无法打开，请稍后重试。"; }
}
async function downloadOriginal(): Promise<void> {
  if (adding.value) return;
  adding.value = true; error.value = ""; message.value = "";
  try {
    const settings = loadSettings();
    await downloads.add("https://stage-nana.sakura.ne.jp/download/naru2.lzh", settings.downloadDirectory || settings.incomingDirectory,
      { sourceName: "Stage-nana · 原厂免费发行", filename: "水仙2（Narcissu Side 2nd）- 日文原版.lzh" });
    message.value = "已加入下载中心。此文件是旧日文版，下载后需要使用支持 LZH 的工具解压，再添加到 Galgame 管理。";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "下载任务添加失败，请检查下载目录和引擎连接。"; }
  finally { adding.value = false; }
}
</script>

<template>
  <section class="gal-resource-guide" aria-label="Galgame 资源入口">
    <header><div><p class="guide-kicker">FIND YOUR NEXT STORY</p><h2>选择你需要的版本</h2><p>中文、平台、本体与补丁先分清，找到作品后再选择获取方式。</p></div><RouterLink to="/games">管理本地游戏 →</RouterLink></header>
    <div class="gal-source-paths">
      <RouterLink :to="{ path: '/resources', query: { type: 'visual_novel', provider: 'kungal' } }"><span>01 / 中文社区</span><h3>鲲 Galgame</h3><p>按作品查找游戏本体、补丁与不同平台版本，核对网盘和运行方式。</p><strong>查社区资源 ↗</strong></RouterLink>
      <RouterLink :to="{ path: '/resources', query: { type: 'visual_novel', provider: 'vndb_release' } }"><span>02 / 官方发行</span><h3>官网、商店与试玩</h3><p>读取 VNDB 发行记录，中文版本优先；免费、试玩和付费发行分别标明。</p><strong>查官方发行 ↗</strong></RouterLink>
    </div>
    <div class="gal-examples-heading"><h3>先从这些官方版本开始</h3><span>试玩只含体验内容 · 商店可能受地区限制</span></div>
    <div class="gal-official-grid">
      <a v-for="item in selections" :key="item.url" :href="item.url" target="_blank" rel="noopener noreferrer" @click.prevent="openWebsite(item.url)"><span class="gal-edition-badge">{{ item.label }}</span><h4>{{ item.title }}</h4><p>{{ item.language }}</p><small>{{ item.note }}</small><strong>打开商店 ↗</strong></a>
    </div>
    <div class="gal-original-download"><div><span class="gal-edition-badge">原厂文件直链</span><h3>Narcissu 2nd · 日文原版</h3><p>约 269 MiB · Windows · LZH 压缩包。保留原厂 2007 年版本，需自行解压；新版跨平台发行可使用上方 Steam 入口。</p><a href="https://stage-nana.sakura.ne.jp/down.htm" target="_blank" rel="noopener noreferrer" @click.prevent="openWebsite('https://stage-nana.sakura.ne.jp/down.htm')">查看原厂下载说明 ↗</a></div><button type="button" :disabled="adding" @click="downloadOriginal">{{ adding ? '正在添加…' : '下载日文原版' }} <span>↓</span></button></div>
    <p v-if="message" class="gal-guide-message" role="status">{{ message }} <RouterLink to="/downloads">查看下载 →</RouterLink></p>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <p class="gal-guide-footnote">更多中文发行可查看 <a href="https://store.hikarifield.co.jp/" target="_blank" rel="noopener noreferrer" @click.prevent="openWebsite('https://store.hikarifield.co.jp/')">HIKARI FIELD 商店 ↗</a>。网盘、官网和商店会在浏览器打开，文件直链使用内置下载器；安装后的游戏可加入本地管理。</p>
  </section>
</template>

<style scoped>
.gal-resource-guide{margin:28px 0 36px;color:#5f4c70}.gal-resource-guide>header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:20px}.guide-kicker{font-size:9px;letter-spacing:2px;color:#a58fb9;margin:0 0 8px}.gal-resource-guide h2{font-size:20px;margin:0 0 8px;letter-spacing:-.3px}.gal-resource-guide>header>div>p:last-child{font-size:12px;color:#95869f;line-height:1.8;margin:0}.gal-resource-guide>header>a{font-size:12px;white-space:nowrap;color:#9072a7;text-decoration:none}.gal-source-paths{display:grid;grid-template-columns:1fr 1fr;gap:16px}.gal-source-paths>a{display:block;padding:24px 25px;background:linear-gradient(125deg,#faf6ff,#fff);border:1px solid #e6ddef;border-radius:14px;text-decoration:none;color:inherit;transition:border-color .2s}.gal-source-paths>a:hover,.gal-official-grid>a:hover{border-color:#b69bce}.gal-source-paths>a>span{color:#aa90be;font-size:10px;letter-spacing:.6px}.gal-source-paths h3{font-size:18px;margin:11px 0 9px}.gal-source-paths p{font-size:12px;color:#95879f;line-height:1.9;margin:0 0 18px}.gal-source-paths strong{font-size:12px;color:#9371ad;font-weight:550}.gal-examples-heading{display:flex;justify-content:space-between;gap:16px;align-items:center;margin:26px 0 14px}.gal-examples-heading h3{font-size:14px;margin:0}.gal-examples-heading span{font-size:10px;color:#a191ac}.gal-official-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.gal-official-grid>a{display:flex;flex-direction:column;align-items:flex-start;padding:19px 17px;background:#fff;border:1px solid #e9e0ef;border-radius:12px;color:inherit;text-decoration:none;transition:border-color .2s}.gal-edition-badge{display:inline-block;background:#eee8f5;border-radius:5px;padding:4px 7px;color:#9473ab;font-size:9px}.gal-official-grid h4{font-size:14px;font-weight:600;line-height:1.7;margin:12px 0 10px}.gal-official-grid p{font-size:11px;color:#8e7a9b;margin:auto 0 6px}.gal-official-grid small{font-size:10px;color:#ac9bb8;line-height:1.8}.gal-official-grid strong{font-size:10px;font-weight:500;color:#9976b2;margin-top:18px}.gal-original-download{display:flex;align-items:center;gap:28px;justify-content:space-between;border:1px solid #e5ddeb;border-radius:12px;background:#f9f7fc;padding:22px;margin-top:16px}.gal-original-download h3{font-size:15px;margin:10px 0 6px}.gal-original-download p{font-size:11px;line-height:1.9;color:#9c8ca9;max-width:650px;margin:0 0 8px}.gal-original-download a{font-size:10px;color:#9b7ab1}.gal-original-download button{border:0;border-radius:8px;background:#9577b6;color:white;font-size:12px;white-space:nowrap;padding:12px 17px;cursor:pointer}.gal-original-download button:disabled{opacity:.55;cursor:wait}.gal-original-download button>span{margin-left:12px}.gal-guide-footnote,.gal-guide-message{font-size:11px;line-height:2;color:#a08eac;margin:15px 0 0}.gal-guide-footnote a,.gal-guide-message a{color:#9170a8}.gal-resource-guide a:focus-visible,.gal-resource-guide button:focus-visible{outline:3px solid #c0a4d5;outline-offset:3px}@media(max-width:950px){.gal-official-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:650px){.gal-source-paths{grid-template-columns:1fr}.gal-resource-guide>header,.gal-examples-heading,.gal-original-download{align-items:flex-start;flex-direction:column}.gal-original-download{gap:16px}.gal-resource-guide>header{gap:10px}.gal-official-grid{grid-template-columns:1fr 1fr}.gal-official-grid>a{padding:15px 12px}}
</style>
