<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { FeedDocument, FeedItem } from "@/domain/feed";
import { FeedProviderError, RssAtomProvider } from "@/infrastructure/feeds/rss-atom-provider";
import { RssSourceProvider } from "@/infrastructure/feeds/rss-source-provider";
import { useDownloadStore } from "@/stores/download";
import { loadSettings } from "@/shared/settings";
import { useMediaLibraryStore } from "@/stores/media-library";
import { createResourceRepository } from "@/infrastructure/database/create-resource-repository";
import type { ResourceRepository } from "@/application/resource-ports";
import { useSourceConfigStore } from "@/stores/source-config";
import { parseDownloadTarget } from "@/shared/validation";

const provider = new RssAtomProvider();
const store = useDownloadStore();
const library = useMediaLibraryStore();
const sources = useSourceConfigStore();
const configuredFeeds = computed(() => sources.enabledConfigs.filter((source) => source.type === "rss"));
const feedUrl = ref("");
const initialSettings = loadSettings();
const directory = ref(initialSettings.downloadDirectory || initialSettings.incomingDirectory);
const feed = ref<FeedDocument>();
const loading = ref(false);
const addingId = ref("");
const error = ref("");
const success = ref("");
const associations = ref<Record<string, string>>({});
let resourceRepository: ResourceRepository | undefined;

onMounted(async () => {
  await Promise.allSettled([library.initialize(), sources.initialize(), initializeResources()]);
});

async function initializeResources(): Promise<void> {
  try {
    resourceRepository = await createResourceRepository();
  } catch {
    error.value = "资源记录存储初始化失败";
  }
}

async function loadFeed(): Promise<void> {
  error.value = "";
  success.value = "";
  feed.value = undefined;
  loading.value = true;
  try {
    feed.value = await provider.read(feedUrl.value);
  } catch (cause) {
    error.value = cause instanceof FeedProviderError ? cause.message : "读取 Feed 失败，请稍后重试";
  } finally {
    loading.value = false;
  }
}

async function addDownload(item: FeedItem): Promise<void> {
  const currentFeed = feed.value;
  if (!currentFeed) return;
  const mediaId = associations.value[item.id];
  const media = library.items.find((saved) => saved.id === mediaId);
  if (!media) {
    error.value = "请先为 RSS 条目选择已收藏作品，再加入下载";
    return;
  }
  error.value = "";
  success.value = "";
  addingId.value = item.id;
  try {
    // Work from the feed the user reviewed instead of re-fetching it while
    // the user confirms a row; the remote feed may have changed meanwhile.
    const source = new RssSourceProvider(currentFeed.sourceUrl, { id: "reviewed-feed", read: async () => currentFeed });
    const resource = (await source.listResources(item.id))[0];
    if (!resource) throw new Error("该 RSS 条目没有可解析的下载资源");
    if (!resourceRepository) throw new Error("资源记录存储尚未就绪，请稍后重试");
    const associatedResource = { ...resource, mediaId: media.id };
    await resourceRepository.upsert(associatedResource);
    const target = await source.resolve(resource.id);
    await store.add(target.url, directory.value, { mediaId: media.id, resourceId: resource.id, sourceName: "RSS/Atom" });
    success.value = `已关联「${media.title}」并加入下载：${item.title}`;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加入下载失败";
  } finally {
    addingId.value = "";
  }
}

