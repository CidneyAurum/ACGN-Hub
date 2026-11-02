import { timeoutSignal, anySignal, throwIfAborted, disposeAbortSignal } from "@/shared/abort-signals";
import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { isTimeoutError } from "@/infrastructure/metadata/response-errors";
import { sourceSearchTerms } from "./source-matching";
import { matchesGalgameTitle } from "./galgame-title-matching";

const BASE_URL = "https://shionlib.com";
const positiveId = z.number().int().positive().safe();
const ids = /^[1-9]\d{0,14}$/;
const nullableStrings = z.array(z.string()).nullish().transform((value) => value ?? []);
const coverSchema = z.object({ url: z.string().url(), masked: z.boolean().optional(), sexual: z.number().optional(), violence: z.number().optional() });
const titlesSchema = z.object({
  title_jp: z.string().default(""), title_zh: z.string().default(""), title_en: z.string().default(""),
  aliases: nullableStrings, covers: z.array(coverSchema).nullish().transform((value) => value ?? []),
  release_date: z.string().nullish(),
}).refine((game) => Boolean(game.title_zh.trim() || game.title_jp.trim() || game.title_en.trim()));
const gameSchema = z.object({ id: positiveId }).and(titlesSchema);
const searchSchema = z.object({ games: z.object({ items: z.array(gameSchema), total: z.number().int().nonnegative() }) });
const fileSchema = z.object({
  id: positiveId, file_name: z.string().trim().min(1).max(2048), file_size: z.number().int().nonnegative().safe(),
  file_status: z.number().int(), stage: z.string(),
  hash_algorithm: z.string().nullish(), file_hash: z.string().nullish(), sha256: z.string().nullish(),
  is_virus_false_positive: z.boolean().default(false),
  malware_scan_cases: z.array(z.object({ detected_viruses: nullableStrings })).nullish().transform((value) => value ?? []),
});
const resourceSchema = z.object({
  id: positiveId, platform: nullableStrings, language: nullableStrings, simulator: z.string().nullish(),
  translation: z.string().nullish(), translators: z.array(z.object({ name: z.string() })).nullish().transform((value) => value ?? []),
  patch_version: z.string().nullish(), edition: z.string().nullish(), edition_name: z.string().nullish(), form: z.string().nullish(),
  published_at: z.string().nullish(), updated: z.string().optional(), files: z.array(fileSchema).nullish().transform((value) => value ?? []),
  missing_volumes: nullableStrings,
});
type Titles = z.infer<typeof titlesSchema>;
type Game = z.infer<typeof gameSchema>;
type File = z.infer<typeof fileSchema>;
type Resource = z.infer<typeof resourceSchema>;
const LANGUAGE_LABELS: Record<string, string> = { zh: "简体中文", "zh-hant": "繁体中文", jp: "日文", en: "英文" };
const PLATFORM_LABELS: Record<string, string> = { win: "Windows", mac: "macOS", lin: "Linux", and: "Android", ios: "iOS", ps3: "PS3", ps4: "PS4", psv: "PS Vita", psp: "PSP", swi: "Switch", dvd: "DVD" };
const TRANSLATION_LABELS: Record<string, string> = { none: "原文", official: "官方中文", group: "汉化组翻译", machine: "机器翻译" };
const FORM_LABELS: Record<string, string> = { disc: "光盘映像", installer: "安装版", portable: "免安装" };
const EDITION_LABELS: Record<string, string> = { download: "下载版", package: "光盘版", steam: "Steam 版" };

export interface ShionlibSourceProviderOptions { fetcher?: JsonFetcher; timeoutMs?: number; signal?: AbortSignal }

/** Independently implemented client for Shionlib's public catalog contract.
 * Download links require the source site's Cap verification. This provider never
 * calls the link-issuing route, creates a token, or guesses an object-store URL.
 * https://github.com/Ringyuki/shionlib/blob/main/apps/api/openapi/openapi.json
 */
export class ShionlibSourceProvider implements SourceProvider {
  readonly id = "shionlib";
  readonly name = "Shionlib 中文资源库";
  readonly supportedTypes: MediaType[] = ["visual_novel"];
  private readonly fetcher: JsonFetcher;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly games = new Map<string, Game>();
  private readonly resources = new Map<string, ResourceItem>();

