import { timeoutSignal, anySignal, throwIfAborted, disposeAbortSignal } from "@/shared/abort-signals";
import { z } from "zod";
import type { TextFetcher } from "@/application/feed-ports";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createTextFetcher } from "@/infrastructure/feeds/text-transport";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";
import { sourceSearchTerms, sourceTitleMatch } from "./source-matching";

const MAX_HTML_LENGTH = 3 * 1024 * 1024;
const MAX_CATALOG_FILES = 10_000;
const MAX_SEARCH_RESULTS = 80;
const DOWNLOAD_BASE = "https://zd.shinnku.top/file/shinnku/";
const ORIGINAL_COLLECTION = "合集系列/浮士德galgame游戏合集/";
const ORIGINAL_DOWNLOAD_BASE = "https://galgamedownload.date/";
const fileSchema = z.object({
  file_path: z.string().min(1).max(2_048),
  file_size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  upload_timestamp: z.number().int().nonnegative().max(8_640_000_000_000_000),
});
type CatalogFile = z.infer<typeof fileSchema>;

export interface ShinnkuSourceProviderOptions {
  fetcher?: TextFetcher;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Reads the public site's JSON-encoded Next/RSC catalog, never executes scripts.
 * Protocol evidence: https://github.com/shinnku-nikaidou/shinnku-com
 * /search?q=... supplies file_path/size; /files/shinnku/... revalidates saved IDs.
 * Both public libraries use the site's documented stable URL maps. galgame0
 * removes two virtual catalog roots on its detail pages, but retains them in
 * the separate storage URL. Collection membership alone proves no language.
 */
export class ShinnkuSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "真红小站";
  readonly supportedTypes: MediaType[] = ["visual_novel"];
  private readonly baseUrl: string;
  private readonly fetcher: TextFetcher;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(baseUrl = "https://www.shinnku.com", options: ShinnkuSourceProviderOptions = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || !["www.shinnku.com", "shinnku.com"].includes(url.hostname)
      || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("真红小站必须使用官方 HTTPS 站点地址");
    }
    this.baseUrl = url.origin;
    this.id = `shinnku:${url.origin}`;
    this.fetcher = options.fetcher ?? createTextFetcher();
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(30_000, Math.max(500, options.timeoutMs!)) : 15_000;
    this.signal = options.signal;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "visual_novel") return [];
    if (query.page !== undefined && (!Number.isSafeInteger(query.page) || query.page < 1)) throw new Error("真红小站页码无效");
    // The original site returns at most 200 semantic matches and exposes no paging.
    if ((query.page ?? 1) > 1) return [];
    const terms = sourceSearchTerms(query.keyword, query.aliases, 3);
    if (!terms.length) return [];
    const responses = await Promise.allSettled(terms.map((term) => this.readCatalog(`${this.baseUrl}/search?q=${encodeURIComponent(term)}`)));
    throwIfAborted(this.signal);
    const successful = responses.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!successful.length) {
      const failed = responses.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw failed?.reason instanceof Error ? failed.reason : new Error("真红小站目录查询失败");
    }
    const all = new Map<string, CatalogFile>();
    for (const files of successful) for (const file of files) {
      if (file.file_size > 0 && isSupportedFile(file.file_path)) all.set(file.file_path, file);
    }
    const groups = new Map<string, CatalogFile[]>();
    for (const file of all.values()) {
      const key = multipartKey(file.file_path) ?? file.file_path;
      groups.set(key, [...(groups.get(key) ?? []), file]);
    }
    const candidates = [...groups.values()].map((files) => {
      files.sort((a, b) => a.file_path.localeCompare(b.file_path, "en", { numeric: true }));
      const file = files.find((entry) => multipartKey(entry.file_path)) ?? files[0];
      const title = editionTitle(file.file_path);
      const aliases = titleAliases(file.file_path);
      // Punctuation-free ranking merges "a trial" into "atrial". For short
      // Latin queries, require a real token in an original filename/alias before
      // scoring, while allowing adjacent Chinese/Japanese edition annotations.
      const matchingTerms = terms.filter((term) => matchesShortLatinBoundary(term, [title, ...aliases]));
      const match = sourceTitleMatch(title, matchingTerms, aliases, { allowShortCjk: true });
      return { files, file, title, aliases, score: match.score, priority: filePriority(file) };
    }).filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.priority - a.priority || a.title.localeCompare(b.title));
    const truncated = candidates.length > MAX_SEARCH_RESULTS || successful.some((files) => files.length >= 200);
    return candidates.slice(0, MAX_SEARCH_RESULTS).map(({ files, file, title, aliases }) => ({
      sourceId: this.id, sourceItemId: encodeItemId(file.file_path), title, aliases,
      raw: {
        sourceUrl: this.filePage(file.file_path), filePath: file.file_path, fileSize: file.file_size,
        editionLabel: title, catalogTruncated: truncated, catalogCollection: collection(file.file_path),
        ...(multipartKey(file.file_path) ? { multipart: true, matchedParts: files.map((part) => fileName(part.file_path)) } : {}),
      },
    }));
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const path = decodeItemId(sourceItemId);
    const files = await this.readCatalog(this.filePage(path));
    const current = files.find((file) => file.file_path === path && file.file_size > 0 && isSupportedFile(file.file_path));
    if (!current) throw new Error("真红小站文件已移除或目录发生变化，请刷新来源");
    let multipart = multipartKey(path);
    let selected = [current];
    if (multipart || /\.rar$/i.test(path)) {
      // Reload the containing folder so a persisted selection never silently
      // loses sibling volumes that were absent from the semantic search window.
      const parent = path.slice(0, path.lastIndexOf("/"));
      const siblings = await this.readCatalog(this.filePage(parent));
      // A classic RAR starts with Game.rar, whose own filename cannot reveal
      // Game.r00/r01 siblings. Inspect the folder even after a cold restoration.
      if (!multipart && siblings.some((file) => /\.r\d{2}$/i.test(file.file_path) && multipartKey(file.file_path) === path)) multipart = path;
      if (multipart) {
        selected = siblings.filter((file) => file.file_size > 0 && isSupportedFile(file.file_path) && (multipartKey(file.file_path) === multipart || file.file_path === multipart));
        if (!selected.some((file) => file.file_path === path)) throw new Error("真红小站分卷目录不完整，请在原站确认全部分卷");
        selected.sort((a, b) => (partNumber(a.file_path) ?? 0) - (partNumber(b.file_path) ?? 0));
        validateMultipart(selected);
      }
    }
    return selected.map((file) => this.toResource(file, sourceItemId, multipart ? selected : undefined));
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const prefix = `${this.id}:file:`;
    if (!resourceId.startsWith(prefix)) throw new Error("真红小站资源 ID 无效");
    const path = decodeItemId(`file:${resourceId.slice(prefix.length)}`);
    // The public stable URL is reconstructed at download time. No expiring
    // S3 signature, cookies, source login or download-counter POST is required.
    return { protocol: "http", url: downloadUrl(path), filename: safeFileName(fileName(path)) };
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const files = await this.readCatalog(`${this.baseUrl}/search?q=CLANNAD`);
      if (!files.some((file) => isSupportedFile(file.file_path))) throw new Error("目录未返回可识别的游戏文件");
      return { ok: true, checkedAt, message: "公开文件目录可访问；提供原站档案直链，具体下载速度与断点能力由下载时探测确认" };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "真红小站暂时不可访问" };
    }
  }

  private filePage(path: string): string {
    if (path === ORIGINAL_COLLECTION.slice(0, -1)) return `${this.baseUrl}/files/galgame0`;
    return path.startsWith(ORIGINAL_COLLECTION)
      ? `${this.baseUrl}/files/galgame0/${encodePath(path.slice(ORIGINAL_COLLECTION.length))}`
      : `${this.baseUrl}/files/shinnku/${encodePath(path)}`;
  }

  private toResource(file: CatalogFile, sourceItemId: string, parts?: CatalogFile[]): ResourceItem {
    const path = file.file_path;
    const name = fileName(path);
    const labels = fileLabels(path);
    const warnings = ["来源标注的语言与版本以压缩包内容为准，下载后请自行解压确认；不会自动运行游戏或安装程序。"];
    if (labels.resourceType === "patch") warnings.push("这是补丁，需要对应版本的游戏本体。");
    if (labels.resourceType === "trial") warnings.push("这是体验版，并非完整游戏。");
    if (labels.resourceType === "save") warnings.push("这是游戏存档，需要对应的游戏本体，不能独立运行。");
    if (labels.resourceType === "tool") warnings.push("这是运行辅助工具，不是所选游戏的本体。");
    if (labels.partialTranslation) warnings.push("来源文件名注明部分内容尚未汉化，不能视为完整中文版本。");
    if (collection(path) === "original" && !labels.languages.length) warnings.push("这是原站原文合集；目录本身不能证明包含中文，请先核对文件内的语言和版本说明。");
    if (parts) warnings.push(`这是分卷档案，共 ${parts.length} 个目录条目；请将全部分卷保存到同一目录并保留分卷文件名后解压。`);
    const sourceUpdatedAt = new Date(file.upload_timestamp).toISOString();
    return {
      id: `${this.id}:file:${encodeURIComponent(path)}`, sourceId: this.id, sourceItemId,
      title: name, protocol: "http", targetUrl: downloadUrl(path), sizeBytes: file.file_size,
      format: archiveFormat(path), ...(labels.language ? { language: labels.language } : {}),
      publishedAt: sourceUpdatedAt,
      metadata: {
        downloadMode: "direct_file", resourceLabel: "原站文件直链", provider: this.name,
        resourceType: labels.resourceType, resourceTypeLabel: labels.resourceTypeLabel,
        sourceUrl: this.filePage(path), filePath: path, filename: safeFileName(name), downloadFileName: safeFileName(name), originalFileName: name,
        editionLabel: editionTitle(path), sourceUpdatedAt, catalogCollection: collection(path),
        catalogCollectionLabel: collection(path) === "original" ? "原文合集" : "中文与移植目录",
        language: labels.language ?? "unknown", languages: labels.languages, languageLabels: labels.languageLabels,
        languageEvidence: labels.languageEvidence, platform: labels.platforms.join(" / "), platforms: labels.platforms, platformLabels: labels.platformLabels,
        ...(labels.partialTranslation ? { partialTranslation: true } : {}),
        searchTerms: [name, labels.resourceTypeLabel, ...labels.languageLabels, ...labels.platformLabels].join(" "),
        rangeSupport: "unknown", instructions: parts ? "下载全部分卷到同一目录，保留分卷文件名，再从首卷解压。" : "下载完成后解压档案；压缩包内说明以原作者或来源为准。",
        ...(parts ? {
          multipart: true, partNumber: partNumber(path), totalParts: parts.length,
          requiredFiles: parts.map((part) => safeFileName(fileName(part.file_path))),
          multipartFiles: parts.map((part) => ({ filename: safeFileName(fileName(part.file_path)), sizeBytes: part.file_size, targetUrl: downloadUrl(part.file_path) })),
        } : {}),
        warnings,
      }, createdAt: new Date().toISOString(),
    };
  }

  private async readCatalog(url: string): Promise<CatalogFile[]> {
    throwIfAborted(this.signal);
    const timed = timeoutSignal(this.timeoutMs);
    const signal = this.signal ? anySignal([this.signal, timed]) : timed;
    try {
      const init: RequestInit & { timeoutMs: number } = { method: "GET", headers: { Accept: "text/html" }, signal, timeoutMs: this.timeoutMs };
      const response = await abortableRequest(() => this.fetcher(url, init), signal);
      if (response.status < 200 || response.status >= 300) throw new Error(`真红小站 HTTP ${response.status}，请稍后重试或在原站确认访问条件`);
      const html = await abortableRequest(() => response.text(), signal);
      return parseCatalog(html);
    } catch (cause) {
      throwIfAborted(this.signal);
      if (timed.aborted) throw new Error("真红小站目录请求超时，请稍后重试");
      if (cause instanceof Error && cause.message.startsWith("真红小站")) throw cause;
      throw new Error("真红小站目录暂时无法读取，请稍后重试或打开原站");
    }
    finally { disposeAbortSignal(signal); disposeAbortSignal(timed); }
  }
}

