<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { SourceConfig } from "@/domain/source";
import type { MediaType } from "@/domain/media";
import { useSourceConfigStore } from "@/stores/source-config";
import { newId } from "@/shared/runtime";
import { parseGithubRepositoryUrl } from "@/infrastructure/sources/github-release-provider";
import { createSourceProvider } from "@/infrastructure/sources/create-source-provider";
import type { SourceHealth } from "@/application/source-ports";
import { createSourceDiagnosticRepository } from "@/infrastructure/database/create-source-diagnostic-repository";
import type { SourceDiagnosticRepository } from "@/application/source-diagnostic-ports";
import { createSourceDiagnostic, type SourceDiagnostic } from "@/domain/source-diagnostic";
import { createPluginRepository } from "@/infrastructure/plugins/create-plugin-repository";
import type { PluginRecord } from "@/domain/plugin";
import { validatePluginManifest } from "@/domain/plugin";
import { loginCopyManga } from "@/infrastructure/sources/copymanga-login";
import { DEFAULT_RESOURCE_SOURCE_CONFIGS } from "@/infrastructure/sources/default-sources";
import { filterSourcesByType, getSourcePriority } from "@/infrastructure/sources/source-catalog";
import SourceGuide from "@/components/SourceGuide.vue";

const store = useSourceConfigStore();
const name = ref("");
const url = ref("");
const token = ref("");
const type = ref<SourceConfig["type"]>("rss");
const tokenDrafts = ref<Record<string, string>>({});
const copyUsernameDrafts = ref<Record<string, string>>({});
const copyPasswordDrafts = ref<Record<string, string>>({});
const copyLoginBusyId = ref("");
const error = ref("");
const saved = ref("");
const health = ref<Record<string, SourceHealth>>({});
const healthBusyId = ref("");
const diagnostics = ref<SourceDiagnostic[]>([]);
const diagnosticRepository = ref<SourceDiagnosticRepository>();
const plugins = ref<PluginRecord[]>([]);
const manifestText = ref("");
const pluginError = ref("");
const pluginMessage = ref("");
const pluginRepository = ref<Awaited<ReturnType<typeof createPluginRepository>>>();
const editingId = ref("");
const editName = ref("");
const editUrl = ref("");
const sourceTypeFilter = ref<MediaType | "all">("all");
const sourceTypeFilters: Record<MediaType | "all", string> = { all: "全部", anime: "动画", manga: "漫画", novel: "轻小说", visual_novel: "Galgame" };
const selectedMediaType = computed(() => sourceTypeFilter.value === "all" ? undefined : sourceTypeFilter.value);
const configuredSources = computed(() => filterSourcesByType(store.configs, selectedMediaType.value)
  .sort((left, right) => getSourcePriority(left, selectedMediaType.value) - getSourcePriority(right, selectedMediaType.value)));
const availablePresets = computed(() => filterSourcesByType(DEFAULT_RESOURCE_SOURCE_CONFIGS, selectedMediaType.value).filter((preset) =>
  !store.configs.some((config) => config.id === preset.id || config.url === preset.url))
  .sort((left, right) => getSourcePriority(left, selectedMediaType.value) - getSourcePriority(right, selectedMediaType.value)));
const latestDiagnostics = computed(() => {
  const latest = new Map<string, SourceDiagnostic>();
  for (const diagnostic of diagnostics.value) {
    const previous = latest.get(diagnostic.sourceId);
    if (!previous || previous.checkedAt < diagnostic.checkedAt) latest.set(diagnostic.sourceId, diagnostic);
  }
  return latest;
});
watch(type, (value) => {
  const defaults: Record<string, { url: string; name: string }> = {
    mangabz: { url: "https://mangabz.com", name: "MangaBZ · 中文日漫" },
    vndb_release: { url: "https://api.vndb.org/kana", name: "VNDB · 官方发行与试玩" },
  };
  if (defaults[value]) { url.value = defaults[value].url; if (!name.value.trim()) name.value = defaults[value].name; }
  if (value === "public_video") {
    url.value = "https://www.bilibili.com";
    if (!name.value.trim()) name.value = "B站公开投稿";
  }
});

