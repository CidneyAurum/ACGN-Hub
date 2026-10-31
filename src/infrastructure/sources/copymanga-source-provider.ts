import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { parseDownloadTarget } from "@/shared/validation";
import { sourceSearchTerms, sourceTitleMatch } from "./source-matching";

const comicSchema = z.object({
  name: z.string().min(1),
  alias: z.string().nullable().optional().transform((value) => value ?? ""),
  path_word: z.string().min(1),
  cover: z.string().nullable().optional().transform((value) => value || undefined),
  ban: z.number().nullable().optional(),
  author: z.array(z.object({ name: z.string().min(1) }).passthrough()).optional().default([]),
}).passthrough();

const searchResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional().default(""),
  results: z.object({ list: z.array(comicSchema).default([]) }).nullable().optional(),
}).passthrough();

const chapterSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().min(1),
  index: z.number().nullable().optional().transform((value) => value ?? undefined),
  comic_path_word: z.string().nullable().optional().transform((value) => value || undefined),
}).passthrough();

const chapterListResponseSchema = z.object({
  code: z.number(),
  results: z.object({ list: z.array(chapterSchema).default([]), total: z.number().optional() }).nullable().optional(),
}).passthrough();

const groupSchema = z.object({ path_word: z.string().min(1) }).passthrough();

const comicDetailResponseSchema = z.object({
  code: z.number(),
  results: z.object({
    groups: z.record(z.string(), groupSchema).optional(),
    comic: comicSchema.optional(),
  }).nullable().optional(),
}).passthrough();

const pageSchema = z.object({ url: z.string().url() }).passthrough();
const chapterDetailResponseSchema = z.object({
  code: z.number(),
  results: z.object({
    comic: z.object({ name: z.string().nullable().optional() }).passthrough().optional(),
    chapter: z.object({
      name: z.string().nullable().optional(),
      contents: z.array(pageSchema).default([]),
      words: z.array(z.number()).optional(),
    }).passthrough(),
  }).nullable().optional(),
}).passthrough();

type Comic = z.infer<typeof comicSchema>;
type Chapter = z.infer<typeof chapterSchema>;

interface CopyMangaSourceProviderOptions {
  fetcher?: JsonFetcher;
  timeoutMs?: number;
  token?: string;
}

interface ChapterResource {
  resource: ResourceItem;
  comicTitle: string;
  pathWord: string;
  groupWord: string;
  chapter: Chapter;
}

const COPYMANGA_API_VERSION = "2024.4.28";