  constructor(baseUrl = BASE_URL, options: ShionlibSourceProviderOptions = {}) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new Error("Shionlib 来源地址必须使用官方 https://shionlib.com"); }
    if (parsed.origin !== BASE_URL || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/?$/.test(parsed.pathname)) {
      throw new Error("Shionlib 来源地址必须使用官方 https://shionlib.com");
    }
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(35_000, Math.max(500, options.timeoutMs!)) : 12_000;
    this.signal = options.signal;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "visual_novel") return [];
    const keyword = query.keyword.trim();
    const explicitId = this.gameIdFromInput(keyword);
    if (explicitId) return [this.toSearchResult(await this.loadGame(explicitId))];
    const terms = sourceSearchTerms(keyword, query.aliases, 3);
    if (!terms.length) return [];
    const page = query.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new Error("Shionlib 搜索页码无效");
    const exactVndb = /^(?:vid:)?v[1-9]\d*$/i.test(keyword);
    const responses = await Promise.allSettled((exactVndb ? [keyword] : terms).map((term) => this.searchGames(term, page)));
    throwIfAborted(this.signal);
    const successful = responses.filter((result) => result.status === "fulfilled");
    if (!successful.length) {
      const cause = responses.find((result) => result.status === "rejected")?.reason;
      throw cause instanceof Error ? cause : new Error("Shionlib 公开资源目录搜索失败");
    }
    const games = new Map<string, Game>();
    for (const response of successful) for (const game of response.value) {
      if (exactVndb || matchesGalgameTitle(terms, gameAliases(game))) {
        games.set(String(game.id), game);
      }
    }
    return [...games.values()].slice(0, 48).map((game) => this.toSearchResult(game, exactVndb ? keyword : undefined));
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    if (!ids.test(sourceItemId) || !Number.isSafeInteger(Number(sourceItemId))) throw new Error("Shionlib 作品 ID 无效");
    const game = this.games.get(sourceItemId) ?? await this.loadGame(sourceItemId);
    const raw = await this.request(`/api/game/${sourceItemId}/download-source`);
    const parsed = z.array(resourceSchema).safeParse(raw);
    if (!parsed.success) throw new Error("Shionlib 资源目录格式发生变化，请打开原站查看");
    const seen = new Set<number>();
    const items: ResourceItem[] = [];
    for (const resource of parsed.data.slice(0, 300)) {
      if (seen.has(resource.id) || !resource.published_at) continue;
      seen.add(resource.id);
      const files = resource.files.filter((file) => file.file_status === 3 && file.stage === "stored");
      if (!files.length) continue;
      const item = this.toResource(game, resource, files);
      if (parsed.data.length > 300) {
        item.metadata.catalogTruncated = true;
        (item.metadata.warnings as string[]).push("本次最多展示 300 个资源版本，完整目录请到原站查看。");
      }
      items.push(item);
      this.resources.set(item.id, item);
    }
    return items;
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("Shionlib 资源入口已过期，请重新刷新来源");
    return { protocol: "http", url: resource.targetUrl };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await this.searchGames("v4", 1);
      return { ok: true, checkedAt, message: "公开资源目录可匿名查询；文件在原站通过人机验证后获取，支持复制实际链接到下载器" };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "Shionlib 公开目录暂时不可用" };
    }
  }

  private toResource(game: Game, resource: Resource, files: File[]): ResourceItem {
    const resourcePage = `${BASE_URL}/zh/resource/${resource.id}`;
    const languageLabels = labels(resource.language, LANGUAGE_LABELS);
    const platformLabels = labels(resource.platform, PLATFORM_LABELS);
    const translators = [...new Set(resource.translators.map((translator) => translator.name.trim()).filter(Boolean))];
    const translated = resource.translation && resource.translation !== "none";
    // An official translation is not necessarily Chinese; trust the language list.
    const translationLabel = resource.translation === "official" && !resource.language.some((language) => language.startsWith("zh"))
      ? "官方翻译" : resource.translation ? TRANSLATION_LABELS[resource.translation] ?? resource.translation : "翻译未注明";
    const formLabel = resource.form ? FORM_LABELS[resource.form] ?? resource.form : undefined;
    const editionLabel = resource.edition_name?.trim() || (resource.edition ? EDITION_LABELS[resource.edition] ?? resource.edition : undefined);
    const resourceType = classifyResourceFiles(files.map((file) => file.file_name));
    const typeLabel = RESOURCE_TYPE_LABELS[resourceType];
    const warnings = ["请在原站通过 Cap 人机验证后获取文件；这是资源详情页，不会把网页加入文件下载。"];
    if (resourceType !== "game") warnings.push(RESOURCE_TYPE_WARNINGS[resourceType]);
    if (resource.missing_volumes.length || files.length !== resource.files.length) warnings.push("此版本存在尚未就绪或缺少的文件，请在原站确认全部分卷完整后获取。");
    if (files.some((file) => file.is_virus_false_positive || file.malware_scan_cases.some((scan) => scan.detected_viruses.length))) {
      warnings.push("来源曾对部分文件标记可疑检测记录；源站复核不代表本软件已经确认文件安全，请在资源页查看检查结果。");
    }
    const totalSize = files.reduce((total, file) => total + file.file_size, 0);
    const describedFiles = files.map((file) => {
      const sha256 = validHash(file.sha256) || (file.hash_algorithm === "sha256" ? validHash(file.file_hash) : undefined);
      const fileHash = ["sha256", "blake3"].includes(file.hash_algorithm ?? "") ? validHash(file.file_hash) : undefined;
      return {
        id: String(file.id), fileName: file.file_name, sizeBytes: file.file_size,
        ...(sha256 ? { sha256 } : {}), ...(fileHash ? { hashAlgorithm: file.hash_algorithm!, fileHash } : {}),
        hashVerified: false, sourceScanFlag: file.is_virus_false_positive,
        scanDetections: [...new Set(file.malware_scan_cases.flatMap((scan) => scan.detected_viruses))],
      };
    });
    const fileNames = files.map((file) => file.file_name);
    const searchTerms = [typeLabel, translationLabel, ...languageLabels, ...platformLabels, ...resource.language, ...resource.platform,
      ...translators, formLabel, editionLabel, resource.patch_version, resource.simulator, ...fileNames,
      ...(resource.platform.includes("and") ? ["安卓"] : []), ...(resource.platform.includes("win") ? ["PC", "电脑"] : []),
      ...(translated && resource.language.some((language) => language.startsWith("zh")) ? ["中文", "汉化"] : []),
    ].filter(Boolean).join(" ");
    return {
      id: `${this.id}:resource:${resource.id}`, sourceId: this.id, sourceItemId: String(game.id),
      title: [preferredTitle(game), typeLabel, translationLabel, translators.join(" × "), platformLabels.join(" / "), formLabel, editionLabel, `${files.length} 个文件`].filter(Boolean).join(" · "),
      protocol: "http", targetUrl: resourcePage,
      ...(languageLabels.length ? { language: languageLabels.join(" / ") } : {}),
      ...(Number.isSafeInteger(totalSize) && totalSize > 0 ? { sizeBytes: totalSize } : {}),
      ...(resource.published_at ? { publishedAt: resource.published_at } : {}),
      metadata: {
        downloadMode: "external_link", resourceLabel: "原站验证后下载", actionLabel: "前往下载", provider: this.name,
        sourceUrl: resourcePage, resourcePage, shionlibGameId: String(game.id), shionlibResourceId: String(resource.id),
        resourceType, resourceTypeLabel: typeLabel,
        language: resource.language.join(" / "), platform: resource.platform.join(" / "), languageLabels, platformLabels,
        translation: resource.translation ?? null, translationLabel, translators,
        edition: resource.edition ?? null, editionLabel, form: resource.form ?? null, formLabel,
        patchVersion: resource.patch_version ?? null, runtime: resource.simulator ?? null,
        fileCount: files.length, files: describedFiles, fileNames, hashVerified: false,
        ...(files.length === 1 && describedFiles[0].sha256 ? { sourceSha256: describedFiles[0].sha256 } : {}),
        sourceUpdatedAt: resource.updated, requiresSourceVerification: true, missingVolumes: resource.missing_volumes,
        catalogApiVersion: "public", searchTerms, warnings,
      },
      createdAt: new Date().toISOString(),
    };
  }

  private toSearchResult(game: Game, queryAlias?: string): SourceSearchResult {
    const id = String(game.id);
    this.games.set(id, game);
    if (this.games.size > 200) this.games.delete(this.games.keys().next().value!);
    const cover = game.covers.find((item) => !item.masked && (item.sexual ?? 0) === 0 && (item.violence ?? 0) === 0);
    const aliases = [...new Set([...gameAliases(game), ...(queryAlias ? [queryAlias] : [])])];
    const year = game.release_date && /^\d{4}-/.test(game.release_date) ? Number(game.release_date.slice(0, 4)) : undefined;
    return { sourceId: this.id, sourceItemId: id, title: preferredTitle(game), aliases,
      ...(cover ? { coverUrl: cover.url } : {}), ...(year ? { releaseYear: year } : {}),
      raw: { sourceUrl: `${BASE_URL}/zh/game/${id}`, catalogApiVersion: "public", aliases },
    };
  }

  private async loadGame(id: string): Promise<Game> {
    const parsed = titlesSchema.safeParse(await this.request(`/api/game/${id}`));
    if (!parsed.success) throw new Error("Shionlib 作品详情格式发生变化，请打开原站查看");
    // This endpoint deliberately omits id; identity is the validated requested ID.
    const game = { ...parsed.data, id: Number(id) };
    this.games.set(id, game);
    return game;
  }

  private gameIdFromInput(input: string): string | undefined {
    if (ids.test(input)) return input;
    try {
      const parsed = new URL(input);
      if (parsed.origin !== BASE_URL || parsed.username || parsed.password) return undefined;
      return parsed.pathname.match(/^\/(?:zh\/|en\/|ja\/)?game\/([1-9]\d{0,14})\/?$/)?.[1];
    } catch { return undefined; }
  }

  private async searchGames(keyword: string, page: number): Promise<Game[]> {
    const query = new URLSearchParams({ q: keyword, page: String(page), pageSize: "24", resources: "required" });
    const parsed = searchSchema.safeParse(await this.request(`/api/search?${query}`));
    if (!parsed.success) throw new Error("Shionlib 作品目录格式发生变化，请打开原站查看");
    return parsed.data.games.items;
  }

  private async request(path: string): Promise<unknown> {
    throwIfAborted(this.signal);
    const timed = timeoutSignal(this.timeoutMs);
    const signal = this.signal ? anySignal([this.signal, timed]) : timed;
    try {
      const response = await abortableRequest(() => this.fetcher(`${BASE_URL}${path}`, {
        method: "GET", headers: { Accept: "application/json" }, credentials: "omit", signal, timeoutMs: this.timeoutMs,
      }), signal);
      if (response.status === 429) throw new Error("Shionlib 目录请求过于频繁，请稍后重试");
      if (response.status < 200 || response.status >= 300) throw new Error(`Shionlib 公开目录 HTTP ${response.status}，请稍后重试或打开原站`);
      const envelope = z.object({ code: z.number(), data: z.unknown() }).safeParse(await abortableRequest(() => response.json(), signal));
      if (!envelope.success) throw new Error("Shionlib 公开接口响应格式发生变化，请打开原站查看");
      if (envelope.data.code !== 0) throw new Error(`Shionlib 公开接口暂不可用（错误码 ${envelope.data.code}），请打开原站确认`);
      return envelope.data.data;
    } catch (cause) {
      throwIfAborted(this.signal);
      if (timed.aborted || isTimeoutError(cause)) throw new Error("Shionlib 目录请求超时，请稍后重试");
      if (cause instanceof Error && cause.message.startsWith("Shionlib ")) throw cause;
      if (cause instanceof SyntaxError) throw new Error("Shionlib 公开接口返回了无效 JSON，请稍后重试");
      throw new Error("无法连接 Shionlib 公开目录，请检查网络后重试");
    }
    finally { disposeAbortSignal(signal); disposeAbortSignal(timed); }
  }
}