async function addPreset(preset: SourceConfig): Promise<void> {
  error.value = "";
  try {
    const timestamp = new Date().toISOString();
    await store.save({ ...preset, enabled: false, createdAt: timestamp, updatedAt: timestamp });
    saved.value = `${preset.name} 已添加，确认配置后再启用。`;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "添加来源失败"; }
}

function editSource(config: SourceConfig): void {
  editingId.value = config.id;
  editName.value = config.name;
  editUrl.value = config.url;
}

async function saveSourceEdit(config: SourceConfig): Promise<void> {
  error.value = "";
  try {
    if (!editName.value.trim()) throw new Error("请填写来源名称");
    const updated = { ...config, name: editName.value.trim(), url: editUrl.value.trim(), lastHealth: undefined, updatedAt: new Date().toISOString() };
    createSourceProvider(updated);
    if (store.configs.some((item) => item.id !== config.id && item.url === updated.url)) throw new Error("该地址已经配置，请编辑已有来源");
    await store.save(updated);
    delete health.value[config.id];
    editingId.value = "";
    saved.value = "来源配置已更新；既有资源记录保留，地址变更后请重新搜索资源。";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "来源修改失败"; }
}

onMounted(() => void initializePage());

function sourceTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    rss: "RSS/Atom",
    lnovel: "LNovel",
    mangadex: "MangaDex",
    mangabz: "MangaBZ · 中文",
    archive: "Internet Archive",
    copymanga: "拷贝漫画",
    kungal: "鲲 Galgame",
    vndb_release: "VNDB 官方发行",
    jmcomic: "JMComic",
    github_release: "GitHub Releases",
    public_video: "B站公开投稿",
  };
  return labels[type] ?? (type === "nyaa" || type === "anime_garden" ? `${type}（旧版 RSS 配置）` : type);
}

async function initializePage(): Promise<void> {
  await store.initialize();
  tokenDrafts.value = Object.fromEntries(store.configs.map((config) => [config.id, config.token ?? ""]));
  copyUsernameDrafts.value = Object.fromEntries(store.configs.map((config) => [config.id, ""]));
  copyPasswordDrafts.value = Object.fromEntries(store.configs.map((config) => [config.id, ""]));
  health.value = Object.fromEntries(store.configs.flatMap((config) => config.lastHealth ? [[config.id, config.lastHealth]] : []));
  try {
    diagnosticRepository.value = await createSourceDiagnosticRepository();
    diagnostics.value = await diagnosticRepository.value.list();
  } catch {
    diagnosticRepository.value = undefined;
    diagnostics.value = [];
  }
  try {
    pluginRepository.value = await createPluginRepository();
    plugins.value = await pluginRepository.value.list();
  } catch {
    pluginRepository.value = undefined;
    plugins.value = [];
  }
}

