import type { ResourceItem } from "./resource";
import { joinWindowsPath, sanitizeFileName } from "./organization";

export interface GalgameResourceFilters {
  chinese: boolean;
  windows: boolean;
  game: boolean;
  acquisition: "all" | "direct" | "external";
}

export const emptyGalgameResourceFilters = (): GalgameResourceFilters => ({ chinese: false, windows: false, game: false, acquisition: "all" });

export interface GalgameResourceFacets {
  chinese: boolean;
  windows: boolean;
  content: "game" | "patch" | "trial" | "collection" | "other";
  acquisition: "direct" | "external" | "other";
}

function strings(...values: unknown[]): string[] {
  return values.flatMap((value) => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}
function normalized(value: string): string { return value.normalize("NFKC").toLocaleLowerCase(); }

/** Use declared fields, never infer Chinese from a Chinese work title or Windows from "PC". */
export function galgameResourceFacets(resource: ResourceItem): GalgameResourceFacets {
  const data = resource.metadata;
  const language = normalized(strings(resource.language, data.languages, data.languageLabels, data.language, data.resource_languages).join(" "))
    .replace(/未汉化|未漢化|无汉化|無漢化|不含中文|无中文|無中文|非中文|\b(?:not|no)\s+chinese\b/gi, "");
  const platform = normalized(strings(data.platforms, data.platformLabels, data.platform, data.resource_platforms).join(" "));
  const chinese = /(?:^|[\s/,;|])zh(?:[-_](?:hans|hant|cn|tw|hk))?(?=$|[\s/,;|])/i.test(language)
    || /中文|汉化|漢化|简中|繁中|简体|繁体|簡體|繁體|\bchinese\b/i.test(language);
  const windows = /(?:^|[\s/,;|])win(?:dows)?(?:\s*(?:xp|vista|7|8(?:\.1)?|10|11))?(?=$|[\s/,;|])/i.test(platform);
  const resourceType = normalized(strings(data.resourceType, data.resource_type).join(" "));
  const typeLabel = strings(data.resourceTypeLabel).join(" ");
  const content = data.patch === true || /\bpatch\b/.test(resourceType) || /补丁|補丁/.test(typeLabel) ? "patch"
    : data.releaseType === "trial" || /\btrial\b|\bdemo\b/.test(resourceType) || /试玩|試玩|体验版|體驗版/.test(typeLabel) ? "trial"
    : data.releaseType === "partial" ? "other"
    : /\bcollection\b/.test(resourceType) || /合集/.test(typeLabel) ? "collection"
    : /\bgame\b/.test(resourceType) || data.releaseType === "complete" || /游戏本体|遊戲本體|完整发行版|完整發行版/.test(typeLabel) ? "game" : "other";
  const acquisition = data.downloadMode === "external_link" ? "external"
    : resource.protocol === "http" && ["direct_file", "direct"].includes(String(data.downloadMode)) ? "direct" : "other";
  return { chinese, windows, content, acquisition };
}

export function matchesGalgameResource(resource: ResourceItem, filters: GalgameResourceFilters): boolean {
  const facets = galgameResourceFacets(resource);
  return (!filters.chinese || facets.chinese) && (!filters.windows || facets.windows)
    && (!filters.game || facets.content === "game")
    && (filters.acquisition === "all" || facets.acquisition === filters.acquisition);
}

/** Space-separated words can match different declared fields. */
export function resourceMatchesKeywords(resource: ResourceItem, keyword: string): boolean {
  const terms = normalized(keyword).trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return true;
  const data = resource.metadata;
  const searchable = normalized(strings(resource.title, resource.format, resource.language, resource.resolution, resource.protocol,
    data.resourceTypeLabel, data.resourceType, data.resourceLabel, data.searchTerms, data.text,
    data.languages, data.languageLabels, data.language, data.resource_languages,
    data.platforms, data.platformLabels, data.platform, data.resource_platforms,
    data.providerNames, data.runtimeLabels, data.runtimes, data.resource_runtimes).join(" "));
  const facets = galgameResourceFacets(resource);
  const labels = [searchable, facets.chinese ? "中文 chinese" : "", facets.windows ? "windows" : "",
    facets.content === "game" ? "游戏本体 完整发行版" : facets.content === "patch" ? "补丁" : facets.content === "trial" ? "试玩 体验版" : "",
    facets.acquisition === "direct" ? "文件直链 直接下载" : facets.acquisition === "external" ? "外链 来源页面" : ""].join(" ");
  return terms.every((term) => labels.includes(term));
}

function priority(resource: ResourceItem): number {
  const facets = galgameResourceFacets(resource);
  const preferred = facets.chinese && facets.windows && facets.content === "game" && facets.acquisition === "direct";
  return (preferred ? 1_000 : 0) + (facets.content === "game" ? 100 : 0) + (facets.chinese ? 40 : 0)
    + (facets.windows ? 20 : 0) + (facets.acquisition === "direct" ? 10 : 0)
    - (facets.content === "patch" ? 140 : facets.content === "trial" ? 100 : 0);
}

function updatedTime(resource: ResourceItem): number {
  for (const value of [resource.metadata.sourceUpdatedAt, resource.publishedAt, resource.metadata.released]) {
    if (typeof value !== "string") continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

/** Prefer a declared Chinese Windows game file; preserve source order for equal records. */
export function compareGalgameResources(left: ResourceItem, right: ResourceItem): number {
  return priority(right) - priority(left) || updatedTime(right) - updatedTime(left);
}

/** Keep the shared archive stem and complete split-volume suffix supplied by the source. */
export function galgameDownloadFileName(resource: ResourceItem, targetFilename?: string): string {
  const preferred = strings(resource.metadata.downloadFileName, targetFilename, resource.title).find((value) => value.trim());
  const original = (preferred ?? "未命名资源").trim().replace(/[. ]+$/g, "");
  const suffix = original.match(/(?:\.part\d+\.rar|\.(?:7z|zip)(?:\.\d{3,})?|\.tar\.(?:gz|xz|bz2)|\.[a-z\d]{1,8})$/i)?.[0] ?? "";
  const stem = suffix ? original.slice(0, -suffix.length) : original;
  return sanitizeFileName(stem, "未命名资源").slice(0, 180 - suffix.length) + suffix;
}

/** One source edition owns one directory, including every volume of its archive. */
export async function galgameDownloadDirectory(root: string, resource: Pick<ResourceItem, "sourceId" | "sourceItemId">, workTitle: string): Promise<string> {
  const identity = new TextEncoder().encode(JSON.stringify([resource.sourceId, resource.sourceItemId]));
  const digest = await crypto.subtle.digest("SHA-256", identity);
  const key = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const source = sanitizeFileName(resource.sourceId.split(":")[0], "source").slice(0, 12);
  const title = sanitizeFileName(workTitle, "未命名作品").slice(0, 40);
  return joinWindowsPath(root, "Galgame", `${title} [${source}-${key}]`);
}