function preferredTitle(game: Titles): string { return game.title_zh.trim() || game.title_jp.trim() || game.title_en.trim(); }
function gameAliases(game: Titles): string[] { return [...new Set([game.title_zh, game.title_jp, game.title_en, ...game.aliases].map((value) => value.trim()).filter(Boolean))]; }
function labels(values: string[], dictionary: Record<string, string>): string[] { return [...new Set(values.map((value) => dictionary[value] ?? value))]; }
function validHash(value: string | null | undefined): string | undefined { return value && /^[a-f\d]{64}$/i.test(value) ? value.toLowerCase() : undefined; }

type ResourceType = "game" | "trial" | "patch" | "save" | "ost" | "artbook" | "unknown";
const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  game: "游戏资源", trial: "试玩版", patch: "补丁资源", save: "存档资源", ost: "原声资源", artbook: "画集 / 设定资料", unknown: "文件用途待确认",
};
const RESOURCE_TYPE_WARNINGS: Record<Exclude<ResourceType, "game">, string> = {
  trial: "这是试玩或体验内容，不是完整游戏。", patch: "这是独立补丁资源，需要对应版本的游戏本体。",
  save: "这是存档资源，不能替代游戏本体。", ost: "这是音频或原声资源，不是游戏本体。",
  artbook: "这是画集或设定资料，不是游戏本体。", unknown: "此版本包含不同用途的文件，或文件用途尚不明确，请先在原站核对游戏本体与附加内容。",
};

