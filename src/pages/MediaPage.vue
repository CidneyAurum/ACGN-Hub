<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { Media, MediaDetails } from "@/domain/media";
import { BangumiProvider } from "@/infrastructure/metadata/bangumi-provider";
import { VndbProvider } from "@/infrastructure/metadata/vndb-provider";
import { useMediaLibraryStore } from "@/stores/media-library";
import { useSourceConfigStore } from "@/stores/source-config";
import { useDownloadStore } from "@/stores/download";
import type { SourceProvider } from "@/application/source-ports";
import { createSourceProvider } from "@/infrastructure/sources/create-source-provider";
import { createResourceRepository } from "@/infrastructure/database/create-resource-repository";
import type { ResourceRepository } from "@/application/resource-ports";
import { resourceDedupeKey, type ResourceItem } from "@/domain/resource";
import { loadSettings } from "@/shared/settings";
import { newId } from "@/shared/runtime";
import { parseDownloadTarget } from "@/shared/validation";
import { createMangaChapterService } from "@/infrastructure/manga/tauri-manga-chapter-service";
import { joinWindowsPath, sanitizeFileName } from "@/domain/organization";
import type { SourceConfig } from "@/domain/source";
import { createSourceDiagnosticRepository } from "@/infrastructure/database/create-source-diagnostic-repository";
import type { SourceDiagnosticRepository } from "@/application/source-diagnostic-ports";
import { createSourceDiagnostic } from "@/domain/source-diagnostic";
import { useSearchSessionStore } from "@/stores/search-session";
import { useLocalDownloadStore } from "@/stores/local-download";
import { sourceDescription } from "@/infrastructure/sources/source-availability";
import { DEFAULT_RESOURCE_SOURCE_CONFIGS } from "@/infrastructure/sources/default-sources";
import { discoverResources, getResourceWarnings, loadSourceItemResources } from "@/application/resource-discovery";
import { getSourceCapability, getSourcePriority, sourceSupportsType } from "@/infrastructure/sources/source-catalog";
import SubjectHero from "@/components/SubjectHero.vue";
import SubjectResourcePanel from "@/components/SubjectResourcePanel.vue";
import { useTrackingStore, type TrackingStatus } from "@/stores/tracking";
import { openUrl } from "@tauri-apps/plugin-opener";
import { downloadPublicVideo } from "@/infrastructure/video/tauri-public-video-service";
import { isTauriRuntime } from "@/shared/runtime";