function parseCatalog(html: string): CatalogFile[] {
  if (html.length > MAX_HTML_LENGTH) throw new Error("真红小站目录响应过大，请缩小搜索范围");
  const chunks: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*>\s*self\.__next_f\.push\((\[[\s\S]*?)\)\s*<\/script>/gi)) {
    try {
      const chunk: unknown = JSON.parse(match[1]);
      if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === "string") chunks.push(chunk[1]);
    } catch { /* Other scripts are never evaluated or treated as catalog data. */ }
  }
  const models: unknown[] = [];
  for (const line of chunks.join("").split("\n")) {
    const model = line.match(/^[\da-f]+:([\[{].*)$/i)?.[1];
    if (!model) continue;
    try { models.push(JSON.parse(model)); } catch { /* Non-model RSC records. */ }
  }
  const files = new Map<string, CatalogFile>();
  let catalogSeen = false;
  let malformedFile = false;
  let visited = 0;
  const queue = models.map((value) => ({ value, depth: 0 }));
  while (queue.length) {
    if (++visited > 50_000) throw new Error("真红小站目录结构过大，请缩小搜索范围");
    const { value, depth } = queue.pop()!;
    if (!value || typeof value !== "object") continue;
    if (depth > 60) throw new Error("真红小站目录结构过深，请打开原站确认");
    if (Array.isArray(value)) {
      for (const child of value) queue.push({ value: child, depth: depth + 1 });
      continue;
    }
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.answer) || Array.isArray(object.inode)) catalogSeen = true;
    if (Object.prototype.hasOwnProperty.call(object, "file_path")) {
      catalogSeen = true;
      const parsed = fileSchema.safeParse(object);
      if (parsed.success && safePath(parsed.data.file_path)) files.set(parsed.data.file_path, parsed.data);
      else malformedFile = true;
      if (files.size > MAX_CATALOG_FILES) throw new Error("真红小站目录超过 10000 个文件，请缩小搜索范围");
    }
    for (const child of Object.values(object)) queue.push({ value: child, depth: depth + 1 });
  }
  if (!catalogSeen || (malformedFile && !files.size)) throw new Error("真红小站公开目录格式发生变化，请打开原站确认");
  return [...files.values()];
}

