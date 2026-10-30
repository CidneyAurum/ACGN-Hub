import type { SourceSearchResult } from "@/application/source-ports";

// Common title glyph variants; this is a bounded search aid, not a translation engine.
const glyphs: Record<string, string> = {
  無: "无", 職: "职", 転: "转", 轉: "转", 異: "异", 與: "与", 蓮: "莲", 說: "说", 説: "说",
  輕: "轻", 書: "书", 龍: "龙", 風: "风", 劍: "剑", 戰: "战", 體: "体", 實: "实", 強: "强",
  葉: "叶", 夢: "梦", 愛: "爱", 國: "国", 會: "会", 後: "后", 點: "点", 個: "个", 萬: "万",
  還: "还", 這: "这", 麼: "么", 開: "开", 門: "门", 達: "达", 術: "术", 畫: "画", 見: "见",
  腦: "脑", 學: "学", 選: "选", 動: "动", 誌: "志",
};

export function normalizeSourceTitle(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/./gu, (char) => glyphs[char] ?? char)
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function sourceSeriesTitle(value: string): string {
  return value.trim()
    .replace(/\s*[（(]\s*(?:第\s*)?\d+\s*(?:卷|巻|集)?\s*[）)]\s*$/u, "")
    .replace(/\s*(?:第\s*)?\d+\s*[卷巻]\s*$/u, "")
    .replace(/\s+(?:vol\.?\s*)?\d+\s*$/iu, "")
    .split(/\s*[~～〜]\s*/u)[0].trim();
}

export function sourceSearchTerms(keyword: string, aliases: string[] = [], maximum = 4): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed); terms.push(trimmed);
  };
  // Keep the user's query first. Compact series forms follow before long aliases.
  add(keyword);
  const series = sourceSeriesTitle(keyword);
  add(series.replace(/./gu, (char) => glyphs[char] ?? char));
  for (const alias of aliases) add(sourceSeriesTitle(alias).replace(/./gu, (char) => glyphs[char] ?? char));
  for (const alias of aliases) add(alias);
  return terms.slice(0, maximum);
}

export function sourceTitleMatch(title: string, terms: string[], aliases: string[] = []): { score: number; warnings: string[] } {
  const queries = terms.map(normalizeSourceTitle).filter(Boolean);
  const names = [title, ...aliases.flatMap((alias) => alias.split(/[,，;；\n]/u))].map(normalizeSourceTitle).filter(Boolean);
  let score = 0;
  for (const query of queries) for (const name of names) {
    if (name === query) score = Math.max(score, 100);
    else if (Math.min(name.length, query.length) >= 3 && (name.startsWith(query) || query.startsWith(name))) score = Math.max(score, 82);
    else if (query.length >= 3 && name.includes(query)) score = Math.max(score, 70);
  }
  const warnings: string[] = [];
  const related = /同人|doujin|合集|anthology|作品集|插画集|插畫集|蛇足篇|番外|外传|外傳|短篇集/iu;
  if (score > 0 && related.test(title) && !terms.some((term) => related.test(term))) {
    score -= 30; warnings.push("同人、合集或衍生篇，请确认是否为所需作品");
  }
  const clip = /\b(?:OST|BGM|COVER|AMV|MMD|MAD|TRAILER|OP\d*|ED\d*|PV\d*|CM|UNBOXING|MEDIA\s+HISTORY)\b|翻唱|译配|譯配|汉化MV|漢化MV|预告|預告|予告|番宣|特報|剪辑|剪輯|解说|解說|背景音乐|背景音樂/iu;
  if (score > 0 && clip.test(title) && !terms.some((term) => clip.test(term))) {
    score -= 35; warnings.push("音乐、片段或二创内容，不是正片剧集");
  }
  return { score, warnings };
}

export function sourceCandidateAliases(candidate: SourceSearchResult): string[] {
  const raw = candidate.raw;
  if (!raw) return [];
  const names: string[] = [];
  if (typeof raw.alias === "string") names.push(...raw.alias.split(/[,，;；\n]/u));
  const attributes = raw.attributes as { title?: Record<string, unknown>; altTitles?: Record<string, unknown>[] } | undefined;
  if (attributes?.title) names.push(...Object.values(attributes.title).filter((value): value is string => typeof value === "string"));
  for (const values of attributes?.altTitles ?? []) names.push(...Object.values(values).filter((value): value is string => typeof value === "string"));
  return names;
}

export function rankSourceCandidates(candidates: SourceSearchResult[], keyword: string, aliases: string[] = [], limit = 12) {
  const terms = sourceSearchTerms(keyword, aliases);
  const unique = new Map<string, SourceSearchResult>();
  for (const candidate of candidates) unique.set(candidate.sourceItemId, candidate);
  return [...unique.values()].map((candidate) => ({ candidate, ...sourceTitleMatch(candidate.title, terms, sourceCandidateAliases(candidate)) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.title.localeCompare(right.candidate.title))
    .slice(0, limit);
}

export function seasonNumber(title: string): number | undefined {
  const match = title.match(/(?:第\s*([一二三四五六七八九十\d]+)\s*[季期])|(?:\bS(?:eason)?\s*0*(\d+)\b)|(?:\b(\d+)(?:st|nd|rd|th)\s+season\b)/iu);
  const text = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!text) return undefined;
  return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as Record<string, number>)[text] ?? Number(text);
}

export function resourceTitleLabels(title: string, expectedTitle?: string, expectedEpisodes?: number): { seasonLabel?: string; resolution?: string; warnings: string[] } {
  const season = seasonNumber(title);
  const expected = expectedTitle ? seasonNumber(expectedTitle) ?? 1 : undefined;
  const warnings: string[] = [];
  if (season && expected && season !== expected) warnings.push(`可能属于第 ${season} 季，当前作品为第 ${expected} 季`);
  const range = title.match(/[\[【(（|]\s*(\d{1,3})\s*[-~～至]\s*(\d{1,3})/u);
  if (range && expectedEpisodes && Number(range[1]) > expectedEpisodes) warnings.push(`集数 ${range[1]}–${range[2]} 超出本作 ${expectedEpisodes} 集，请核对季度`);
  if (/\bS\d+\s*\+\s*S\d+|[跨全]季|全集|合集/iu.test(title)) warnings.push("合集或跨季资源，请确认集数范围");
  const resolution = title.match(/(?:2160p|1080p|720p|480p|4k)/iu)?.[0];
  return { ...(season ? { seasonLabel: `第 ${season} 季` } : {}), ...(resolution ? { resolution: resolution.toUpperCase() } : {}), warnings };
}