export class CopyMangaSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "拷贝漫画章节";
  readonly supportedTypes: MediaType[] = ["manga"];
  private readonly baseUrl: string;
  private readonly apiOrigins: string[];
  private readonly authorization: string;
  private readonly fetcher: JsonFetcher;
  private readonly timeoutMs: number;
  private readonly comics = new Map<string, Comic>();
  private readonly chapters = new Map<string, ChapterResource>();

  constructor(baseUrl = "https://mapi.hotmangasg.com", options: CopyMangaSourceProviderOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("拷贝漫画 API 地址必须是不带认证信息的 HTTP/HTTPS 地址");
    }
    this.baseUrl = parsed.origin;
    // Never send a user's token to unconfigured fallback hosts.
    this.apiOrigins = [this.baseUrl];
    const token = options.token?.trim() || parsed.searchParams.get("token")?.trim() || "";
    this.authorization = token
      ? (/^(?:Bearer|Token)\s+/i.test(token) ? token : `Token ${token}`)
      : "";
    this.id = `copymanga:${this.baseUrl}`;
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "manga") return [];
    const terms = sourceSearchTerms(query.keyword, query.aliases, 3);
    const comics = new Map<string, Comic>();
    let succeeded = false;
    let failure: unknown;
    for (const term of terms) {
      let items: Comic[];
      try { items = await this.searchComics(term); succeeded = true; } catch (cause) { failure = cause; continue; }
      for (const comic of items) {
        if (sourceTitleMatch(comic.name, terms, [comic.alias]).score <= 0) continue;
        comics.set(comic.path_word, comic);
      }
      if ([...comics.values()].some((comic) => sourceTitleMatch(comic.name, terms, [comic.alias]).score >= 100)) break;
    }
    if (!succeeded && failure) throw failure;
    this.comics.clear();
    this.chapters.clear();
    return [...comics.values()].sort((left, right) => sourceTitleMatch(right.name, terms, [right.alias]).score - sourceTitleMatch(left.name, terms, [left.alias]).score).slice(0, 24).map((comic) => {
      this.comics.set(comic.path_word, comic);
      return {
        sourceId: this.id,
        sourceItemId: comic.path_word,
        title: comic.name,
        ...(comic.cover ? { coverUrl: comic.cover } : {}),
        raw: { ...(comic as unknown as Record<string, unknown>), ...comicEditionMetadata(comic),
          ...(latestComicChapter(comic) ? { latestChapter: latestComicChapter(comic) } : {}) },
      };
    });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const groups = await this.loadGroups(sourceItemId);
    const comic = this.comics.get(sourceItemId) ?? { name: sourceItemId, path_word: sourceItemId, alias: "", cover: undefined, author: [] };
    const result: ResourceItem[] = [];
    for (const groupWord of groups) {
      const chapters = await this.loadChapters(sourceItemId, groupWord);
      const latestChapter = latestNumberedChapter(chapters);
      for (const chapter of chapters) {
      const detailUrl = this.chapterDetailUrl(sourceItemId, chapter.uuid);
        const resource: ResourceItem = {
          id: `${this.id}:${sourceItemId}:${groupWord}:${chapter.uuid}`,
          sourceId: this.id,
          sourceItemId,
          title: `${comic.name} · ${chapter.name}`,
          protocol: "http",
          targetUrl: detailUrl,
          ...(chapterNumber(chapter.name) !== undefined ? { chapter: chapterNumber(chapter.name) } : {}),
          format: "CBZ",
          metadata: {
            provider: "拷贝漫画",
            downloadMode: "manga_cbz",
            pathWord: sourceItemId,
            groupWord,
            chapterUuid: chapter.uuid,
            chapterName: chapter.name,
            seriesTitle: comic.name,
            ...comicEditionMetadata(comic),
            chapterCount: chapters.length,
            ...(latestChapter ? { latestChapter } : {}),
            authentication: this.authorization ? "configured" : "public_or_login",
          },
          createdAt: new Date().toISOString(),
        };
        const entry = { resource, comicTitle: comic.name, pathWord: sourceItemId, groupWord, chapter };
        this.chapters.set(resource.id, entry);
        result.push(resource);
      }
    }
    if (result.length === 0) {
      throw new Error(this.authorization
        ? "拷贝漫画章节列表为空；该作品可能没有公开章节或当前接口节点暂时不可用"
        : "拷贝漫画搜索正常，但该作品章节接口需要登录 Token；请在来源管理中完成账号登录或粘贴 Token");
    }
    for (const resource of result) resource.metadata.chapterCount = result.length;
    return result;
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const entry = this.chapters.get(resourceId);
    if (!entry) throw new Error("拷贝漫画章节已过期，请重新刷新来源");
    return parseDownloadTarget(entry.resource.targetUrl);
  }

  restoreResource(resource: ResourceItem): void {
    if (resource.sourceId !== this.id || resource.metadata.provider !== "拷贝漫画") return;
    const pathWord = resource.metadata.pathWord;
    const chapterUuid = resource.metadata.chapterUuid;
    if (typeof pathWord !== "string" || !pathWord || typeof chapterUuid !== "string" || !chapterUuid) {
      throw new Error("已保存的拷贝漫画章节缺少标识，请重新搜索资源");
    }
    const chapterName = typeof resource.metadata.chapterName === "string" ? resource.metadata.chapterName : resource.title;
    const comicTitle = typeof resource.metadata.seriesTitle === "string" ? resource.metadata.seriesTitle : pathWord;
    this.chapters.set(resource.id, {
      resource, pathWord, comicTitle,
      groupWord: typeof resource.metadata.groupWord === "string" ? resource.metadata.groupWord : "default",
      chapter: { uuid: chapterUuid, name: chapterName, index: undefined, comic_path_word: undefined },
    });
  }

  async prepareMangaDownload(resourceId: string) {
    const entry = this.chapters.get(resourceId);
    if (!entry) throw new Error("拷贝漫画章节已过期，请重新刷新来源");
    const response = await this.fetchChapterDetail(entry.pathWord, entry.chapter.uuid);
    const parsed = chapterDetailResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.code !== 200 || !parsed.data.results?.chapter) {
      throw new Error("拷贝漫画章节详情不可用；请先在来源管理中完成账号登录，或检查该章节是否需要会员权限");
    }
    const detail = parsed.data.results;
    const imageUrls = detail.chapter.contents
      .map((page) => upgradeImageUrl(page.url))
      .filter((url, index, all) => all.indexOf(url) === index);
    if (!imageUrls.length) throw new Error("拷贝漫画章节没有可下载图片");
    return {
      imageUrls,
      title: detail.comic?.name?.trim() || entry.comicTitle,
      chapter: detail.chapter.name?.trim() || entry.chapter.name,
      referer: "https://www.mangacopy.com/",
    };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const comics = await this.searchComics("海贼王");
      if (!comics.length) throw new Error("拷贝漫画搜索成功，但没有返回可用作品");
      return { ok: true, checkedAt, message: this.authorization
        ? "搜索接口连接正常；Token 有效性及章节权限将在下载时检查"
        : "公开搜索接口连接正常；部分章节可能需要登录，图片可用性将在下载时检查" };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "拷贝漫画 API 不可用" };
    }
  }

  private async searchComics(keyword: string): Promise<Comic[]> {
    let lastMessage = "拷贝漫画搜索响应无效";
    for (const origin of this.apiOrigins) {
      try {
        const url = `${origin}/api/v3/search/comic?platform=3&q=${encodeURIComponent(keyword)}&_update=true&limit=24&offset=0`;
        const parsed = searchResponseSchema.safeParse(await this.fetchJson(url));
        if (parsed.success && parsed.data.code === 200) return parsed.data.results?.list ?? [];
        if (parsed.success && parsed.data.message) lastMessage = `拷贝漫画 API：${parsed.data.message}`;
      } catch (cause) {
        lastMessage = cause instanceof Error ? cause.message : lastMessage;
      }
    }
    throw new Error(lastMessage);
  }

  private async loadGroups(pathWord: string): Promise<string[]> {
    for (const origin of this.apiOrigins) {
      try {
      const parsed = comicDetailResponseSchema.safeParse(await this.fetchJson(`${origin}/api/v3/comic2/${encodeURIComponent(pathWord)}?platform=3&_update=true`));
      const comic = parsed.success ? parsed.data.results?.comic : undefined;
      if (comic) this.comics.set(pathWord, comic);
      const groups = parsed.success ? parsed.data.results?.groups : undefined;
      const values = groups ? Object.values(groups).map((group) => group.path_word).filter(Boolean) : [];
      if (values.length) return [...new Set(values)];
      } catch {
        // Try the next public API node.
      }
    }
    return ["default"];
  }

  private async loadChapters(pathWord: string, groupWord: string): Promise<Chapter[]> {
    let lastError = "";
    for (const origin of this.apiOrigins) {
      try {
        const all: Chapter[] = [];
        for (let offset = 0; offset <= 2_000; offset += 100) {
          const url = `${origin}/api/v3/comic/${encodeURIComponent(pathWord)}/group/${encodeURIComponent(groupWord)}/chapters?limit=100&offset=${offset}&platform=3&_update=true`;
          const parsed = chapterListResponseSchema.safeParse(await this.fetchJson(url));
          if (!parsed.success || parsed.data.code !== 200) throw new Error("拷贝漫画章节列表响应无效");
          const page = parsed.data.results?.list ?? [];
          all.push(...page);
          const total = parsed.data.results?.total ?? all.length;
          if (!page.length || all.length >= total) break;
        }
        return [...new Map(all.map((chapter) => [chapter.uuid, chapter])).values()]
          .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : lastError;
      }
    }
    if (lastError) throw new Error(lastError);
    return [];
  }

  private chapterDetailUrl(pathWord: string, uuid: string): string {
    return `${this.apiOrigins[0]}/api/v3/comic/${encodeURIComponent(pathWord)}/chapter/${encodeURIComponent(uuid)}?platform=3&_update=true`;
  }

  private async fetchChapterDetail(pathWord: string, uuid: string): Promise<unknown> {
    let lastError = "拷贝漫画章节详情请求失败";
    for (const origin of this.apiOrigins) {
      for (const version of ["", "2"]) {
        try {
          const suffix = version ? `chapter${version}` : "chapter";
          const url = `${origin}/api/v3/comic/${encodeURIComponent(pathWord)}/${suffix}/${encodeURIComponent(uuid)}?platform=3&_update=true`;
          const response = await this.fetchJson(url);
          const parsed = chapterDetailResponseSchema.safeParse(response);
          if (parsed.success && parsed.data.code === 200 && parsed.data.results?.chapter) return response;
          lastError = "拷贝漫画章节详情响应无效";
        } catch (cause) {
          lastError = cause instanceof Error ? cause.message : lastError;
        }
      }
    }
    throw new Error(lastError);
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": `COPY/${COPYMANGA_API_VERSION}`,
        version: COPYMANGA_API_VERSION,
        source: "Official",
        "x-requested-with": "com.manga2020.app",
        platform: "3",
        region: "1",
        webp: "1",
        ...(this.authorization ? { authorization: this.authorization } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`拷贝漫画 API HTTP ${response.status}`);
    return response.json();
  }
}

