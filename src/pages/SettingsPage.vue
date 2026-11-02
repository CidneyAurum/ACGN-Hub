<script setup lang="ts">
import { onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { loadSettings, loadSessionSecret, saveSessionSecret, saveSettings, loadSessionQbittorrentCredentials, saveSessionQbittorrentCredentials } from "@/shared/settings";
import { probeDownloadEngine } from "@/infrastructure/download/create-download-engine";
import { isAndroidRuntime, isTauriRuntime } from "@/shared/runtime";
import { assertDownloadDirectory, assertLocalEndpoint } from "@/shared/validation";
import thirdPartyNotices from "../../THIRD_PARTY_NOTICES.md?raw";
import androidComponentLicense from "../../third_party/android/Apache-2.0.txt?raw";

const settings = ref(loadSettings());
const android = isAndroidRuntime();
const licenseText = thirdPartyNotices + "\n\nAndroid components: Apache License 2.0\n" + androidComponentLicense;
const secret = ref(loadSessionSecret());
const qbitCredentials = ref(loadSessionQbittorrentCredentials());
const speedLimitKib = ref(Math.round(settings.value.speedLimitBytesPerSecond / 1024));
const saved = ref("");
const error = ref("");
const testing = ref("");
const connectionMessages = ref<Record<string, { ok: boolean; message: string }>>({});
const portableDirectory = ref("");
onMounted(async () => {
  if (!isTauriRuntime()) return;
  try { portableDirectory.value = (await invoke<{ dataDirectory: string } | null>("get_portable_profile"))?.dataDirectory ?? ""; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "无法读取便携资料目录"; }
});
type DirectoryKey = "incomingDirectory" | "libraryDirectory" | "obsidianEbookDirectory" | "backupDirectory" | "downloadDirectory";
const directories: Array<{ key: DirectoryKey; title: string; description: string }> = [
  { key: "incomingDirectory", title: "待整理目录", description: "下载的中转位置；整理只会从这个目录内移动文件。" },
  { key: "libraryDirectory", title: "作品库目录", description: "按作品与类型归档，文件索引从这里扫描。" },
  { key: "obsidianEbookDirectory", title: "电子书输出目录", description: "漫画 CBZ 和小说 TXT 的保存位置，也可选 Obsidian 阅读目录。" },
  { key: "backupDirectory", title: "游戏存档备份目录", description: "每次备份创建独立目录，保留已有备份。" },
  { key: "downloadDirectory", title: "自定义下载目录（可选）", description: "留空使用待整理目录；放在待整理目录之外的文件需要手动管理。" },
];

function storeSessionCredentials(): void {
  saveSessionSecret(secret.value.trim());
  saveSessionQbittorrentCredentials(qbitCredentials.value);
}

function submit(): void {
  saved.value = "";
  error.value = "";
  try {
    for (const directory of directories) {
      if (directory.key === "downloadDirectory" && !settings.value[directory.key].trim()) continue;
      settings.value[directory.key] = assertDownloadDirectory(settings.value[directory.key]);
    }
    if (settings.value.incomingDirectory.replace(/[\\/]+$/, "").toLowerCase() === settings.value.libraryDirectory.replace(/[\\/]+$/, "").toLowerCase()) {
      throw new Error("待整理目录和作品库目录需要分别设置，以免重复扫描和整理。");
    }
    if (!android) {
      validateEndpoint(settings.value.aria2Endpoint, "aria2");
      validateEndpoint(settings.value.qbittorrentEndpoint, "qBittorrent");
    }
    settings.value.maxConcurrentDownloads = clampNumber(settings.value.maxConcurrentDownloads, 1, android ? 3 : 20, 3);
    speedLimitKib.value = clampNumber(speedLimitKib.value, 0, 1024 * 1024, 0);
    settings.value.speedLimitBytesPerSecond = speedLimitKib.value * 1024;
    settings.value.pollIntervalMs = clampNumber(settings.value.pollIntervalMs, 1000, 60000, 2500);
    if (!android) storeSessionCredentials();
    saveSettings(settings.value);
    saved.value = android ? "设置已保存。文件保存在应用内，可在下载页直接阅读。" : "设置已保存。连接是否可用请使用对应引擎的连接测试确认。";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "设置保存失败"; }
}

async function chooseDirectory(key: DirectoryKey): Promise<void> {
  error.value = "";
  if (!isTauriRuntime()) { error.value = "目录选择器需要桌面端；浏览器中可以直接填写路径。"; return; }
  try {
    const selected = await open({ directory: true, multiple: false, title: "选择保存目录", ...(settings.value[key] ? { defaultPath: settings.value[key] } : {}) });
    if (typeof selected === "string") settings.value[key] = selected;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "目录选择失败"; }
}

async function testConnection(engine: "aria2" | "qbittorrent"): Promise<void> {
  testing.value = engine;
  delete connectionMessages.value[engine];
  try {
    validateEndpoint(engine === "aria2" ? settings.value.aria2Endpoint : settings.value.qbittorrentEndpoint, engine);
    storeSessionCredentials();
    const message = await probeDownloadEngine(settings.value, engine);
    connectionMessages.value[engine] = { ok: true, message: `${engine} ${message} 已连接；这仅确认本地服务可达，具体资源和节点需要在任务中检查。` };
  } catch (cause) {
    connectionMessages.value[engine] = { ok: false, message: cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "连接失败，请检查服务地址和登录凭据" };
  } finally { testing.value = ""; }
}

function validateEndpoint(value: string, label: string): void {
  const url = new URL(assertLocalEndpoint(value, label));
  if (label === "aria2" && url.pathname !== "/jsonrpc") throw new Error("aria2 地址路径应为 /jsonrpc，例如 http://127.0.0.1:16800/jsonrpc");
  if (label !== "aria2" && url.pathname !== "/") throw new Error("qBittorrent 填写 Web UI 根地址，例如 http://127.0.0.1:8080，不需要 /api 路径。");
}

function clampNumber(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}

function restoreSaved(): void {
  settings.value = loadSettings();
  speedLimitKib.value = Math.round(settings.value.speedLimitBytesPerSecond / 1024);
  secret.value = loadSessionSecret();
  qbitCredentials.value = loadSessionQbittorrentCredentials();
  error.value = "";
  saved.value = "已恢复已保存的设置。";
}
</script>

<template>
  <section class="page-heading">
    <div><p class="eyebrow">让工作台适合你</p><h2>设置</h2><p class="muted">先确认保存位置，再检查需要使用的下载引擎。普通配置保存在本机，连接凭据只保留在当前会话。</p></div>
  </section>

  <form class="settings-workspace" @submit.prevent="submit">
    <section class="card setup-guide">
      <div class="step-number">01</div><div><h3>初次使用，从这三步开始</h3><p class="muted">确认目录 → 测试引擎 → 到来源管理启用所需来源。搜索和收藏可以独立使用。</p><RouterLink class="small-link" to="/sources">前往来源管理 →</RouterLink></div>
    </section>

    <section class="card">
      <div class="card-heading"><div><h3>保存位置</h3><p class="muted">这些是配置路径；选择目录和保存设置不会移动已有文件。</p></div></div>
      <p v-if="android" class="hint">安卓文件保存在应用存储中，漫画和小说下载后可在本应用阅读。当前使用自动管理的保存位置；卸载应用会移除应用数据。</p>
      <div v-if="portableDirectory" class="portable-mode-note" role="status"><strong>便携模式</strong><p>资料保存在 {{ portableDirectory }}。关闭应用后，将完整程序文件夹连同 Data 一起移动；内部文件路径会在下次启动时更新。自定义外部目录需要另外携带。</p></div>
      <div v-if="!android" class="directory-settings">
        <label v-for="directory in directories" :key="directory.key"><span>{{ directory.title }}</span><div class="path-picker"><input v-model="settings[directory.key]" :required="directory.key !== 'downloadDirectory'" :placeholder="directory.key === 'downloadDirectory' ? '留空则使用待整理目录' : '填写绝对路径或选择目录'" /><button class="ghost-button" type="button" @click="chooseDirectory(directory.key)">选择目录</button></div><small class="muted">{{ directory.description }}</small></label>
      </div>
    </section>

    <section v-if="android" class="card"><h3>原生 HTTP 下载</h3><p class="muted">支持 HTTP/HTTPS 文件，以及漫画 CBZ、轻小说 TXT 下载与内读。请在下载期间保持应用在前台；重新打开后可恢复已暂停的直链任务。</p><p class="hint">限速设置用于新建的 HTTP 任务，已有任务保留创建时的限速。磁力、Torrent、公开投稿的 Python 下载、JMComic 本地桥接和 Windows 游戏运行属于桌面端功能。安卓可检索游戏版本和下载归档，运行 Windows 游戏需使用电脑。</p></section>
    <div v-else class="engine-settings-grid">
      <section class="card engine-card">
        <div class="card-heading"><div><span class="tag-pill">HTTP / HTTPS / BitTorrent</span><h3>内置下载 · aria2</h3><p class="muted">直链、磁力和种子均可使用随应用提供的引擎，无需另装下载软件。</p></div></div>
        <label>JSON-RPC 地址<input v-model="settings.aria2Endpoint" type="url" required /></label>
        <label>RPC Secret（会话内使用）<input v-model="secret" type="password" autocomplete="off" placeholder="没有设置则留空" /></label>
        <button class="ghost-button" :disabled="!!testing" type="button" @click="testConnection('aria2')">{{ testing === 'aria2' ? '正在连接…' : '测试 aria2 连接' }}</button>
        <p v-if="connectionMessages.aria2" :class="connectionMessages.aria2.ok ? 'success-message' : 'error-message'" role="status">{{ connectionMessages.aria2.message }}</p>
      </section>
      <section class="card engine-card">
        <div class="card-heading"><div><span class="tag-pill">可选高级配置</span><h3>磁力与种子下载方式</h3><p class="muted">默认使用内置 aria2。已有 qBittorrent 的用户也可以在这里切换，连接其 Web UI。</p></div></div>
        <label>BitTorrent 下载引擎<select v-model="settings.btDownloadEngine"><option value="aria2">内置 aria2（默认，无需额外配置）</option><option value="qbittorrent">qBittorrent（需启用其 Web UI）</option></select></label>
        <p class="hint">切换引擎仅用于之后新建的磁力和种子任务。已有任务及其重试继续使用原引擎，避免重复下载；连接检查成功也不代表资源有在线节点。</p>
        <label>Web UI 地址<input v-model="settings.qbittorrentEndpoint" type="url" required /></label>
        <div class="credentials-grid"><label>用户名<input v-model="qbitCredentials.username" autocomplete="username" /></label><label>密码（会话内使用）<input v-model="qbitCredentials.password" type="password" autocomplete="current-password" /></label></div>
        <button class="ghost-button" :disabled="!!testing" type="button" @click="testConnection('qbittorrent')">{{ testing === 'qbittorrent' ? '正在连接…' : '测试 qBittorrent 连接' }}</button>
        <p v-if="connectionMessages.qbittorrent" :class="connectionMessages.qbittorrent.ok ? 'success-message' : 'error-message'" role="status">{{ connectionMessages.qbittorrent.message }}</p>
      </section>
    </div>

    <section class="card">
      <div class="card-heading"><div><h3>下载调度</h3><p class="muted">{{ android ? '最多同时下载 3 个直链文件，限速用于新建任务，0 为不限速。请保持应用在前台；系统结束应用后可重新打开并继续。' : '内置 aria2 的并发数量和单任务限速会在任务状态刷新时同步。每个任务各自限速，0 为不限速；qBittorrent 已有任务的限速请在其客户端调整。提高并发不会增加资源的在线节点。' }}</p></div></div>
      <div class="scheduling-settings"><label>最大并发任务数<input v-model.number="settings.maxConcurrentDownloads" type="number" min="1" :max="android ? 3 : 20" required /></label><label>单任务限速（KiB/s，0 为不限速）<input v-model.number="speedLimitKib" type="number" min="0" max="1048576" required /></label><label>状态刷新间隔（毫秒）<input v-model.number="settings.pollIntervalMs" type="number" min="1000" max="60000" required /></label></div>
      <label v-if="!android" class="auto-rename-option"><input v-model="settings.autoRenameDownloads" type="checkbox" /><span>下载完成后自动命名</span></label>
      <p v-if="!android" class="hint">aria2 单文件完成后，按关联作品、可靠集数和原扩展名在当前目录改名；重名不覆盖。多文件请在下载中心逐项预览；qBittorrent 请在其客户端改名以保留做种。</p>
    </section>
    <details class="card legal-notices"><summary>关于与第三方组件声明</summary><pre>{{ licenseText }}</pre></details>
    <div class="settings-savebar"><div><p v-if="error" class="error-message" role="alert">{{ error }}</p><p v-if="saved" class="success-message" role="status">{{ saved }}</p></div><div class="task-actions"><button class="ghost-button" type="button" @click="restoreSaved">恢复已保存</button><button class="primary-button" type="submit">保存设置</button></div></div>
  </form>
</template>

<style scoped>
.legal-notices{min-width:0}.legal-notices summary{cursor:pointer;color:#846596;font-size:13px}.legal-notices pre{max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font-size:11px;color:#867490;user-select:text}
.portable-mode-note{border:1px solid #e8deee;background:#faf6fd;border-radius:10px;padding:14px 16px;margin-bottom:20px;color:#846596;font-size:12px;overflow-wrap:anywhere}.portable-mode-note p{margin:6px 0 0;line-height:1.8;color:#9882a6}
.auto-rename-option{display:flex;align-items:center;gap:8px;margin-top:20px;font-size:12px}.auto-rename-option input{width:auto;accent-color:#a282bc}
</style>
