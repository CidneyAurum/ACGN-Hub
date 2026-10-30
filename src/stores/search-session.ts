import { ref } from "vue";
import { defineStore } from "pinia";
import type { SearchCandidate } from "@/application/metadata-ports";
import type { MediaType } from "@/domain/media";
import { isMedia } from "@/infrastructure/library/local-storage-media-repository";

const STORAGE_KEY = "acgn-hub.search-session.v1";
const SEARCH_VIEW_KEY = "acgn-hub.search-view.v1";
const TTL_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

interface StoredCandidate extends SearchCandidate {
  storedAt: number;
}

interface StoredSearchView {
  keyword: string;
  type: MediaType;
  candidates: SearchCandidate[];
  storedAt: number;
}

export const useSearchSessionStore = defineStore("search-session", () => {
  const entries = ref<Record<string, StoredCandidate>>({});
  const searchView = ref<StoredSearchView>();

  initialize();

  function remember(candidates: SearchCandidate[]): void {
    const next = { ...entries.value };
    const storedAt = Date.now();
    for (const candidate of candidates.filter(isCandidate)) next[candidate.media.id] = { ...candidate, storedAt };
    entries.value = prune(next);
    persist();
  }

  function rememberSearch(keyword: string, type: MediaType, candidates: SearchCandidate[]): void {
    remember(candidates);
    searchView.value = { keyword: keyword.trim(), type, candidates: candidates.filter((item) => isCandidate(item) && item.media.type === type), storedAt: Date.now() };
    persistSearchView();
  }

  function restoreSearch(): { keyword: string; type: MediaType; candidates: SearchCandidate[] } | undefined {
    const value = searchView.value;
    if (!value || !isFresh(value.storedAt) || !value.keyword.trim()) return undefined;
    return { keyword: value.keyword, type: value.type, candidates: value.candidates };
  }

  function clearSearch(): void {
    searchView.value = undefined;
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.removeItem(SEARCH_VIEW_KEY);
    } catch {
      // 会话缓存不可用时仍可使用内存结果。
    }
  }

  function find(mediaId: string): SearchCandidate | undefined {
    const item = Object.prototype.hasOwnProperty.call(entries.value, mediaId) ? entries.value[mediaId] : undefined;
    if (!item || !isFresh(item.storedAt)) return undefined;
    return { media: item.media, score: item.score, reason: item.reason };
  }

  function initialize(): void {
    if (typeof window === "undefined") return;
    try {
      const parsed: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}");
      entries.value = prune(parsed);
    } catch {
      entries.value = {};
    }
    try {
      searchView.value = parseSearchView(JSON.parse(window.sessionStorage.getItem(SEARCH_VIEW_KEY) ?? "null"));
    } catch {
      searchView.value = undefined;
    }
  }

  function persist(): void {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value));
    } catch {
      // 会话缓存不可用时仍可使用内存结果。
    }
  }

  function persistSearchView(): void {
    if (typeof window === "undefined") return;
    try {
      if (searchView.value) window.sessionStorage.setItem(SEARCH_VIEW_KEY, JSON.stringify(searchView.value));
    } catch {
      // 会话缓存不可用时仍可使用内存结果。
    }
  }

  function prune(value: unknown): Record<string, StoredCandidate> {
    if (!isRecord(value)) return {};
    const valid = Object.values(value)
      .filter((item): item is StoredCandidate => isCandidate(item) && isFresh((item as StoredCandidate).storedAt))
      .sort((left, right) => right.storedAt - left.storedAt)
      .slice(0, 500);
    const unique = new Map<string, StoredCandidate>();
    for (const item of valid) if (!unique.has(item.media.id)) unique.set(item.media.id, item);
    return Object.fromEntries(unique);
  }

  return { remember, rememberSearch, restoreSearch, clearSearch, find };
});

function isMediaType(value: unknown): value is MediaType {
  return value === "anime" || value === "manga" || value === "novel" || value === "visual_novel";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFresh(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  const age = Date.now() - value;
  return age >= -CLOCK_SKEW_MS && age <= TTL_MS;
}

function isCandidate(value: unknown): value is SearchCandidate {
  return isRecord(value) && isMedia(value.media) && typeof value.score === "number" && Number.isFinite(value.score) &&
    typeof value.reason === "string" && ["exact", "alias", "prefix", "contains", "pinyin", "fuzzy"].includes(value.reason);
}

function parseSearchView(value: unknown): StoredSearchView | undefined {
  if (!isRecord(value) || typeof value.keyword !== "string" || !value.keyword.trim() || !isMediaType(value.type) ||
    !Array.isArray(value.candidates) || !isFresh(value.storedAt)) return undefined;
  return {
    keyword: value.keyword,
    type: value.type,
    candidates: value.candidates.filter((item): item is SearchCandidate => isCandidate(item) && item.media.type === value.type),
    storedAt: value.storedAt,
  };
}