function safePath(path: string): boolean {
  return path.length <= 2_048 && !/[\\\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}
function validPath(path: string): boolean { return (/^(?:0|zd)\//.test(path) || path.startsWith(ORIGINAL_COLLECTION)) && safePath(path); }
function isSupportedFile(path: string): boolean { return validPath(path) && /\.(?:7z|zip|rar|iso|lzh|apk)(?:\.\d{3})?$|\.part\d+\.rar$|\.r\d{2}$/i.test(path); }
function encodePath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function fileName(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function safeFileName(name: string): string { return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_"); }
function collection(path: string): "original" | "translated" { return path.startsWith(ORIGINAL_COLLECTION) ? "original" : "translated"; }
function downloadUrl(path: string): string {
  // The literal leading backtick is part of the source's public object key.
  // Keep encoding per segment so it cannot become a query, fragment or host.
  return collection(path) === "original"
    ? `${ORIGINAL_DOWNLOAD_BASE}${encodePath(["`【合集系列】", ...path.split("/").slice(1)].join("/"))}`
    : `${DOWNLOAD_BASE}${encodePath(path)}`;
}
function encodeItemId(path: string): string { return `file:${encodeURIComponent(path)}`; }
function decodeItemId(id: string): string {
  let path: string;
  try { path = id.startsWith("file:") ? decodeURIComponent(id.slice(5)) : ""; } catch { path = ""; }
  if (!isSupportedFile(path)) throw new Error("真红小站文件 ID 无效");
  return path;
}
function multipartKey(path: string): string | undefined {
  if (/\.(?:7z|zip)\.\d{3}$/i.test(path)) return path.replace(/\.\d{3}$/, "");
  if (/\.part\d+\.rar$/i.test(path)) return path.replace(/\.part\d+\.rar$/i, ".rar");
  if (/\.r\d{2}$/i.test(path)) return path.replace(/\.r\d{2}$/i, ".rar");
  return undefined;
}
function partNumber(path: string): number | undefined {
  const modern = path.match(/\.(?:7z|zip)\.(\d{3})$|\.part(\d+)\.rar$/i);
  if (modern) return Number(modern[1] ?? modern[2]);
  const classic = path.match(/\.r(\d{2})$/i);
  return classic ? Number(classic[1]) + 2 : /\.rar$/i.test(path) ? 1 : undefined;
}
function validateMultipart(files: CatalogFile[]): void {
  const numbers = files.map((file) => partNumber(file.file_path)).sort((a, b) => (a ?? 0) - (b ?? 0));
  if (numbers.length < 2 || numbers.some((number, index) => number !== index + 1)) {
    throw new Error("真红小站分卷目录缺少首卷、存在断号或仅有一个分卷，请到原站确认完整文件后再下载");
  }
}
function archiveFormat(path: string): string { return fileName(multipartKey(path) ?? path).match(/\.([a-z\d]+)$/i)?.[1].toUpperCase() ?? "ARCHIVE"; }
function editionTitle(path: string): string {
  return fileName(multipartKey(path) ?? path).replace(/\.(?:7z|zip|rar|iso|lzh|apk)$/i, "").replace(/^(?:\[[^\]]*\]\s*)+/, "").trim();
}
function titleAliases(path: string): string[] {
  const title = editionTitle(path);
  const series = title.replace(/[（(][^）)]*(?:官中|汉化|漢化|硬盘|補丁|补丁|Steam|心愿屋|修正|双汉化)[^）)]*[）)]/gi, "")
    .replace(/\s+v\d+(?:\.\d+)*$/i, "").trim();
  return [...new Set([title, series])].filter(Boolean);
}
function matchesShortLatinBoundary(term: string, names: string[]): boolean {
  const normalized = term.normalize("NFKC").trim();
  if (!/^[a-z]{2,5}$/i.test(normalized)) return true;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = new RegExp(`(?:^|[^\\p{Script=Latin}\\p{N}])${escaped}(?=$|[^\\p{Script=Latin}\\p{N}])`, "iu");
  return names.some((name) => boundary.test(name.normalize("NFKC")));
}
function fileLabels(path: string) {
  const name = fileName(path).replace(/[_+.]/g, " ");
  const partialTranslation = /(?:h\s*未(?:汉|漢|翻译|翻譯)|部分[^,，;；()（）]{0,8}未(?:汉|漢|翻译|翻譯)|未完全(?:汉化|漢化)|部分(?:汉化|漢化))/i.test(name);
  const untranslated = !partialTranslation && /未(?:汉化|漢化|汉|漢)|无汉化|無漢化|无中文|無中文|不含中文/.test(name);
  const positiveLanguageName = name.replace(/未(?:汉化|漢化|汉|漢)|无汉化|無漢化|无中文|無中文|不含中文/g, "");
  const translated = !untranslated && /官中|汉化|漢化|简中|簡中|繁中|简体中文|繁體中文|中文(?:版|补丁|補丁)/i.test(positiveLanguageName);
  // 0/win is explicitly labelled 熟肉 by the official source's get_game_type.
  // A Chinese filename, a zd path or an Android folder alone proves no language.
  const chineseDirectory = path.startsWith("0/win/");
  const japanese = !translated && /(?:生肉|日文原版|日语原版)/.test(name);
  const chinese = !untranslated && (translated || (chineseDirectory && !japanese));
  // Pre-applied or bundled patches describe the game package, not a separate
  // patch download. Remove only those clauses before looking for a patch label.
  const patchName = /(?:仅|僅|只)(?:含|有|带|帶)[^,，;；()（）]{0,12}(?:补丁|補丁|パッチ)/.test(name) ? name
    : name.replace(/(?:已\s*(?:打(?:上)?|集成|整合|安装|安裝|应用|應用)|集成|整合|自带|自帶|内置|內置|附带|附帶|含(?:有)?)[^,，;；()（）\[\]【】]{0,20}(?:补丁|補丁|パッチ|\bpatch\b)/gi, "");
  const resourceType = /\/tools?\//i.test(path) ? "tool"
    : /(?:补丁|補丁|\bpatch\b|修正パッチ)/i.test(patchName) ? "patch"
    : /(?:体验版|體驗版|体験版|\btrial\b|\bdemo\b)/i.test(name) ? "trial"
    : /(?:存档|存檔|セーブデータ|\bsave[ _-]*data\b)/i.test(name) ? "save"
    : /(?:\bOST\b|\bBGM\b|サウンドトラック|原声|原聲)/i.test(name) ? "ost"
    : /(?:画集|畫集|設定資料|设定集|\bartbook\b)/i.test(name) ? "artbook"
    : /(?:攻略|\bwalkthrough\b)/i.test(name) ? "walkthrough"
    : /(?:合集|collection)/i.test(name) ? "collection" : "game";
  const resourceTypeLabel = ({ patch: "补丁", trial: "试玩版", collection: "合集", game: "游戏本体", ost: "原声", artbook: "画集 / 设定集", walkthrough: "攻略", save: "存档", tool: "运行工具" })[resourceType];
  const platform = /\/(?:android|apk|krkr|ons|kirikiri)\//i.test(path) || /\.apk$/i.test(path) ? "and"
    : path.startsWith("0/win/") || path.startsWith("zd/") ? "win" : undefined;
  return {
    resourceType, resourceTypeLabel,
    partialTranslation,
    language: chinese ? partialTranslation ? "中文（部分内容未汉化）" : "中文（来源标记）" : japanese ? "日文（来源标记）" : undefined,
    languages: chinese ? ["zh"] : japanese ? ["ja"] : [],
    languageLabels: chinese ? [partialTranslation ? "中文（部分内容未汉化）" : "中文（来源标记）"] : japanese ? ["日文（来源标记）"] : ["语言待确认"],
    languageEvidence: partialTranslation ? "文件名注明部分内容未汉化；不能推定为完整中文版本" : untranslated ? "文件名注明尚未汉化" : translated ? "文件名明确标注中文版本" : japanese ? "文件名标注日文原版" : chineseDirectory ? "原站 0/win 熟肉目录" : "未提供可确认的语言标记",
    platforms: platform ? [platform] : [], platformLabels: platform === "win" ? ["Windows"] : platform === "and" ? ["Android / 移植版"] : ["平台待确认"],
  };
}
function filePriority(file: CatalogFile): number {
  const labels = fileLabels(file.file_path);
  return (labels.languages.includes("zh") ? 100 : 0) + (labels.platforms.includes("win") ? 40 : 0)
    + (labels.resourceType === "game" ? 30 : -50) + (/官中/.test(file.file_path) ? 20 : 0)
    + (/\bHD\s*(?:Edition)?\b|\bremaster(?:ed)?\b|高清版|重制版|重製版/i.test(fileName(file.file_path)) ? 8 : 0);
}
