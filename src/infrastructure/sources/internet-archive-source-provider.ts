import { timeoutSignal } from "@/shared/abort-signals";
import { z } from "zod";
import type { SourceHealth, SourceProvider, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { parseDownloadTarget } from "@/shared/validation";
import { sourceSearchTerms, sourceTitleMatch } from "./source-matching";

const searchDocSchema = z.object({
  identifier: z.string().min(1),
  title: z.string().optional().default(""),
  description: z.union([z.string(), z.array(z.string())]).optional().default(""),
  year: z.union([z.string(), z.number()]).optional(),
}).passthrough();

const searchResponseSchema = z.object({
  response: z.object({
    docs: z.array(searchDocSchema).default([]),
  }).passthrough(),
}).passthrough();

const fileSchema = z.object({
  name: z.string().min(1),
  format: z.string().optional().default(""),
  size: z.union([z.string(), z.number()]).optional(),
  length: z.union([z.string(), z.number()]).optional(),
  private: z.union([z.string(), z.boolean()]).optional(),
  noindex: z.union([z.string(), z.boolean()]).optional(),
}).passthrough();

const metadataResponseSchema = z.object({
  metadata: z.object({
    identifier: z.string().optional(),
    title: z.string().optional(),
    description: z.union([z.string(), z.array(z.string())]).optional(),
  }).passthrough().optional(),
  files: z.array(fileSchema).default([]),
}).passthrough();

type SearchDoc = z.infer<typeof searchDocSchema>;
type ArchiveFile = z.infer<typeof fileSchema>;

interface ArchiveSourceProviderOptions {
  fetcher?: JsonFetcher;
  timeoutMs?: number;
}

export class InternetArchiveSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "Internet Archive";
  readonly supportedTypes: MediaType[] = ["anime", "novel"];
  private readonly baseUrl: string;
  private readonly fetcher: JsonFetcher;
  private readonly timeoutMs: number;
  private readonly items = new Map<string, SearchDoc>();
  private readonly resources = new Map<string, ResourceItem>();

  constructor(baseUrl = "https://archive.org", options: ArchiveSourceProviderOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Internet Archive 地址必须是不带认证信息的 HTTP/HTTPS 地址");
    }
    this.baseUrl = parsed.origin;
    this.id = "archive:" + this.baseUrl;
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (!this.supportedTypes.includes(query.mediaType)) return [];
    const queries = sourceSearchTerms(query.keyword, query.aliases, 4);
    if (!queries.length) return [];
    const mediaType = query.mediaType === "anime" ? "movies" : "texts";
    const responses = await Promise.allSettled(queries.map((value) => this.searchArchive(value, mediaType)));
    const successful = responses.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!successful.length) {
      const failure = responses.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      throw failure instanceof Error ? failure : new Error("Internet Archive 搜索失败");
    }
    const items = new Map<string, SearchDoc>();
    for (const docs of successful) {
      for (const doc of docs) {
        if (sourceTitleMatch(doc.title, queries).score <= 0) continue;
        items.set(doc.identifier, doc);
      }
    }
    this.items.clear();
    this.resources.clear();
    return [...items.values()].sort((left, right) => sourceTitleMatch(right.title, queries).score - sourceTitleMatch(left.title, queries).score).slice(0, 12).map((item) => {
      this.items.set(item.identifier, item);
      const year = typeof item.year === "number" ? item.year : Number(item.year);
      return {
        sourceId: this.id,
        sourceItemId: item.identifier,
        title: item.title || item.identifier,
        ...(Number.isFinite(year) && year > 0 ? { releaseYear: year } : {}),
        raw: item as unknown as Record<string, unknown>,
      };
    });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const item = this.items.get(sourceItemId);
    if (!item) return [];
    const response = metadataResponseSchema.safeParse(await this.fetchJson(this.baseUrl + "/metadata/" + encodeURIComponent(sourceItemId)));
    if (!response.success) throw new Error("Internet Archive 文件列表响应无效");
    const result: ResourceItem[] = [];
    for (const file of response.data.files.filter((value) => isDownloadableFile(value))) {
      const video = /\.(?:mp4|mkv|webm|m4v|avi)$/i.test(file.name);
      const durationSeconds = Number(file.length);
      const hasDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
      const veryShortVideo = video && hasDuration && durationSeconds < 120;
      const targetUrl = this.baseUrl + "/download/" + encodeURIComponent(sourceItemId) + "/" + encodeFilePath(file.name);
      const target = parseDownloadTarget(targetUrl);
      const resource: ResourceItem = {
        id: this.id + ":" + sourceItemId + ":" + encodeURIComponent(file.name),
        sourceId: this.id,
        sourceItemId,
        title: (item.title || sourceItemId) + " · " + file.name,
        protocol: target.protocol,
        targetUrl: target.url,
        ...(file.size !== undefined ? { sizeBytes: Number(file.size) || undefined } : {}),
        format: extensionLabel(file.name, file.format),
        metadata: {
          provider: "Internet Archive",
          archiveIdentifier: sourceItemId,
          fileName: file.name,
          format: file.format,
          downloadMode: "direct",
          resourceLabel: video ? veryShortVideo ? "短视频直链 · 片段/样片待核对" : "视频直链" : /\.(?:epub|pdf|txt|mobi|azw3|fb2)$/i.test(file.name) ? "电子书直链" : "文件直链",
          ...(hasDuration ? { durationSeconds } : {}),
          ...(veryShortVideo ? { warnings: ["视频时长不足 2 分钟，可能是片段、样片或预告，请核对实际内容，不能据此认定完整正片"] } : {}),
        },
        createdAt: new Date().toISOString(),
      };
      this.resources.set(resource.id, resource);
      result.push(resource);
    }
    return result;
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("Internet Archive 资源已过期，请重新刷新来源");
    return parseDownloadTarget(resource.targetUrl);
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.fetchJson(this.baseUrl + "/advancedsearch.php?q=mediatype%3Atexts&fl%5B%5D=identifier&rows=1&output=json");
      const parsed = searchResponseSchema.safeParse(response);
      if (!parsed.success) throw new Error("Internet Archive API 响应无效");
      return { ok: true, checkedAt, message: "公开文件搜索与直链下载已接入" };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "Internet Archive 不可用" };
    }
  }

  private async searchArchive(keyword: string, mediaType: "movies" | "texts"): Promise<SearchDoc[]> {
    const query = "title:(" + keyword.replace(/[()]/g, " ") + ") AND mediatype:" + mediaType;
    const url = this.baseUrl + "/advancedsearch.php?q=" + encodeURIComponent(query) + "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&fl%5B%5D=year&rows=24&page=1&output=json";
    const parsed = searchResponseSchema.safeParse(await this.fetchJson(url));
    if (!parsed.success) throw new Error("Internet Archive 搜索响应无效");
    return parsed.data.response.docs;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: timeoutSignal(this.timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) throw new Error("Internet Archive API HTTP " + response.status);
    return response.json();
  }
}

function isDownloadableFile(file: ArchiveFile): boolean {
  if (isTruthy(file.private) || isTruthy(file.noindex)) return false;
  const name = file.name.toLowerCase();
  if (name.includes("_files.xml") || name.includes("_meta.xml") || name.includes("_reviews.xml")) return false;
  return /\.(?:epub|pdf|txt|mobi|azw3|fb2|docx|cbz|zip|mp4|mkv|webm|m4v|avi)$/i.test(name);
}

function encodeFilePath(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function extensionLabel(name: string, format: string): string {
  const match = name.match(/\.([a-z0-9]{2,8})$/i);
  return (match?.[1] || format || "file").toUpperCase();
}

function isTruthy(value: string | boolean | undefined): boolean {
  return value === true || value === "true" || value === "1";
}