function upgradeImageUrl(value: string): string {
  return value.replace(/c800x\.(?:jpg|jpeg|webp)$/i, (match) => match.toLowerCase().endsWith("webp") ? "c1500x.webp" : "c1500x.jpg");
}

function comicEditionMetadata(comic: Comic): { authors: string[]; editionLabel: string } {
  const authors = [...new Set(comic.author.map((item) => item.name.trim()).filter(Boolean))];
  return { authors, editionLabel: authors.length ? authors.join(" / ") + "版" : "拷贝漫画版本 · " + comic.path_word };
}

function latestComicChapter(comic: Comic): string | undefined {
  const raw = comic.last_chapter;
  return raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).name === "string"
    ? ((raw as Record<string, unknown>).name as string).trim() || undefined : undefined;
}

function latestNumberedChapter(chapters: Chapter[]): string | undefined {
  let best: { number: number; name: string } | undefined;
  for (const chapter of chapters) {
    const match = chapter.name.match(/^第\s*(\d+(?:\.\d+)?)\s*[话話集章]/u);
    if (!match) continue;
    const number = Number(match[1]);
    if (!best || number > best.number) best = { number, name: chapter.name };
  }
  return best?.name;
}

function chapterNumber(value: string): number | undefined {
  const match = value.match(/^第\s*(\d+(?:\.\d+)?)\s*[话話集章]/u);
  if (!match) return;
  const number = Number(match[1]);
  return Number.isFinite(number) && number >= 0 && number <= 100_000 ? number : undefined;
}

