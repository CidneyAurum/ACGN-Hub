/** Bangumi uses subject type 1 for both comics and prose. Platform is the
 * authoritative category; adaptation tags must not change a novel into manga. */
export type BangumiBookKind = "manga" | "novel";

const MANGA = new Set(["漫画", "漫畫", "manga", "comic", "comics", "コミック", "マンガ"]);
const LIGHT_NOVEL = new Set(["轻小说", "輕小說", "lightnovel", "lightnovels", "ライトノベル"]);
const NOVEL = new Set(["小说", "小說", "小説", "novel", "novels", ...LIGHT_NOVEL]);
const normalized = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "");

function fields(subject: unknown): Record<string, unknown> | undefined {
  return subject && typeof subject === "object" && !Array.isArray(subject) ? subject as Record<string, unknown> : undefined;
}
function labels(subject: Record<string, unknown>): string[] {
  return [subject.meta_tags, subject.tags].flatMap((value) => Array.isArray(value) ? value : []).flatMap((tag) => {
    if (typeof tag === "string") return [normalized(tag)];
    const item = fields(tag);
    return item ? [item.name, item.name_cn].filter((name): name is string => typeof name === "string").map(normalized) : [];
  });
}

export function classifyBangumiBook(subject: unknown): BangumiBookKind | undefined {
  const item = fields(subject);
  if (!item || item.type !== undefined && item.type !== 1) return;
  const platform = typeof item.platform === "string" ? normalized(item.platform) : "";
  if (MANGA.has(platform)) return "manga";
  if (NOVEL.has(platform)) return "novel";
  // An official artbook/other category must not be replaced by a reader tag.
  if (platform) return undefined;
  const categories = labels(item);
  const manga = categories.some((label) => MANGA.has(label));
  const novel = categories.some((label) => NOVEL.has(label));
  return manga === novel ? undefined : manga ? "manga" : "novel";
}

export function isBangumiLightNovel(subject: unknown): boolean {
  const item = fields(subject);
  if (!item || classifyBangumiBook(item) !== "novel") return false;
  if (typeof item.platform === "string" && LIGHT_NOVEL.has(normalized(item.platform))) return true;
  if (labels({ meta_tags: item.meta_tags }).some((label) => LIGHT_NOVEL.has(label))) return true;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const counted = tags.flatMap((tag) => {
    const entry = fields(tag);
    return entry && typeof entry.count === "number" && Number.isFinite(entry.count) && entry.count >= 0
      ? [{ entry, count: entry.count }] : [];
  });
  if (!counted.length) return labels({ tags }).some((label) => LIGHT_NOVEL.has(label));
  // Search tags are reader supplied: a single joke tag can otherwise classify
  // Crime and Punishment as a light novel. Require a meaningful category signal.
  const threshold = Math.max(2, Math.max(...counted.map((tag) => tag.count)) * 0.1);
  return counted.some(({ entry, count }) => count >= threshold && labels({ tags: [entry] }).some((label) => LIGHT_NOVEL.has(label)));
}