const route = useRoute();
const library = useMediaLibraryStore();
const sourceStore = useSourceConfigStore();
const downloadStore = useDownloadStore();
const localDownloadStore = useLocalDownloadStore();
const searchSession = useSearchSessionStore();
const trackingStore = useTrackingStore();
const saving = ref(false);
const resourcePanelOpen = ref(false);
const sourceNamesView = ref<Record<string, string>>({});
const resourceGroupTitles = ref<Record<string, string>>({});
const resourceWarnings = ref<Record<string, string[]>>({});
const providers = {
  bangumi: new BangumiProvider(),
  vndb: new VndbProvider(),
} as const;
const media = ref<Media>();
const details = ref<MediaDetails>();
const detailsError = ref("");
const loading = ref(false);
const error = ref("");
const metadataNotice = ref("");
const saveError = ref("");
const resources = ref<ResourceItem[]>([]);
const resourceLoading = ref(false);
const resourceSearchRequested = ref(false);
const resourceError = ref("");
const resourceNotice = ref("");
const completedLocalTaskId = ref("");
const addingResourceId = ref("");
const resourceQuery = ref("");
const sourceSearchKeyword = ref("");
const resourceProtocol = ref<"all" | ResourceItem["protocol"]>("all");
const resourceSourceFilter = ref("");
const selectedResourceIds = ref<string[]>([]);
const batchAdding = ref(false);
const manualResourceUrl = ref("");
const manualResourceTitle = ref("");
const manualAdding = ref(false);
const resourceSourceNames = new Map<string, string>();
const resourceSourceConfigs = new Map<string, SourceConfig>();
const resourceProviders = new Map<string, SourceProvider>();
let resourceRepository: ResourceRepository | undefined;
let diagnosticRepository: SourceDiagnosticRepository | undefined;
let loadGeneration = 0;
let resourceSearchGeneration = 0;
const saved = computed(() => Boolean(media.value && library.isSaved(media.value.id)));
const tracking = computed(() => media.value ? trackingStore.get(media.value) : { status: "wish" as const, episode: 0 });
const exactSource = computed(() => media.value?.id.startsWith("source:") && typeof media.value.metadata.sourceConfigId === "string" && typeof media.value.metadata.sourceItemId === "string");
const metadataEntries = computed(() =>
  Object.entries(media.value?.metadata ?? {}).filter(([key]) => key !== "raw"),
);
const resourceSourceOptions = computed(() => {
  const existingIds = new Set(sourceStore.configs.map((config) => config.id));
  const configs = [...sourceStore.configs, ...DEFAULT_RESOURCE_SOURCE_CONFIGS.filter((config) => !existingIds.has(config.id))];
  return configs.filter((config) => sourceSupportsType(config, media.value?.type ?? "anime") &&
    (!exactSource.value || config.id === media.value?.metadata.sourceConfigId))
    .sort((left, right) => getSourcePriority(left, media.value?.type) - getSourcePriority(right, media.value?.type))
    .flatMap((config) => {
      try { return [{ config, providerId: createSourceProvider(config).id, description: getSourceCapability(config).description }]; }
      catch { return []; }
    });
});
const visibleResources = computed(() => {
  const query = resourceQuery.value.trim().toLocaleLowerCase();
  return resources.value.filter((resource) => {
    if (resourceSourceFilter.value && resourceSourceFilter.value !== "all" && resource.sourceId !== resourceSourceFilter.value && resource.sourceId !== "manual") return false;
    if (resourceProtocol.value !== "all" && resource.protocol !== resourceProtocol.value) return false;
    if (!query) return true;
    const searchable = [
      resource.title,
      resource.format,
      resource.language,
      resource.resolution,
      resource.protocol,
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return searchable.includes(query);
  }).sort((left, right) => resourceLanguageScore(right) - resourceLanguageScore(left));
});
const allVisibleSelected = computed(() =>
  visibleResources.value.length > 0 && visibleResources.value.every((resource) => selectedResourceIds.value.includes(resource.id)),
);
onMounted(() => void load());
watch(() => route.params.id, () => void load());
onUnmounted(() => { loadGeneration += 1; resourceSearchGeneration += 1; });

async function load(): Promise<void> {
  const id = String(route.params.id ?? "");
  const generation = ++loadGeneration;
  resourceSearchGeneration += 1;
  media.value = undefined;
  details.value = undefined;
  detailsError.value = "";
  error.value = "";
  metadataNotice.value = "";
  saveError.value = "";
  resources.value = [];
  sourceSearchKeyword.value = "";
  addingResourceId.value = "";
  manualResourceUrl.value = "";
  manualResourceTitle.value = "";
  resourceQuery.value = "";
  resourceProtocol.value = "all";
  selectedResourceIds.value = [];
  resourceLoading.value = false;
  resourceSourceNames.clear();
  resourceSourceConfigs.clear();
  resourceProviders.clear();
  resourceSearchRequested.value = false;
  resourceError.value = "";
  resourceNotice.value = "";
  completedLocalTaskId.value = "";
  resourceSourceFilter.value = "";
  manualAdding.value = false;
  batchAdding.value = false;
  loading.value = true;
  resourcePanelOpen.value = false;
  sourceNamesView.value = {};
  resourceGroupTitles.value = {};
  resourceWarnings.value = {};
  const show = (value: Media): void => {
    media.value = value;
    sourceSearchKeyword.value = value.title;
    loading.value = false;
    void initializeDetailSections(value, generation);
    void loadDetails(value.id, generation);
  };
  const immediate = searchSession.find(id)?.media ?? library.items.find((item) => item.id === id);
  if (immediate) {
    show(immediate);
    void library.initialize();
    if (!id.startsWith("source:")) void refreshMetadata(immediate, generation);
    return;
  }
  // Local data is supplemental to online metadata, never a gate before the
  // already selected work can be displayed.
  const localLookup = library.initialize().then(() => {
    if (generation !== loadGeneration || media.value) return;
    const stored = library.items.find((item) => item.id === id);
    if (stored) show(stored);
  });
  try {
    if (id.startsWith("source:")) {
      await localLookup;
      if (generation !== loadGeneration) return;
      if (!media.value) throw new Error(library.error || "这个来源作品尚未保存在本机，请返回资源搜索重新选择。");
      return;
    }
    const remote = await fetchMetadata(id);
    if (generation !== loadGeneration) return;
    if (media.value) { media.value = remote; return; }
    show(remote);
  } catch (cause) {
    if (generation !== loadGeneration) return;
    if (media.value) { metadataNotice.value = "远端资料暂时无法更新，当前显示已保存内容。"; return; }
    error.value = cause instanceof Error ? cause.message : "作品详情读取失败";
    loading.value = false;
  }
}
async function fetchMetadata(id: string): Promise<Media> {
  const [providerId] = id.split(":");
  const provider = providers[providerId as keyof typeof providers];
  if (!provider) throw new Error("暂不支持该作品来源");
  return provider.getById(id);
}

async function loadDetails(targetId: string, generation: number): Promise<void> {
  const [providerId] = targetId.split(":");
  const provider = providers[providerId as keyof typeof providers];
  if (!provider?.getDetails) return;
  try {
    const result = await provider.getDetails(targetId);
    if (generation !== loadGeneration || media.value?.id !== targetId) return;
    details.value = result;
    detailsError.value = "";
  } catch {
    if (generation === loadGeneration && media.value?.id === targetId) {
      detailsError.value = "详细资料暂时无法获取，已显示基础信息。";
    }
  }
}

async function initializeDetailSections(targetMedia: Media, generation: number): Promise<void> {
  const searchGeneration = resourceSearchGeneration;
  await Promise.allSettled([
    sourceStore.initialize(),
    initializeResourceRepository(),
    initializeDiagnosticRepository(),
  ]);
  if (generation !== loadGeneration || media.value?.id !== targetMedia.id) return;
  if (resourceRepository) {
    try {
      const stored = await resourceRepository.list();
      if (generation !== loadGeneration || searchGeneration !== resourceSearchGeneration) return;
      resources.value = stored.filter((resource) => resource.mediaId === targetMedia.id);
      for (const resource of resources.value) sourceNamesView.value[resource.id] = findSourceConfig(resource.sourceId)?.name || (resource.sourceId === "manual" ? "手动链接" : resource.sourceId);
    } catch {
      if (generation === loadGeneration) resourceError.value = "本地资源记录读取失败，可重新搜索来源资源。";
    }
  }
  if (!resourceSourceFilter.value) {
    const preferred = resourceSourceOptions.value.find(({ config }) => config.enabled);
    resourceSourceFilter.value = exactSource.value ? resourceSourceOptions.value[0]?.providerId ?? "all" : "all";
    if (exactSource.value) {
      resourcePanelOpen.value = true;
      if (preferred && !resourceSearchRequested.value) void requestResourceSearch();
    }
  }
}

async function refreshMetadata(current: Media, generation: number): Promise<void> {
  if (current.id.startsWith("source:")) return;
  try {
    const refreshed = await fetchMetadata(current.id);
    if (generation !== loadGeneration || media.value?.id !== current.id) return;
    media.value = refreshed;
    searchSession.remember([{ media: refreshed, score: 100, reason: "exact" }]);
  } catch {
    if (generation === loadGeneration && media.value?.id === current.id) {
      metadataNotice.value = "远端元数据暂时不可用，当前显示缓存内容。";
    }
  }
}

async function initializeResourceRepository(): Promise<void> {
  if (resourceRepository) return;
  resourceRepository = await createResourceRepository();
}

async function initializeDiagnosticRepository(): Promise<void> {
  if (diagnosticRepository) return;
  try {
    diagnosticRepository = await createSourceDiagnosticRepository();
  } catch {
    diagnosticRepository = undefined;
  }
}

async function loadResources(targetMedia: Media): Promise<void> {
  const generation = ++resourceSearchGeneration;
  const current = () => generation === resourceSearchGeneration && media.value?.id === targetMedia.id;
  selectedResourceIds.value = [];
  resourceError.value = "";
  resourceNotice.value = "";
  resourceLoading.value = true;
  try {
    await sourceStore.initialize();
    if (!current()) return;
    if (sourceStore.error) throw new Error(sourceStore.error);
    const configs = resourceSourceOptions.value.filter((option) => option.config.enabled &&
      (resourceSourceFilter.value === "all" || option.providerId === resourceSourceFilter.value)).map((option) => option.config);
    if (!configs.length) {
      resourceNotice.value = "先选择下方适用来源，点击“启用并搜索”后即可在这里检索。";
      return;
    }
    let found: Array<{ resource: ResourceItem; config: SourceConfig; provider: SourceProvider; sourceItemTitle: string; warnings: string[] }> = [];
    const failures: Array<{ config: SourceConfig; message: string }> = [];
    if (exactSource.value) {
      const config = configs.find((item) => item.id === targetMedia.metadata.sourceConfigId);
      if (!config) throw new Error("这个作品的来源未启用，请在下方启用原来源后重试。");
      const result = await loadSourceItemResources({ config, sourceItemId: String(targetMedia.metadata.sourceItemId), title: targetMedia.title });
      found = result.resources.map((resource) => ({ resource, config, provider: result.provider, sourceItemTitle: targetMedia.title, warnings: getResourceWarnings(resource, result.warnings) }));
    } else {
      const keyword = sourceSearchKeyword.value.trim() || targetMedia.title;
      const result = await discoverResources({ media: targetMedia, keyword,
        aliases: keyword === targetMedia.title ? [...new Set([targetMedia.originalTitle, ...targetMedia.aliases].filter((value): value is string => Boolean(value)))] : [],
        mediaType: targetMedia.type, sources: configs });
      found = result.items;
      failures.push(...result.failures);
    }
    if (!current()) return;
    const retained = resources.value.filter((resource) => resource.sourceId === "manual");
    resources.value = retained;
    resourceSourceNames.clear(); resourceSourceConfigs.clear(); resourceProviders.clear();
    resourceGroupTitles.value = {}; resourceWarnings.value = {}; sourceNamesView.value = {};
    const seen = new Set(retained.map(resourceDedupeKey));
    for (const item of found) {
      if (seen.has(resourceDedupeKey(item.resource))) continue;
      seen.add(resourceDedupeKey(item.resource));
      resources.value.push(item.resource);
      resourceSourceNames.set(item.resource.id, item.config.name);
      resourceSourceConfigs.set(item.resource.id, item.config);
      resourceProviders.set(item.resource.id, item.provider);
      sourceNamesView.value[item.resource.id] = item.config.name;
      resourceGroupTitles.value[item.resource.id] = item.sourceItemTitle;
      resourceWarnings.value[item.resource.id] = getResourceWarnings(item.resource, item.warnings);
    }
    resourceError.value = failures.map((failure) => `${failure.config.name}：${failure.message}`).join("\n");
    for (const failure of failures) void recordSourceDiagnostic(failure.config, "search", failure.message, { mediaId: targetMedia.id });
    if (!found.length && !failures.length) resourceNotice.value = "来源已返回，但没有匹配到这个作品。可修改检索词，或直接在来源中选择准确作品。";
  } catch (cause) {
    if (current()) resourceError.value = cause instanceof Error ? cause.message : "资源检索失败，请重试";
  } finally { if (current()) resourceLoading.value = false; }
}

async function requestResourceSearch(): Promise<void> {
  if (!media.value || resourceLoading.value) return;
  resourcePanelOpen.value = true;
  resourceSearchRequested.value = true;
  await loadResources(media.value);
}

async function enableSourceAndSearch(config: SourceConfig): Promise<void> {
  if (resourceLoading.value) return;
  resourceError.value = "";
  try {
    await sourceStore.save({ ...config, enabled: true, updatedAt: new Date().toISOString() });
    resourceSourceFilter.value = createSourceProvider(config).id;
    await requestResourceSearch();
  } catch (cause) { resourceError.value = cause instanceof Error ? cause.message : "来源启用失败，配置未改动"; }
}

function openResources(): void {
  resourcePanelOpen.value = true;
  if (!resourceSourceFilter.value) resourceSourceFilter.value = "all";
  requestAnimationFrame(() => document.getElementById("subject-resources")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  if (resourceSourceOptions.value.some((option) => option.config.enabled) && !resourceSearchRequested.value) void requestResourceSearch();
}
async function addResource(resource: ResourceItem): Promise<boolean> {
  if (!media.value || addingResourceId.value) return false;
  const targetMedia = media.value;
  const generation = loadGeneration;
  const sourceConfig = resourceSourceConfigs.get(resource.id) ?? findSourceConfig(resource.sourceId);
  addingResourceId.value = resource.id;
  resourceError.value = "";
  let localTaskId: string | undefined;
  try {
    if (resource.metadata.downloadMode === "external_link") {
      const target = new URL(resource.targetUrl);
      if (!["https:", "http:"].includes(target.protocol)) throw new Error("来源链接不是有效的网页地址");
      if (isTauriRuntime()) await openUrl(target.toString());
      else window.open(target.toString(), "_blank", "noopener,noreferrer");
      if (generation === loadGeneration) resourceNotice.value = "已打开来源分享页面；它是网页入口，下载文件需在来源中确认。";
      return true;
    }
    const provider = resourceProviders.get(resource.id) ??
      ((isNovelResource(resource) || isMangaResource(resource)) && sourceConfig ? createSourceProvider(sourceConfig, [resource]) : undefined);
    if ((isNovelResource(resource) || isMangaResource(resource)) && !provider) {
      throw new Error("该章节的来源配置已移除，请先恢复来源；不会把章节网页当作文件下载");
    }
    const associatedResource = { ...resource, mediaId: targetMedia.id };
    if (!resourceRepository) await initializeResourceRepository();
    if (!resourceRepository) throw new Error("资源记录存储尚未就绪");
    await resourceRepository.upsert(associatedResource);
    const settings = loadSettings();
    if (resource.metadata.downloadMode === "public_video") {
      const outputRoot = settings.libraryDirectory;
      if (!isAbsoluteWindowsPath(outputRoot)) throw new Error("请先在设置中选择有效的作品库目录");
      const title = sanitizeFileName(resource.title || targetMedia.title).slice(0, 150);
      const quality = resource.resolution?.match(/^\d{3,4}p$/i)?.[0];
      const outputPath = joinWindowsPath(outputRoot, "Anime", sanitizeFileName(targetMedia.title).slice(0, 120), title + (quality ? ` - ${quality}` : "") + ".mp4");
      localTaskId = localDownloadStore.create({ kind: "video", title: resource.title + (quality ? ` · ${quality}` : ""), sourceName: sourceConfig?.name ?? "公开投稿", directory: outputRoot, outputPath, totalUnits: 100,
        reading: { mediaId: targetMedia.id, seriesTitle: targetMedia.title, unitTitle: resource.title, ...(resource.episode !== undefined ? { unitNumber: resource.episode } : {}) } });
      await downloadPublicVideo({
        url: resource.targetUrl, outputRoot, outputPath, operationId: localTaskId,
        isCancelled: () => localDownloadStore.isCancelled(localTaskId!),
        onProgress: (progress) => localDownloadStore.update(localTaskId!, {
          stage: progress.stage === "merging" ? "packaging" : progress.stage === "preparing" ? "preparing" : "downloading",
          completedUnits: Math.round(progress.percent), totalUnits: 100,
          detail: progress.detail || (progress.stage === "merging" ? "正在合并为可播放的 MP4" : progress.stage === "preparing" ? "正在读取公开视频信息" : `下载进度 ${Math.round(progress.percent)}%`),
        }),
      });
      if (!await localDownloadStore.complete(localTaskId, outputPath)) return false;
      if (generation === loadGeneration) { resourceNotice.value = `视频已下载：${outputPath}`; completedLocalTaskId.value = localTaskId; }
      return true;
    }
    if (provider?.downloadNovel && isNovelResource(resource)) {
      const descriptor = provider.prepareNovelDownload
        ? await provider.prepareNovelDownload(resource.id)
        : {
            title: metadataString(resource, "seriesTitle") || targetMedia.title,
            volume: metadataString(resource, "volumeTitle") || resource.title,
            chapterCount: 0,
          };
      if (!isAbsoluteWindowsPath(settings.obsidianEbookDirectory)) {
        throw new Error("请先在设置中填写有效的 Obsidian 电子书绝对路径");
      }
      const outputPath = joinWindowsPath(settings.obsidianEbookDirectory, `${sanitizeFileName(`${descriptor.title} - ${descriptor.volume}`).slice(0, 165)}.txt`);
      localTaskId = localDownloadStore.create({
        kind: "novel",
        title: `${descriptor.title} · ${descriptor.volume}`,
        sourceName: sourceConfig?.name ?? provider.name,
        directory: settings.obsidianEbookDirectory,
        outputPath,
        totalUnits: descriptor.chapterCount,
        reading: { mediaId: targetMedia.id, seriesTitle: descriptor.title, unitTitle: descriptor.volume, ...(resource.volume !== undefined ? { unitNumber: resource.volume } : {}) },
      });
      await provider.downloadNovel(resource.id, {
        incomingRoot: settings.incomingDirectory,
        outputRoot: settings.obsidianEbookDirectory,
        outputPath,
        isCancelled: () => localDownloadStore.isCancelled(localTaskId!),
        onProgress: (progress) => localDownloadStore.update(localTaskId!, {
          stage: progress.stage,
          completedUnits: progress.completed,
          totalUnits: progress.total,
          detail: progress.detail,
        }),
      });
      if (!await localDownloadStore.complete(localTaskId, outputPath)) return false;
      if (generation === loadGeneration) { resourceNotice.value = `已生成 TXT：${outputPath}（${descriptor.chapterCount} 章）`; completedLocalTaskId.value = localTaskId; }
      return true;
    }
    if ((provider?.prepareMangaDownload || provider?.downloadMangaChapter) && isMangaResource(resource)) {
      const descriptor = provider.prepareMangaDownload
        ? await provider.prepareMangaDownload(resource.id)
        : {
            imageUrls: [],
            title: metadataString(resource, "seriesTitle") || targetMedia.title,
            chapter: metadataString(resource, "chapterName") || resource.title,
          };
      if (!isAbsoluteWindowsPath(settings.obsidianEbookDirectory) || !isAbsoluteWindowsPath(settings.incomingDirectory)) {
        throw new Error("请先在设置中填写有效的 Obsidian 电子书和 Incoming 绝对路径");
      }
      const stamp = `${Date.now()}-${newId()}`;
      const outputRoot = settings.obsidianEbookDirectory;
      const tempDirectory = joinWindowsPath(settings.incomingDirectory, "MangaTemp", stamp);
      // A source work ID identifies the edition. Keep same-title adaptations in
      // separate directories instead of overwriting or resuming another book.
      const edition = metadataString(resource, "editionLabel");
      const editionKey = `${sourceConfig?.id ?? resource.sourceId}-${resource.sourceItemId}`;
      const mangaFile = `${sanitizeFileName(`${descriptor.title} - ${descriptor.chapter}`).slice(0, 165)}.cbz`;
      const editionDirectory = sanitizeFileName(`${descriptor.title} - ${edition || "来源版本"} - ${resource.sourceItemId}`).slice(0, 140);
      const outputPath = joinWindowsPath(outputRoot, editionDirectory, mangaFile);
      localTaskId = localDownloadStore.create({
        kind: "manga",
        title: `${descriptor.title} · ${descriptor.chapter}`,
        sourceName: sourceConfig?.name ?? provider.name,
        directory: outputRoot,
        outputPath,
        cleanupPaths: [
          { path: tempDirectory, allowedRoot: settings.incomingDirectory },
        ],
        totalUnits: descriptor.imageUrls.length,
        reading: { mediaId: targetMedia.id, editionId: editionKey, seriesTitle: descriptor.title + (edition ? ` · ${edition}` : ""), unitTitle: descriptor.chapter, ...(resource.chapter !== undefined ? { unitNumber: resource.chapter } : {}) },
      });
      const input = {
        imageUrls: descriptor.imageUrls,
        incomingRoot: settings.incomingDirectory,
        tempDirectory,
        outputRoot,
        outputPath,
        isCancelled: () => localDownloadStore.isCancelled(localTaskId!),
        onProgress: (progress: { stage: "downloading" | "packaging"; completed: number; total: number; detail?: string }) => localDownloadStore.update(localTaskId!, {
          stage: progress.stage,
          completedUnits: progress.completed,
          totalUnits: progress.total,
          detail: progress.detail,
        }),
        ...(descriptor.referer ? { referer: descriptor.referer } : {}),
        ...(descriptor.cookie ? { cookie: descriptor.cookie } : {}),
      };
      if (provider.downloadMangaChapter) await provider.downloadMangaChapter(resource.id, input);
      else await createMangaChapterService().downloadAndPackage(input);
      if (!await localDownloadStore.complete(localTaskId, outputPath)) return false;
      if (generation === loadGeneration) { resourceNotice.value = `已生成 CBZ：${outputPath}`; completedLocalTaskId.value = localTaskId; }
      return true;
    }
    const target = provider ? await provider.resolve(resource.id) : parseDownloadTarget(resource.targetUrl);
    const configuredDirectory = settings.downloadDirectory || settings.incomingDirectory;
    const friendlyName = sanitizeFileName(resource.title, "未命名资源");
    const directory = configuredDirectory;
    const extension = target.filename?.match(/\.[a-z0-9]{2,8}$/i)?.[0] ?? "";
    const filename = `${friendlyName}${extension}`;
    await downloadStore.add(target.url, directory, { mediaId: targetMedia.id, resourceId: resource.id, sourceName: sourceConfig?.name, filename });
    if (generation === loadGeneration) resourceNotice.value = `已加入下载中心：${resource.title}`;
    return true;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "加入下载失败";
    if (localTaskId) {
      try { await localDownloadStore.fail(localTaskId, message); }
      catch { if (generation === loadGeneration) resourceError.value = "任务已停止，但临时文件清理失败，请在下载中心查看输出位置。"; }
    }
    if (generation === loadGeneration) resourceError.value ||= message;
    if (sourceConfig) await recordSourceDiagnostic(sourceConfig, "resolve", message, { mediaId: targetMedia.id, resourceId: resource.id });
    return false;
  } finally {
    if (generation === loadGeneration) addingResourceId.value = "";
  }
}

function findSourceConfig(sourceId: string): SourceConfig | undefined {
  for (const config of sourceStore.configs) {
    try {
      if (createSourceProvider(config).id === sourceId) return config;
    } catch {
      // Invalid disabled configurations cannot resolve a stored resource.
    }
  }
  return undefined;
}

async function addManualResource(): Promise<void> {
  if (!media.value) return;
  const targetMedia = media.value;
  const generation = loadGeneration;
  manualAdding.value = true;
  resourceError.value = "";
  try {
    const target = parseDownloadTarget(manualResourceUrl.value);
    if (!resourceRepository) await initializeResourceRepository();
    if (!resourceRepository) throw new Error("资源记录存储尚未就绪");
    const resource: ResourceItem = {
      id: `manual:${newId()}`,
      sourceId: "manual",
      sourceItemId: targetMedia.id,
      mediaId: targetMedia.id,
      title: manualResourceTitle.value.trim() || target.filename || target.url,
      protocol: target.protocol,
      targetUrl: target.url,
      metadata: { manual: true, filename: target.filename ?? null },
      createdAt: new Date().toISOString(),
    };
    await resourceRepository.upsert(resource);
    if (generation === loadGeneration) {
      resources.value = [resource, ...resources.value.filter((item) => resourceDedupeKey(item) !== resourceDedupeKey(resource))];
      resourceSourceNames.set(resource.id, "手动链接");
    }
    const settings = loadSettings();
    const directory = settings.downloadDirectory || settings.incomingDirectory;
    await downloadStore.add(target.url, directory, { mediaId: targetMedia.id, resourceId: resource.id, sourceName: "手动链接" });
    if (generation === loadGeneration) {
      manualResourceUrl.value = "";
      manualResourceTitle.value = "";
      resourceNotice.value = "手动链接已关联当前作品并加入下载中心。";
    }
  } catch (cause) {
    if (generation === loadGeneration) resourceError.value = cause instanceof Error ? cause.message : "手动资源添加失败";
  } finally {
    if (generation === loadGeneration) manualAdding.value = false;
  }
}

function toggleResource(resourceId: string): void {
  selectedResourceIds.value = selectedResourceIds.value.includes(resourceId)
    ? selectedResourceIds.value.filter((id) => id !== resourceId)
    : [...selectedResourceIds.value, resourceId];
}

function toggleAllVisible(): void {
  const visibleIds = visibleResources.value.map((resource) => resource.id);
  selectedResourceIds.value = allVisibleSelected.value
    ? selectedResourceIds.value.filter((id) => !visibleIds.includes(id))
    : [...new Set([...selectedResourceIds.value, ...visibleIds])];
}

async function addSelectedResources(): Promise<void> {
  if (addingResourceId.value || batchAdding.value) return;
  const generation = loadGeneration;
  const selected = visibleResources.value.filter((resource) => selectedResourceIds.value.includes(resource.id));
  if (!selected.length) return;
  batchAdding.value = true;
  let failed = 0;
  try {
    for (const resource of selected) {
      if (generation !== loadGeneration) break;
      if (!await addResource(resource)) failed += 1;
    }
    if (generation === loadGeneration) {
      selectedResourceIds.value = [];
      if (failed) resourceError.value = `${failed} 个资源加入下载失败，请查看错误信息并重试。`;
    }
  } finally {
    if (generation === loadGeneration) batchAdding.value = false;
  }
}

async function recordSourceDiagnostic(config: SourceConfig, stage: "search" | "resolve", message: string, snapshot: Record<string, unknown>): Promise<void> {
  if (!diagnosticRepository) return;
  try {
    await diagnosticRepository.record(createSourceDiagnostic({
      sourceId: config.id,
      sourceName: config.name,
      stage,
      message,
      snapshot: { sourceType: config.type, sourceUrl: config.url, ...snapshot },
    }));
  } catch {
    // 诊断记录失败不能影响资源读取或下载操作。
  }
}

async function toggleSaved(): Promise<void> {
  if (!media.value) return;
  saveError.value = "";
  saving.value = true;
  try {
    if (saved.value) await library.remove(media.value.id);
    else await library.save(media.value);
  } catch (cause) {
    saveError.value = cause instanceof Error ? cause.message : "作品保存失败";
  } finally { saving.value = false; }
}

async function setTrackingStatus(status: TrackingStatus): Promise<void> {
  if (!media.value || saving.value) return;
  saving.value = true; saveError.value = "";
  try { await trackingStore.update(media.value, { status, ...(details.value?.episodes ? { total: details.value.episodes } : {}) }); }
  catch (cause) { saveError.value = cause instanceof Error ? cause.message : "追番状态保存失败"; }
  finally { saving.value = false; }
}

async function advanceTracking(): Promise<void> {
  if (!media.value || saving.value) return;
  saving.value = true; saveError.value = "";
  try {
    const next = tracking.value.episode + 1;
    const total = tracking.value.total || details.value?.episodes;
    await trackingStore.update(media.value, { episode: next, status: total && next >= total ? "completed" : "watching", ...(total ? { total } : {}) });
  } catch (cause) { saveError.value = cause instanceof Error ? cause.message : "进度保存失败"; }
  finally { saving.value = false; }
}

function typeLabel(type: Media["type"]): string {
  return { anime: "动画", manga: "漫画", novel: "小说", visual_novel: "视觉小说" }[type];
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function metadataText(value: unknown): string {
  if (Array.isArray(value)) return value.join("、");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "—");
}

function resourceLanguageScore(resource: ResourceItem): number {
  const searchable = `${resource.language ?? ""} ${resource.title}`.toLocaleLowerCase();
  if (/(简中|简体|chs|gb|zh(?:[-_ ]?hans)?(?:[-_ ]?cn)?)/i.test(searchable)) return 3;
  if (/(双语|中英|bilingual|简繁)/i.test(searchable)) return 2;
  if (/(繁中|繁体|cht|big5|zh[-_ ]?hant)/i.test(searchable)) return 1;
  return 0;
}

function isMangaResource(resource: ResourceItem): boolean {
  return resource.metadata.downloadMode === "manga_cbz" || resource.metadata.downloadMode === "jmcomic_cbz";
}

function isNovelResource(resource: ResourceItem): boolean {
  return resource.metadata.downloadMode === "novel_txt";
}

function metadataString(resource: ResourceItem, key: string): string {
  const value = resource.metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value.trim());
}
</script>

<template>
  <div class="subject-detail-page">
    <nav class="subject-breadcrumb"><RouterLink :to="exactSource ? '/resources' : '/search'">← {{ exactSource ? '返回资源搜索' : '返回作品搜索' }}</RouterLink><span v-if="media">{{ typeLabel(media.type) }} <i>/</i> {{ media.title }}</span></nav>
    <div v-if="loading && !media" class="subject-loading-shell" role="status"><div></div><section><i></i><i></i><i></i><p>正在打开作品资料…</p></section></div>
    <section v-if="error && !media" class="subject-load-failed" role="alert"><h1>这次没能打开作品</h1><p>{{ error }}</p><div><button type="button" @click="load">重新加载</button><RouterLink to="/resources">从来源查找作品 →</RouterLink></div></section>
    <template v-if="media">
      <SubjectHero :media="media" :details="details" :saved="saved" :tracking="tracking" :busy="saving" @save="toggleSaved" @resources="openResources" @status="setTrackingStatus" @advance="advanceTracking" />
      <p v-if="saveError || library.error || media.metadata.sourceSaveError" class="subject-inline-error" role="alert">{{ saveError || library.error || media.metadata.sourceSaveError }}；这不会影响当前作品的资料浏览。</p>
      <p v-if="metadataNotice" class="subject-inline-note">{{ metadataNotice }}</p>
      <SubjectResourcePanel :media-type="media.type" v-if="resourcePanelOpen || resources.length" v-model:source="resourceSourceFilter" v-model:keyword="sourceSearchKeyword" v-model:filter="resourceQuery" v-model:protocol="resourceProtocol" v-model:manual-url="manualResourceUrl" v-model:manual-title="manualResourceTitle" :options="resourceSourceOptions" :resources="visibleResources" :selected="selectedResourceIds" :loading="resourceLoading" :queried="resourceSearchRequested" :error="resourceError" :notice="resourceNotice" :adding="addingResourceId" :batch-adding="batchAdding" :source-names="sourceNamesView" :group-titles="resourceGroupTitles" :warnings="resourceWarnings" :manual-adding="manualAdding" :exact="!!exactSource" @search="requestResourceSearch" @enable="enableSourceAndSearch" @add="addResource" @batch="addSelectedResources" @toggle="toggleResource" @toggle-all="toggleAllVisible" @manual="addManualResource" />
      <div v-if="completedLocalTaskId && localDownloadStore.ownedOutputPath(completedLocalTaskId)" class="form-footer"><span class="success-message">下载完成，已可离线观看</span><RouterLink class="primary-button" :to="'/viewer/local/' + encodeURIComponent(completedLocalTaskId)">{{ media.type === 'anime' ? '立即播放' : '立即阅读' }}</RouterLink></div>
      <div class="subject-information-grid">
        <section class="subject-story"><header><h2>关于这部作品</h2><span>{{ details?.airDate || (media.releaseYear ? media.releaseYear + ' 年' : '') }}</span></header><p>{{ details?.summary || media.description || '暂时没有简介。来源作品可以先查看章节和文件，资料后续仍可补充。' }}</p><div v-if="details?.tags.length" class="subject-topic-tags"><span v-for="tag in details.tags.slice(0, 12)" :key="tag">{{ tag }}</span></div><p v-if="detailsError" class="subject-inline-note">{{ detailsError }}</p></section>
        <aside class="subject-facts"><h2>作品信息</h2><dl><template v-if="details?.episodes"><dt>话数</dt><dd>{{ details.episodes }} 话</dd></template><template v-if="details?.studios.length"><dt>制作</dt><dd>{{ details.studios.join(' / ') }}</dd></template><template v-if="details?.developers.length"><dt>开发</dt><dd>{{ details.developers.join(' / ') }}</dd></template><template v-if="details?.platforms.length"><dt>平台</dt><dd>{{ details.platforms.join(' / ') }}</dd></template><template v-if="details?.durationMinutes"><dt>时长</dt><dd>{{ formatDuration(details.durationMinutes) }}</dd></template><dt>类型</dt><dd>{{ typeLabel(media.type) }}</dd><template v-if="media.aliases.length"><dt>别名</dt><dd>{{ media.aliases.slice(0, 4).join(' / ') }}</dd></template></dl></aside>
      </div>
      <section v-if="details?.characters.length" class="subject-characters"><header><h2>登场角色</h2><span>{{ details.characters.length }} 位角色</span></header><div><article v-for="character in details.characters.slice(0, 12)" :key="character.name"><strong>{{ character.name }}</strong><small v-if="character.role">{{ character.role }}</small><p v-if="character.actors.length">CV {{ character.actors.map(actor => actor.name).join(' / ') }}</p></article></div></section>
      <details v-if="details?.staff.length || media.externalIds.length || metadataEntries.length" class="subject-extra"><summary>制作人员与更多资料</summary><div v-if="details?.staff.length" class="subject-staff"><article v-for="member in details.staff.slice(0, 24)" :key="member.name + member.role"><span>{{ member.role || '制作' }}</span><strong>{{ member.name }}</strong></article></div><div class="subject-raw-info"><p v-for="externalId in media.externalIds" :key="externalId.provider + externalId.value"><span>{{ externalId.provider }}</span><code>{{ externalId.value }}</code></p><details v-if="metadataEntries.length"><summary>本机补充记录</summary><p v-for="[key, value] in metadataEntries" :key="key"><span>{{ key }}</span><code>{{ metadataText(value) }}</code></p></details></div></details>
    </template>
  </div>
</template>

<style scoped>
.subject-detail-page{max-width:1400px;margin:0 auto}.subject-breadcrumb{display:flex;align-items:center;gap:20px;margin:0 0 23px;font-size:11px}.subject-breadcrumb>a{white-space:nowrap;color:#ab94bc;text-decoration:none}.subject-breadcrumb>span{color:#c0b2ca;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.subject-breadcrumb i{font-style:normal;margin:0 8px;color:#d7cbdc}.subject-inline-error{font-size:11px;line-height:1.8;color:#c789a1;margin:-10px 0 20px}.subject-inline-note{font-size:10px;color:#b8a4c5;line-height:1.8;margin:0 0 18px}.subject-information-grid{display:grid;grid-template-columns:1.8fr 1fr;gap:42px;margin:34px 0}.subject-story header,.subject-characters header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:15px}.subject-story h2,.subject-facts h2,.subject-characters h2{color:#82688f;font-size:15px;margin:0;font-weight:600}.subject-story header>span,.subject-characters header>span{font-size:10px;color:#c4b4cf}.subject-story>p{font-size:12px;color:#a38db0;line-height:2;white-space:pre-wrap}.subject-story>p.subject-inline-note{font-size:10px;color:#c3b2cf;margin-top:15px}.subject-topic-tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:17px}.subject-topic-tags span{border:1px solid #ebe1f2;color:#b29ac3;font-size:9px;border-radius:6px;padding:5px 9px;background:#fdfafe}.subject-facts{border-left:1px solid #ece3f3;padding-left:27px}.subject-facts dl{display:grid;grid-template-columns:45px 1fr;gap:13px 15px;font-size:10px;margin-top:18px}.subject-facts dt{color:#c2afce}.subject-facts dd{color:#a189af;margin:0;line-height:1.7;overflow-wrap:anywhere}.subject-characters{margin-top:34px}.subject-characters>div{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.subject-characters article{border:1px solid #ece4f2;border-radius:10px;padding:15px;background:#ffffff80}.subject-characters article strong{font-size:11px;color:#9e80af;font-weight:600}.subject-characters article small{font-size:8px;display:block;color:#c3afd0;margin-top:6px}.subject-characters article p{font-size:9px;color:#b39ac2;margin-top:10px;line-height:1.7}.subject-extra{border-top:1px solid #ece4f2;padding-top:21px;margin-top:35px}.subject-extra>summary,.subject-raw-info summary{font-size:11px;color:#b39ac3;cursor:pointer}.subject-staff{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin:23px 0}.subject-staff article{display:flex;gap:15px;font-size:10px}.subject-staff article span{color:#c7b3d2;min-width:40px}.subject-staff strong{color:#ac91bc;font-weight:500}.subject-raw-info{font-size:10px;margin-top:20px}.subject-raw-info p{display:flex;gap:18px;padding:8px 0;color:#c1afcd}.subject-raw-info code{color:#b59ac3;overflow-wrap:anywhere}.subject-raw-info p>span{min-width:90px}.subject-loading-shell{display:grid;grid-template-columns:185px 1fr;gap:30px;padding:32px;border-radius:18px;background:#f0eaf5;margin-bottom:25px}.subject-loading-shell>div{aspect-ratio:2/2.92;background:#e4daec;border-radius:12px}.subject-loading-shell section{display:flex;flex-direction:column;gap:20px;padding-top:15px}.subject-loading-shell i{height:14px;width:55%;background:#e5dbed;border-radius:6px}.subject-loading-shell i:first-child{height:27px;width:70%}.subject-loading-shell section p{color:#b7a3c6;font-size:11px;margin-top:15px}.subject-load-failed{text-align:center;padding:75px 20px;color:#ad96bf}.subject-load-failed h1{font-size:20px;color:#8f72a2;font-weight:550;margin-bottom:17px}.subject-load-failed p{font-size:12px;line-height:1.9;max-width:500px;margin:0 auto}.subject-load-failed>div{display:flex;align-items:center;justify-content:center;gap:20px;margin-top:25px}.subject-load-failed button{border:0;background:#a88dc6;color:white;padding:10px 20px;border-radius:8px;font-size:11px}.subject-load-failed a{font-size:11px;color:#b091c7;text-decoration:none}@media(max-width:750px){.subject-information-grid{grid-template-columns:1fr;gap:25px}.subject-facts{border-left:0;border-top:1px solid #eee5f4;padding:22px 0 0}.subject-facts dl{grid-template-columns:60px 1fr}.subject-breadcrumb>span{display:none}.subject-loading-shell{grid-template-columns:110px 1fr;padding:22px;gap:20px}}
</style>
