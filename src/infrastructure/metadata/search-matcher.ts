import { pinyin } from "pinyin-pro";
import type { Media } from "@/domain/media";
import type { SearchCandidate, SearchMatchReason } from "@/application/metadata-ports";

const SEARCH_INDEX_KEY = "acgn-hub.search-index.v1";
const MAX_INDEX_ITEMS = 2_000;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u3000\s]+/g, "")
    .replace(/[\p{P}\p{S}]+/gu, "");
}

function pinyinVariants(value: string): string[] {
  const source = value.trim();
  if (!source) return [];
  return [
    pinyin(source, { toneType: "none", type: "string" }).replace(/\s+/g, "").toLocaleLowerCase(),
    pinyin(source, { pattern: "initial", type: "array" }).join("").toLocaleLowerCase(),
  ].filter(Boolean);
}

function titleVariants(media: Media): string[] {
  return [...new Set([media.title, media.originalTitle, ...media.aliases].filter((value): value is string => Boolean(value)))];
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious: number[] | undefined;
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
      if (beforePrevious && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        current[column] = Math.min(current[column], beforePrevious[column - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length];
}

function isChinese(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function scoreVariant(keyword: string, variant: string, isPrimaryTitle: boolean): { score: number; reason: SearchMatchReason } | undefined {
  const normalizedKeyword = normalizeSearchText(keyword);
  const normalizedVariant = normalizeSearchText(variant);
  if (!normalizedKeyword || !normalizedVariant) return undefined;
  const chineseBonus = isChinese(variant) ? 4 : 0;
  if (normalizedVariant === normalizedKeyword) {
    return { score: (isPrimaryTitle ? 100 : 94) + chineseBonus, reason: isPrimaryTitle ? "exact" : "alias" };
  }
  if (normalizedVariant.startsWith(normalizedKeyword)) return { score: 84 + chineseBonus, reason: "prefix" };
  if (normalizedVariant.includes(normalizedKeyword)) return { score: 72 + chineseBonus, reason: "contains" };

  const queryPinyin = pinyinVariants(keyword);
  const variantPinyin = pinyinVariants(variant);
  if (queryPinyin.some((query) => variantPinyin.some((candidate) => candidate === query || candidate.startsWith(query)))) {
    return { score: 78 + chineseBonus, reason: "pinyin" };
  }

  const distance = editDistance(normalizedKeyword, normalizedVariant);
  const allowed = normalizedKeyword.length <= 6 ? 1 : 2;
  if (distance <= allowed) return { score: Math.max(55, 76 - distance * 8) + chineseBonus, reason: "fuzzy" };
  return undefined;
}

export function rankMedia(keyword: string, media: Media[]): SearchCandidate[] {
  return media
    .map((item) => {
      let best: SearchCandidate | undefined;
      for (const [index, variant] of titleVariants(item).entries()) {
        const match = scoreVariant(keyword, variant, index === 0);
        if (!match || (best && best.score >= match.score)) continue;
        best = { media: item, score: match.score, reason: match.reason };
      }
      return best;
    })
    .filter((item): item is SearchCandidate => Boolean(item))
    .sort((left, right) => right.score - left.score || left.media.title.localeCompare(right.media.title));
}

export class LocalMediaIndex {
  private items: Media[];

  constructor(private readonly storage: StorageLike | undefined = defaultStorage()) {
    this.items = readItems(storage);
  }

  search(keyword: string, type: Media["type"]): SearchCandidate[] {
    return rankMedia(keyword, this.items.filter((item) => item.type === type));
  }

  remember(media: Media[]): void {
    const merged = new Map(this.items.map((item) => [item.id, item]));
    for (const item of media) merged.set(item.id, item);
    this.items = [...merged.values()].slice(-MAX_INDEX_ITEMS);
    try {
      this.storage?.setItem(SEARCH_INDEX_KEY, JSON.stringify(this.items));
    } catch {
      // 本地索引写入失败不应影响远端搜索。
    }
  }
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function readItems(storage?: StorageLike): Media[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(SEARCH_INDEX_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isMedia).slice(-MAX_INDEX_ITEMS) : [];
  } catch {
    return [];
  }
}

function isMedia(value: unknown): value is Media {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Media>;
  return typeof item.id === "string" &&
    ["anime", "manga", "novel", "visual_novel"].includes(item.type ?? "") &&
    typeof item.title === "string" && Array.isArray(item.aliases) && item.aliases.every((alias) => typeof alias === "string") &&
    Array.isArray(item.externalIds) && typeof item.metadata === "object" && item.metadata !== null;
}