function classifyResourceFiles(fileNames: string[]): ResourceType {
  const types = new Set(fileNames.filter((name) => !isExplanation(name)).map(classifyFile));
  return types.size === 1 ? [...types][0] : "unknown";
}

function isExplanation(name: string): boolean {
  // README beside a patch is descriptive material, never evidence of a game body.
  return /\.(?:txt|md|markdown|nfo|url|html?)$/i.test(name)
    || /(?:read\s*me|说明|說明|必读|必讀|安装指南|安裝指南)[^/\\]*\.pdf$/i.test(name);
}

function classifyFile(fileName: string): ResourceType {
  const stem = fileName.normalize("NFKC").replace(/\.(?:7z|zip)\.\d{3,}$/i, "")
    .replace(/\.part\d+\.rar$|\.r\d{2}$|\.[a-z\d]{1,8}$/i, "");
  const name = stem.replace(/[_+.]/g, " ");
  const explicit: ResourceType[] = [];
  if (/体验版|體驗版|体験版|\bdemo\b|\btrial\b/i.test(name)) explicit.push("trial");
  if (/\bOST\b|\bBGM\b|\bsound\s*track\b|サウンドトラック|原声|原聲/i.test(name)
    || /\.(?:mp3|flac|ogg|opus|wav|m4a)$/i.test(fileName)) explicit.push("ost");
  if (/画集|畫集|設定資料|设定集|\bart\s*book\b|\bartbook\b/i.test(name)) explicit.push("artbook");
  // Avoid treating a work named "Save the Date" as savedata merely for "Save".
  if (/存档|存檔|セーブデータ|\bsave\s*data\b|\bsaves?\s*$/i.test(name)
    || /\.(?:sav|save)$/i.test(fileName)) explicit.push("save");
  const appliedPatch = /(?:已(?:打(?:好|上)?|集成|整合|应用|應用|安装|安裝)|内置|內置|整合|集成|含|附(?:带|帶)?|包含)[^()\[\]]{0,20}(?:补丁|補丁|\bpatch\b|パッチ)|(?:补丁|補丁|\bpatch\b|パッチ)[^()\[\]]{0,12}(?:已打|已应用|已應用|集成|内置|內置)|\bpre[\s-]*patched\b|\bpatched\b|\bpatch(?:es)?\s+(?:applied|included|integrated)\b|\b(?:includes?|with|integrated|applied)\s+(?:\w+\s+){0,3}patch(?:es)?\b/i.test(name);
  if ((!appliedPatch && /补丁|補丁|\bpatch\b|パッチ/i.test(name)) || /\.(?:xdelta|bps|ips)$/i.test(fileName)) explicit.push("patch");
  const bundledExtras = /(?:\+|\bwith\b|\bincludes?\b|含|附(?:带|帶)?|包含)[^()\[\]]{0,20}(?:\b(?:OST|BGM|sound\s*track|art\s*book|artbook|savedata)\b|原声|原聲|画集|畫集|设定|設定|存档|存檔)/i.test(stem);
  if (explicit.length && bundledExtras) return "unknown";
  if (explicit.length) return new Set(explicit).size === 1 ? explicit[0] : "unknown";
  // Shionlib's resource catalog is for game releases. Unmarked archives can
  // retain that source definition; arbitrary documents are not called games.
  return /\.(?:7z|zip|rar|iso|lzh|exe|msi)(?:\.\d{3,})?$|\.part\d+\.rar$|\.r\d{2}$/i.test(fileName) ? "game" : "unknown";
}