function hasDownloadTarget(item: FeedItem): boolean {
  if (item.enclosure?.url) {
    try { parseDownloadTarget(item.enclosure.url); return true; } catch { /* Check other supported targets. */ }
  }
  if (item.url && /^(?:magnet:)|\.(?:torrent|zip|7z|rar|pdf|epub|mobi|mp4|mkv)(?:$|[?#])/i.test(item.url)) return true;
  try {
    return /(?:^|\.)acgnx\.se$/i.test(new URL(item.sourceUrl).hostname) &&
      /\b[a-f0-9]{40}\b/i.test([item.description, item.url, item.metadata.guid].join(" "));
  } catch { return false; }
}

function description(item: FeedItem): string {
  return item.description?.replace(/\s+/g, " ").trim() || "暂无简介";
}

function formatDate(value?: string): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">发现订阅里的新内容</p>
      <h2>订阅发现</h2>
      <p class="muted">读取 RSS / Atom 更新，确认作品和附件后加入下载。自动按协议连接对应引擎。</p>
    </div>
    <RouterLink class="ghost-button" to="/sources">管理来源</RouterLink>
  </section>

  <section class="card">
    <label v-if="configuredFeeds.length" class="feed-preset-picker">使用已启用的订阅<select v-model="feedUrl"><option value="">选择订阅，或在下方输入地址</option><option v-for="source in configuredFeeds" :key="source.id" :value="source.url">{{ source.name }}</option></select></label>
    <form class="feed-form" @submit.prevent="loadFeed">
      <label>
        <span>Feed 地址</span>
        <input v-model="feedUrl" type="url" placeholder="https://example.com/feed.xml" required />
      </label>
      <label>
        <span>下载目录</span>
        <input v-model="directory" type="text" placeholder="例如 D:\\ACGN\\Incoming" required />
      </label>
      <button class="primary-button" :disabled="loading" type="submit">{{ loading ? "读取中…" : "读取 Feed" }}</button>
    </form>
    <p class="hint">仅允许公开 HTTP/HTTPS Feed；本机、私有网络和带认证信息的地址会被拒绝。</p>
    <p v-if="!library.items.length" class="hint">请先在“作品搜索”中收藏作品，RSS 条目才能进行人工关联。</p>
    <p v-if="error" class="error-message">{{ error }}</p>
    <p v-if="library.error || sources.error" class="error-message">{{ library.error || sources.error }}</p>
    <p v-if="success" class="success-message">{{ success }}</p>
  </section>

  <section v-if="feed" class="card">
    <div class="card-heading">
      <div>
        <h3>{{ feed.title }}</h3>
        <p class="muted">{{ feed.items.length }} 个条目 · {{ feed.format.toUpperCase() }}</p>
      </div>
      <a v-if="feed.url" class="small-link" :href="feed.url" target="_blank" rel="noreferrer">打开来源</a>
    </div>

    <div v-if="!feed.items.length" class="empty-state">
      <strong>Feed 没有条目</strong>
      <span>可以检查地址是否为更新源，而不是普通网页。</span>
    </div>

    <div v-else class="feed-list">
      <article v-for="item in feed.items" :key="item.id" class="feed-item">
        <div class="feed-item-main">
          <div class="feed-item-heading">
            <strong>{{ item.title }}</strong>
            <span>{{ formatDate(item.publishedAt || item.updatedAt) }}</span>
          </div>
          <p class="feed-meta">
            <span v-if="item.author">作者：{{ item.author }}</span>
            <span v-for="category in item.categories" :key="category" class="tag-pill">{{ category }}</span>
          </p>
          <p class="feed-description">{{ description(item) }}</p>
          <a v-if="item.url" class="small-link" :href="item.url" target="_blank" rel="noreferrer">查看条目</a>
        </div>
        <div class="feed-item-actions">
          <span v-if="item.enclosure" class="enclosure-label">{{ item.enclosure.type || "可下载附件" }}</span>
          <select v-model="associations[item.id]" :disabled="!library.items.length" aria-label="关联作品">
            <option value="">选择已收藏作品</option>
            <option v-for="media in library.items" :key="media.id" :value="media.id">{{ media.title }}</option>
          </select>
          <button
            class="small-button"
            :disabled="!hasDownloadTarget(item) || !associations[item.id] || addingId === item.id"
            type="button"
            @click="addDownload(item)"
          >
            {{ addingId === item.id ? "加入中…" : hasDownloadTarget(item) ? "加入下载" : "无附件" }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>