async function addSource(): Promise<void> {
  error.value = "";
  saved.value = "";
  const sourceName = name.value.trim();
  const sourceUrl = url.value.trim();
  if (!sourceName) {
    error.value = "请填写来源名称";
    return;
  }
  try {
    if (type.value === "rss") {
      if (!isHttpUrl(sourceUrl)) throw new Error("RSS 来源必须是不带认证信息的 HTTP/HTTPS 地址");
    } else if (["public_video", "mangabz", "vndb_release"].includes(type.value)) {
      createSourceProvider({ id: "validation", type: type.value, name: sourceName, url: sourceUrl, enabled: false, createdAt: "", updatedAt: "" });
    } else if (type.value === "github_release") {
      parseGithubRepositoryUrl(sourceUrl);
    } else if (type.value === "jmcomic") {
      if (sourceUrl !== "python://jmcomic") throw new Error("JMComic 地址固定为 python://jmcomic");
    } else if (type.value === "copymanga") {
      if (!isHttpUrl(sourceUrl)) throw new Error("拷贝漫画 API 地址必须是不带认证信息的 HTTP/HTTPS 地址");
    } else if (!isHttpUrl(sourceUrl)) {
      throw new Error(type.value === "kungal" ? "鲲 Galgame 地址必须是不带认证信息的 HTTP/HTTPS 地址" : type.value === "mangadex" ? "MangaDex API 地址必须是不带认证信息的 HTTP/HTTPS 地址" : type.value === "archive" ? "Internet Archive 地址必须是不带认证信息的 HTTP/HTTPS 地址" : type.value === "lnovel" ? "LNovel API 地址必须是不带认证信息的 HTTP/HTTPS 地址" : "来源地址必须是不带认证信息的 HTTP/HTTPS 地址");
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "来源地址无效";
    return;
  }
  if (store.configs.some((config) => config.url === sourceUrl)) {
    error.value = "该来源地址已经配置";
    return;
  }
  const timestamp = new Date().toISOString();
  const config: SourceConfig = {
    id: newId(),
    type: type.value,
    name: sourceName,
    url: sourceUrl,
    ...(type.value === "copymanga" ? { token: token.value.trim().replace(/^Token\s+/i, "") } : {}),
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await store.save(config);
    name.value = "";
    url.value = "";
    token.value = "";
    type.value = "rss";
    saved.value = "来源已保存";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "来源保存失败";
  }
}

async function toggle(config: SourceConfig): Promise<void> {
  try {
    await store.save({ ...config, enabled: !config.enabled, updatedAt: new Date().toISOString() });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "来源状态保存失败";
  }
}

async function saveCopyToken(config: SourceConfig): Promise<void> {
  const value = (tokenDrafts.value[config.id] ?? "").trim().replace(/^Token\s+/i, "");
  if (!value) {
    error.value = "请填写拷贝漫画 Token 后再保存";
    return;
  }
  try {
    await store.save({ ...config, token: value, enabled: true, lastHealth: undefined, updatedAt: new Date().toISOString() });
    delete health.value[config.id];
    saved.value = "拷贝漫画 Token 已保存并启用";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "拷贝漫画 Token 保存失败";
  }
}

async function loginCopySource(config: SourceConfig): Promise<void> {
  error.value = "";
  saved.value = "";
  const username = (copyUsernameDrafts.value[config.id] ?? "").trim();
  const password = copyPasswordDrafts.value[config.id] ?? "";
  if (!username || !password) {
    error.value = "请填写拷贝漫画账号和密码";
    return;
  }
  copyLoginBusyId.value = config.id;
  try {
    const value = await loginCopyManga(username, password);
    await store.save({ ...config, token: value, enabled: true, lastHealth: undefined, updatedAt: new Date().toISOString() });
    delete health.value[config.id];
    tokenDrafts.value = { ...tokenDrafts.value, [config.id]: value };
    copyPasswordDrafts.value = { ...copyPasswordDrafts.value, [config.id]: "" };
    saved.value = "拷贝漫画登录成功，Token 已保存并启用";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "拷贝漫画登录失败";
  } finally {
    copyPasswordDrafts.value = { ...copyPasswordDrafts.value, [config.id]: "" };
    copyLoginBusyId.value = "";
  }
}

async function remove(config: SourceConfig): Promise<void> {
  if (!window.confirm(`确定移除来源“${config.name}”吗？不会删除已有下载任务。`)) return;
  try {
    await store.remove(config.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "来源移除失败";
  }
}

async function checkHealth(config: SourceConfig): Promise<void> {
  healthBusyId.value = config.id;
  try {
    const result = await createSourceProvider(config).healthCheck();
    if (!await saveHealth(config, result)) return;
    health.value = { ...health.value, [config.id]: result };
    if (!result.ok) await recordDiagnostic(config, "health", result.message ?? "来源健康检查失败");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "来源健康检查失败";
    const result = { ok: false, checkedAt: new Date().toISOString(), message };
    if (!await saveHealth(config, result)) return;
    health.value = { ...health.value, [config.id]: result };
    await recordDiagnostic(config, "health", message);
  } finally {
    healthBusyId.value = "";
  }
}

async function saveHealth(config: SourceConfig, result: SourceHealth): Promise<boolean> {
  const current = store.configs.find((item) => item.id === config.id);
  // A slow check must not restore a removed source or overwrite a newer address,
  // credential, name or enabled state while persisting its connection result.
  if (!current || current.type !== config.type || current.url !== config.url || current.token !== config.token) return false;
  try {
    await store.save({ ...current, lastHealth: result, updatedAt: new Date().toISOString() });
    return true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "来源健康状态保存失败";
    return false;
  }
}

async function recordDiagnostic(config: SourceConfig, stage: SourceDiagnostic["stage"], message: string): Promise<void> {
  if (!diagnosticRepository.value) return;
  try {
    const diagnostic = createSourceDiagnostic({
      sourceId: config.id,
      sourceName: config.name,
      stage,
      message,
      snapshot: { sourceType: config.type, sourceUrl: config.url },
    });
    await diagnosticRepository.value.record(diagnostic);
    diagnostics.value = [diagnostic, ...diagnostics.value.filter((item) => item.id !== diagnostic.id)].slice(0, 50);
  } catch {
    // 诊断写入失败不能影响来源健康检查和启停操作。
  }
}

async function clearDiagnostics(): Promise<void> {
  if (!diagnosticRepository.value) return;
  try {
    await diagnosticRepository.value.clear();
    diagnostics.value = [];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "来源诊断清理失败";
  }
}

function exportDiagnostics(): void {
  if (!diagnostics.value.length) return;
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), diagnostics: diagnostics.value }, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `acgn-source-diagnostics-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function registerPlugin(): Promise<void> {
  pluginError.value = "";
  pluginMessage.value = "";
  try {
    const manifest = validatePluginManifest(JSON.parse(manifestText.value));
    if (!pluginRepository.value) throw new Error("插件存储尚未初始化");
    const previous = plugins.value.find((item) => item.manifest.id === manifest.id);
    const record: PluginRecord = {
      manifest,
      enabled: previous?.enabled ?? false,
      ...(previous?.lastHealth ? { lastHealth: previous.lastHealth } : {}),
      updatedAt: new Date().toISOString(),
    };
    await pluginRepository.value.upsert(record);
    plugins.value = await pluginRepository.value.list();
    manifestText.value = "";
    pluginMessage.value = `Manifest ${manifest.id} 已登记，默认保持停用`;
  } catch (cause) {
    pluginError.value = cause instanceof Error ? cause.message : "插件 Manifest 无效";
  }
}

async function togglePlugin(record: PluginRecord): Promise<void> {
  if (!pluginRepository.value) return;
  const next = { ...record, enabled: !record.enabled, updatedAt: new Date().toISOString() };
  try {
    await pluginRepository.value.upsert(next);
    plugins.value = await pluginRepository.value.list();
  } catch (cause) { pluginError.value = cause instanceof Error ? cause.message : "插件状态保存失败"; }
}

async function checkPlugin(record: PluginRecord): Promise<void> {
  if (!pluginRepository.value) return;
  const checkedAt = new Date().toISOString();
  try {
    validatePluginManifest(record.manifest);
    await pluginRepository.value.upsert({ ...record, lastHealth: { ok: true, checkedAt, message: "Manifest 校验通过；外部脚本运行时仍保持关闭" }, updatedAt: checkedAt });
  } catch (cause) {
    await pluginRepository.value.upsert({ ...record, enabled: false, lastHealth: { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "Manifest 校验失败" }, updatedAt: checkedAt });
  }
  plugins.value = await pluginRepository.value.list();
}

async function removePlugin(record: PluginRecord): Promise<void> {
  if (!pluginRepository.value || !window.confirm(`确定移除插件 Manifest“${record.manifest.name}”吗？`)) return;
  await pluginRepository.value.remove(record.manifest.id);
  plugins.value = await pluginRepository.value.list();
}

function healthLabel(config: SourceConfig): string {
  if (latestSourceIssue(config)) return "有失败记录";
  const result = health.value[config.id];
  if (!result) return "未检测";
  return result.ok ? "上次通过" : "上次失败";
}

function latestSourceIssue(config: SourceConfig): SourceDiagnostic | undefined {
  const issue = latestDiagnostics.value.get(config.id);
  const result = health.value[config.id];
  // A successful connection check cannot prove a failed chapter/file operation
  // was fixed. Keep that separate operation history until it is cleared.
  return issue && (issue.stage !== "health" || !result?.ok || issue.checkedAt > result.checkedAt) ? issue : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
</script>

<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">把内容连接起来</p>
      <h2>来源管理</h2>
      <p class="muted">按你需要的内容启用来源。连接检查只代表本次接口可达，作品匹配、登录权限和具体文件会在读取时进一步验证。</p>
    </div>
  </section>

  <div class="source-type-filter" role="group" aria-label="来源作品类型">
    <button v-for="(label, mediaType) in sourceTypeFilters" :key="mediaType" type="button" :class="{ active: sourceTypeFilter === mediaType }" :aria-pressed="sourceTypeFilter === mediaType" @click="sourceTypeFilter = mediaType">{{ label }}</button>
  </div>
  <p class="source-filter-hint">按用途排列 · 常用来源在前，备用与站外索引保留。筛选只改变当前显示。</p>

  <section v-if="availablePresets.length" class="preset-grid" aria-label="可添加的来源">
    <article v-for="preset in availablePresets" :key="preset.id" class="card preset-card">
      <h3>{{ preset.name }}</h3><SourceGuide :config="preset" compact />
      <button class="ghost-button" type="button" @click="addPreset(preset)">添加到来源</button>
    </article>
  </section>

  <section class="card">
    <form class="source-form" @submit.prevent="addSource">
      <label><span>来源名称</span><input v-model="name" type="text" placeholder="例如：我的更新源" required /></label>
      <label><span>来源类型</span><select v-model="type"><option value="rss">RSS / Atom（附件 / 磁力 / 种子）</option><option value="public_video">B站公开投稿（MP4）</option><option value="lnovel">LNovel 中文轻小说</option><option value="mangadex">MangaDex 漫画</option><option value="mangabz">MangaBZ · 中文日漫</option><option value="archive">Internet Archive</option><option value="copymanga">拷贝漫画</option><option value="kungal">鲲 Galgame</option><option value="vndb_release">VNDB 官方发行与试玩</option><option value="jmcomic">JMComic（需 Python）</option><option value="github_release">GitHub Releases</option></select></label>
      <label><span>{{ type === "mangabz" ? "MangaBZ 网站地址" : type === "public_video" ? "B站公开投稿来源地址" : type === "github_release" ? "GitHub 仓库地址" : type === "lnovel" ? "LNovel API 地址" : type === "mangadex" ? "MangaDex API 地址" : type === "archive" ? "Internet Archive 地址" : type === "copymanga" ? "拷贝漫画 API 地址" : type === "kungal" ? "鲲 Galgame 地址" : type === "vndb_release" ? "VNDB API 地址" : type === "jmcomic" ? "JMComic 地址" : "RSS/Atom 地址" }}</span><input v-model="url" type="url" :placeholder="type === 'mangabz' ? 'https://mangabz.com' : type === 'public_video' ? 'https://www.bilibili.com' : type === 'github_release' ? 'https://github.com/owner/repo' : type === 'lnovel' ? 'https://lnovel.animes.garden' : type === 'mangadex' ? 'https://api.mangadex.org' : type === 'archive' ? 'https://archive.org' : type === 'copymanga' ? 'https://mapi.hotmangasg.com' : type === 'kungal' ? 'https://www.kungal.com' : type === 'vndb_release' ? 'https://api.vndb.org/kana' : type === 'jmcomic' ? 'python://jmcomic' : 'https://example.com/feed.xml'" required /></label>
      <label v-if="type === 'copymanga'"><span>拷贝漫画 Token（可选）</span><input v-model="token" type="password" placeholder="公开章节无需填写；受限章节再粘贴 Token" autocomplete="off" /></label>
      <button class="primary-button" type="submit">添加来源</button>
    </form>
    <p class="hint">RSS 可用于动漫更新；B站公开投稿支持关键词或 BV 链接，只读取可匿名访问的内容。下载使用已配置引擎。漫画 CBZ / 小说 TXT 仅在桌面端生成。拷贝漫画只保存登录返回的 Token，不保存密码，也不会向其它 API 地址自动转发 Token。</p>
    <p v-if="error || store.error" class="error-message">{{ error || store.error }}</p>
    <p v-if="saved" class="success-message">{{ saved }}</p>
  </section>

  <section class="card">
    <div class="card-heading">
      <div><h3>已配置来源</h3><p class="muted">{{ store.configs.length }} 个来源 · {{ store.enabledConfigs.length }} 个启用<span v-if="sourceTypeFilter !== 'all'"> · 当前显示 {{ configuredSources.length }} 个{{ sourceTypeFilters[sourceTypeFilter] }}来源</span></p></div>
    </div>
      <div v-if="!store.configs.length" class="empty-state"><strong>还没有来源</strong><span>从上方添加适合当前内容的来源，也可以填写自定义订阅地址。</span></div>
      <div v-else-if="!configuredSources.length" class="empty-state"><strong>当前分类还没有来源</strong><span>可以添加上方预设，或切换到全部查看已有配置。</span></div>
    <div v-else class="source-list">
      <article v-for="config in configuredSources" :key="config.id" class="source-row">
        <div class="source-content">
          <div class="media-title-line"><h3>{{ config.name }}</h3><span class="tag-pill">{{ sourceTypeLabel(config.type as string) }}</span></div>
          <p class="muted source-url">{{ config.url }}</p>
          <SourceGuide :config="config" />
          <p v-if="health[config.id]?.message" class="hint" :class="{ 'error-text': !health[config.id]?.ok }">{{ health[config.id]?.message }}</p>
          <p v-if="health[config.id]?.checkedAt" class="source-check-time">上次连接检测：{{ health[config.id]?.checkedAt }}</p>
          <p v-if="latestSourceIssue(config)" class="hint error-text" role="status">最近失败：{{ latestSourceIssue(config)?.message }} · {{ latestSourceIssue(config)?.checkedAt }}</p>
          <form v-if="editingId === config.id" class="source-edit" @submit.prevent="saveSourceEdit(config)">
            <label>名称<input v-model="editName" required /></label><label>来源地址<input v-model="editUrl" type="url" required /></label>
            <div class="task-actions"><button class="small-button" type="submit">保存配置</button><button class="small-button" type="button" @click="editingId = ''">取消</button></div>
          </form>
          <details v-if="config.type === 'copymanga'" class="source-login">
            <summary>{{ config.token ? '登录凭据已配置 · 管理账号 / Token' : '需要更多章节权限时，配置账号 / Token' }}</summary>
            <div class="copy-token-row"><input v-model="copyUsernameDrafts[config.id]" aria-label="拷贝漫画用户名" type="text" placeholder="用户名" autocomplete="username" /><input v-model="copyPasswordDrafts[config.id]" aria-label="拷贝漫画密码" type="password" placeholder="密码（不保存）" autocomplete="current-password" /><button class="small-button" :disabled="!!copyLoginBusyId" type="button" @click="loginCopySource(config)">{{ copyLoginBusyId === config.id ? "登录中…" : "登录并保存 Token" }}</button></div>
            <div class="copy-token-row"><input v-model="tokenDrafts[config.id]" aria-label="拷贝漫画 Token" type="password" placeholder="已有 Token 可直接粘贴" autocomplete="off" /><button class="small-button" type="button" @click="saveCopyToken(config)">保存 Token</button></div>
          </details>
        </div>
        <div class="task-actions">
          <span class="state-pill" :class="{ enabled: config.enabled }">{{ config.enabled ? "已启用" : "已停用" }}</span>
          <span class="state-pill" :class="{ enabled: health[config.id]?.ok && !latestSourceIssue(config) }">状态：{{ healthLabel(config) }}</span>
          <button class="small-button" :disabled="!!healthBusyId" type="button" @click="checkHealth(config)">{{ healthBusyId === config.id ? "检测中…" : "检查连接" }}</button>
          <button class="small-button" type="button" @click="editSource(config)">编辑</button>
          <button class="small-button" type="button" @click="toggle(config)">{{ config.enabled ? "停用" : "启用" }}</button>
          <button class="small-button danger" type="button" @click="remove(config)">移除</button>
        </div>
      </article>
    </div>
  </section>

  <details class="card advanced-panel">
    <summary>高级扩展 · 插件清单登记</summary>
    <div class="card-heading">
      <div><h3>插件 Manifest</h3><p class="muted">插件只登记清单，默认停用；启用前必须声明公开域名权限。当前不会自动执行未知插件脚本。</p></div>
    </div>
    <textarea v-model="manifestText" rows="8" placeholder='{"apiVersion":1,"id":"example-source","name":"Example Source","version":"1.0.0","kind":"source","entry":"index.js","permissions":{"domains":["example.com"]},"config":{}}'></textarea>
    <div class="form-footer"><button class="primary-button" type="button" @click="registerPlugin">登记 Manifest</button><span v-if="pluginMessage" class="success-message">{{ pluginMessage }}</span></div>
    <p v-if="pluginError" class="error-message">{{ pluginError }}</p>
    <div v-if="plugins.length" class="plugin-list">
      <article v-for="plugin in plugins" :key="plugin.manifest.id" class="source-row">
        <div><strong>{{ plugin.manifest.name }} · v{{ plugin.manifest.version }}</strong><p class="muted source-url">{{ plugin.manifest.id }} · 权限：{{ plugin.manifest.permissions.domains.join(", ") }}</p></div>
        <div class="task-actions"><span class="state-pill" :class="{ enabled: plugin.enabled }">{{ plugin.enabled ? "已启用" : "已停用" }}</span><span class="state-pill" :class="{ enabled: plugin.lastHealth?.ok }">校验：{{ plugin.lastHealth ? (plugin.lastHealth.ok ? "正常" : "异常") : "未检测" }}</span><button class="small-button" type="button" @click="checkPlugin(plugin)">校验</button><button class="small-button" type="button" @click="togglePlugin(plugin)">{{ plugin.enabled ? "停用" : "启用" }}</button><button class="small-button danger" type="button" @click="removePlugin(plugin)">移除</button></div>
      </article>
    </div>
  </details>

  <section class="card">
    <div class="card-heading"><div><h3>来源诊断</h3><p class="muted">仅保存来源、阶段、错误摘要和受控快照；不会写入 Cookie、Token 或响应正文。</p></div><div class="task-actions"><button class="ghost-button" :disabled="!diagnostics.length" type="button" @click="exportDiagnostics">导出 JSON</button><button class="ghost-button" :disabled="!diagnostics.length" type="button" @click="clearDiagnostics">清空</button></div></div>
    <div v-if="!diagnostics.length" class="empty-state"><span>暂无来源失败诊断。</span></div>
    <div v-else class="diagnostic-list">
      <article v-for="diagnostic in diagnostics" :key="diagnostic.id" class="diagnostic-row"><div><strong>{{ diagnostic.sourceName }} · {{ diagnostic.stage }}</strong><p class="muted">{{ diagnostic.message }}</p></div><time class="muted">{{ diagnostic.checkedAt }}</time></article>
    </div>
  </section>
</template>

<style scoped>
.source-type-filter{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 10px}.source-type-filter>button{border:1px solid #e7dfef;background:#fff;color:#9b89aa;border-radius:8px;padding:9px 15px;font-size:12px;cursor:pointer}.source-type-filter>button.active{border-color:#b49acb;background:#f1eaf8;color:#806194;font-weight:650}.source-type-filter>button:focus-visible{outline:2px solid #ad8fc8;outline-offset:3px}.source-filter-hint,.source-check-time{font-size:11px;color:#a894b2;line-height:1.7}.source-filter-hint{margin:0 0 19px}.source-check-time{margin:5px 0}.preset-card>button{margin-top:12px}
</style>
