import type { Media, MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { resourceDedupeKey } from "@/domain/resource";
import type { SourceConfig } from "@/domain/source";
import type { SourceProvider, SourceSearchResult } from "./source-ports";
import { createSourceProvider } from "@/infrastructure/sources/create-source-provider";
import { sourceSupportsType } from "@/infrastructure/sources/source-catalog";
import { parsePublicVideoInput } from "@/infrastructure/sources/public-video-source-provider";
import { rankSourceCandidates, resourceTitleLabels, sourceSearchTerms, seasonNumber } from "@/infrastructure/sources/source-matching";

export interface ResourceDiscoveryInput {
  media?: Media;
  keyword: string;
  aliases?: string[];
  mediaType: MediaType;
  sources: SourceConfig[];
  onSourceResult?: (result: SourceSearchProgress) => void;
}

export interface SourceCandidate {
  candidate: SourceSearchResult;
  config: SourceConfig;
  provider: SourceProvider;
  score: number;
  warnings: string[];
}

export interface DiscoveredResource {
  resource: ResourceItem;
  config: SourceConfig;
  provider: SourceProvider;
  sourceItemTitle: string;
  score: number;
  warnings: string[];
}

export interface SourceFailure { config: SourceConfig; message: string }
export interface SourceSearchProgress {
  config: SourceConfig;
  candidates: SourceCandidate[];
  failure?: SourceFailure;
  completed: number;
  total: number;
}
type ProviderFactory = (config: SourceConfig) => SourceProvider;

/** Search source works only. Chapters are loaded after a work is selected. */
export async function searchSourceCandidates(input: ResourceDiscoveryInput, factory: ProviderFactory = createSourceProvider): Promise<{
  candidates: SourceCandidate[]; failures: SourceFailure[]; searchedSources: number;
}> {
  if (!input.keyword.trim()) throw new Error("请输入作品名、来源作品 ID 或链接");
  const sources = input.sources.filter((config) => config.enabled && sourceSupportsType(config, input.mediaType));
  const aliases = [...new Set([...(input.aliases ?? []), input.media?.title, input.media?.originalTitle, ...(input.media?.aliases ?? [])].filter((value): value is string => Boolean(value)))];
  const terms = sourceSearchTerms(input.keyword, aliases);
  let completed = 0;
  const pending = sources.map(async (config) => {
    try {
      const provider = factory(config);
      const query = { keyword: terms[0], aliases: terms.slice(1), mediaType: input.mediaType,
        subjectId: input.media?.externalIds.find((id) => id.provider === "bangumi")?.value,
        episodeCount: expectedEpisodeCount(input.media) };
      const candidates = await provider.search(query);
      const candidateLimit = input.mediaType === "novel" ? 40 : 12;
      const ranked = rankSourceCandidates(candidates, input.keyword, aliases, config.type === "rss" ? 80 : candidateLimit, {
        allowShortCjk: input.mediaType === "novel" || input.mediaType === "visual_novel",
        matchAuthors: input.mediaType === "novel",
      });
      if (input.mediaType === "anime") {
        const expectedSeason = seasonNumber(input.media?.title ?? input.keyword) ?? 1;
        for (const item of ranked) {
          const season = seasonNumber(item.candidate.title);
          if (season && season !== expectedSeason) {
            item.score -= 50;
            item.warnings.push(`可能属于第 ${season} 季，当前作品为第 ${expectedSeason} 季`);
          }
          const rangeWarnings = resourceTitleLabels(item.candidate.title, input.media?.title ?? input.keyword, expectedEpisodeCount(input.media)).warnings.filter((warning) => warning.startsWith("集数"));
          if (rangeWarnings.length) { item.score -= 50; item.warnings.push(...rangeWarnings); }
        }
        ranked.sort((left, right) => right.score - left.score);
      }
      // An inspected BV has a stable identity even when its title has no text
      // in common with the query. Only that exact BV/page may bypass ranking;
      // malformed IDs and unrelated URL results must not become arbitrary hits.
      const explicitVideoId = config.type === "public_video" ? publicVideoItemId(input.keyword) : undefined;
      const explicitIdentity = candidates.filter((candidate) => candidate.sourceItemId === input.keyword.trim());
      const direct = config.type !== "public_video" && /^(?:\d+|https?:\/\/\S+)$/i.test(input.keyword.trim());
      const selected = explicitVideoId
        ? candidates.filter((candidate) => publicVideoItemId(candidate.sourceItemId) === explicitVideoId)
          .slice(0, 12).map((candidate) => ({ candidate, score: 100, warnings: [] as string[] }))
        : explicitIdentity.length ? explicitIdentity.map((candidate) => ({ candidate, score: 100, warnings: [] as string[] }))
        : ranked.length || !direct ? ranked : candidates.slice(0, 12).map((candidate) => ({ candidate, score: 100, warnings: [] as string[] }));
      for (const item of selected) {
        const sourceWarnings = item.candidate.raw?.warnings;
        item.warnings = mergeWarnings(item.warnings, sourceWarnings);
      }
      return { config, provider, candidates: selected.slice(0, config.type === "rss" ? 40 : candidateLimit).map((item) => ({ ...item, config, provider })) };
    } catch (cause) { return { config, message: errorText(cause) }; }
  });
  const results = await Promise.all(pending.map(async (pendingResult) => {
    const result = await pendingResult;
    input.onSourceResult?.({ config: result.config, candidates: result.candidates ?? [],
      ...(typeof result.message === "string" ? { failure: { config: result.config, message: result.message } } : {}),
      completed: ++completed, total: sources.length });
    return result;
  }));
  return {
    candidates: results.flatMap((result) => result.candidates ?? []),
    failures: results.flatMap((result) => typeof result.message === "string" ? [{ config: result.config, message: result.message }] : []),
    searchedSources: sources.length,
  };
}

/** Metadata details use a bounded best match; direct search exposes all ranked works for confirmation. */
export async function discoverResources(input: ResourceDiscoveryInput, factory: ProviderFactory = createSourceProvider): Promise<{
  items: DiscoveredResource[]; failures: SourceFailure[]; searchedSources: number;
}> {
  const searched = await searchSourceCandidates(input, factory);
  const groups = new Map<string, SourceCandidate[]>();
  for (const candidate of searched.candidates) {
    const values = groups.get(candidate.config.id) ?? [];
    values.push(candidate); groups.set(candidate.config.id, values);
  }
  const items: DiscoveredResource[] = [];
  const failures = [...searched.failures];
  await Promise.all([...groups.values()].map(async (candidates) => {
    const isFeed = candidates[0].config.type === "rss";
    // For chapter-based book sources, do not silently discard a second exact
    // work match: different editions can have materially different chapter
    // ranges (for example an 18-chapter short edition versus a 60-chapter
    // complete edition). The user must see and choose the correct work.
    const bookChoices = candidates.filter((candidate) => candidate.score >= 80);
    const fallbackBooks = input.mediaType === "novel" ? candidates.filter((candidate) => !candidate.warnings.some((warning) => warning.includes("衍生篇"))) : candidates;
    const fileEditions = input.mediaType === "visual_novel" && candidates[0].config.type === "shinnku";
    const choices = fileEditions ? (bookChoices.length ? bookChoices : candidates.slice(0, 1)).slice(0, 8)
      : isFeed ? candidates.slice(0, 24) : input.mediaType === "manga" || input.mediaType === "novel"
      ? (bookChoices.length ? bookChoices : fallbackBooks.slice(0, 1)).slice(0, 12)
      : candidates.slice(0, 1);
    if (!choices.length && input.mediaType === "novel") failures.push({ config: candidates[0].config,
      message: "此来源目前只匹配到番外或衍生篇，未将它当作正篇。请从来源搜索中确认版本，或稍后重试。" });
    for (const choice of choices) {
      try {
        const resources = await choice.provider.listResources(choice.candidate.sourceItemId);
        for (const resource of resources.slice(0, isFeed ? 2 : 2000)) {
          const labels = input.mediaType === "anime" ? resourceTitleLabels(resource.title, input.media?.title ?? input.keyword, expectedEpisodeCount(input.media)) : { warnings: [] };
          const warnings = getResourceWarnings(resource, choice.warnings, labels.warnings);
          items.push({ config: choice.config, provider: choice.provider, sourceItemTitle: choice.candidate.title,
            score: choice.score, warnings, resource: withMatchMetadata(resource, choice.candidate.title, warnings, choice.score, labels) });
        }
        if (!resources.length && !isFeed) failures.push({ config: choice.config, message: input.mediaType === "visual_novel"
          ? `「${choice.candidate.title}」当前未找到发行或资源入口，请选择其它来源或版本。`
          : `「${choice.candidate.title}」当前没有可下载章节，请选择其它来源或作品。` });
      } catch (cause) { failures.push({ config: choice.config, message: errorText(cause) }); }
    }
  }));
  const seen = new Set<string>();
  const unique = items.filter(({ resource }) => {
    const key = resourceDedupeKey(resource);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { items: unique, failures, searchedSources: searched.searchedSources };
}

/** A selected source work survives reload without another broad title search. */
export async function loadSourceItemResources(input: {
  config: SourceConfig; sourceItemId: string; title: string; mediaType?: MediaType;
}, factory: ProviderFactory = createSourceProvider): Promise<{ provider: SourceProvider; resources: ResourceItem[]; warnings: string[] }> {
  const provider = factory(input.config);
  let resources = await provider.listResources(input.sourceItemId);
  if (!resources.length && !["mangadex", "copymanga", "rss", "lnovel"].includes(input.config.type)) {
    const candidates = await provider.search({ keyword: input.title, aliases: [], mediaType: provider.supportedTypes[0] });
    if (candidates.some((candidate) => candidate.sourceItemId === input.sourceItemId)) resources = await provider.listResources(input.sourceItemId);
  }
  const warnings: string[] = [];
  if (!resources.length) warnings.push(provider.supportedTypes.includes("visual_novel")
    ? "当前作品未找到发行或资源入口。可换用其它来源，或打开官网确认发行状态。"
    : "当前作品没有可下载章节或附件。可换用其它来源，或检查该作品是否只提供站外阅读。");
  return { provider, warnings, resources: resources.map((resource) => {
    const labels = (input.mediaType ?? provider.supportedTypes[0]) === "anime" ? resourceTitleLabels(resource.title, input.title) : { warnings: [] };
    return withMatchMetadata(resource, input.title, labels.warnings, 100, labels);
  }) };
}

function withMatchMetadata(resource: ResourceItem, title: string, warnings: string[], score: number, labels: ReturnType<typeof resourceTitleLabels>): ResourceItem {
  return { ...resource, ...(labels.resolution && !resource.resolution ? { resolution: labels.resolution } : {}),
    metadata: { ...resource.metadata, sourceMatchTitle: title, sourceMatchScore: score, matchWarnings: getResourceWarnings(resource, warnings),
      ...(labels.seasonLabel ? { seasonLabel: labels.seasonLabel } : {}) } };
}

/** Keep warnings attached to the file that produced them, alongside match hints. */
export function getResourceWarnings(resource: Pick<ResourceItem, "metadata">, ...groups: unknown[]): string[] {
  return mergeWarnings(...groups, resource.metadata.warnings, resource.metadata.matchWarnings);
}

function mergeWarnings(...groups: unknown[]): string[] {
  return [...new Set(groups.flatMap((group) => Array.isArray(group)
    ? group.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : []))];
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "来源读取失败，请稍后重试"; }

function publicVideoItemId(value: string): string | undefined {
  return parsePublicVideoInput(value)?.itemId;
}

function expectedEpisodeCount(media?: Media): number | undefined {
  const raw = media?.metadata.raw as { eps?: unknown } | undefined;
  return typeof raw?.eps === "number" && raw.eps > 0 ? raw.eps : undefined;
}
