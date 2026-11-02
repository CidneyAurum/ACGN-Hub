import { timeoutSignal } from "@/shared/abort-signals";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { SourceProvider, SourceSearchQuery, SourceSearchResult, SourceHealth } from "@/application/source-ports";
import type { MediaType } from "@/domain/media";
import type { DownloadTarget } from "@/domain/download";
import type { ResourceItem } from "@/domain/resource";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { parseDownloadTarget } from "@/shared/validation";

const searchSchema = z.object({ code: z.number(), message: z.string().optional(), data: z.object({ result: z.array(z.object({
  bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/), title: z.string(), pic: z.string().optional(), author: z.string().optional(),
  duration: z.string().optional(), description: z.string().optional(),
}).passthrough()).default([]) }).optional().nullable() });
const infoSchema = z.object({ id: z.string(), title: z.string().min(1), duration: z.number().nonnegative().nullable().optional(),
  coverUrl: z.string().nullable().optional(), playable: z.boolean(),
  uploader: z.string().nullable().optional(), qualityLabel: z.string().nullable().optional(), downloadHeightLimit: z.number().int().positive().optional(),
  selectedFormat: z.object({ height: z.number().positive(), width: z.number().positive().nullable().optional() }).passthrough().nullable().optional(),
  unavailableReason: z.string().nullable().optional(),
  formats: z.array(z.object({ id: z.string(), ext: z.string(), height: z.number().nullable().optional(), width: z.number().nullable().optional(), hasVideo: z.boolean(), hasAudio: z.boolean() }).passthrough()).default([]),
}).passthrough();
export interface PublicVideoSourceOptions { fetcher?: JsonFetcher; inspect?: (url: string) => Promise<unknown>; timeoutMs?: number }

/** Public submissions only: no cookies, account access, or stored CDN URLs. */
export class PublicVideoSourceProvider implements SourceProvider {
  readonly id = "public-video:https://www.bilibili.com";
  readonly name = "B站公开投稿";
  readonly supportedTypes: MediaType[] = ["anime"];
  private readonly fetcher: JsonFetcher;
  private readonly inspect: (url: string) => Promise<unknown>;
  private readonly timeoutMs: number;
  private readonly resources = new Map<string, ResourceItem>();

  constructor(baseUrl = "https://www.bilibili.com", options: PublicVideoSourceOptions = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || !["www.bilibili.com", "bilibili.com"].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("B站公开投稿来源地址应为 https://www.bilibili.com");
    }
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.inspect = options.inspect ?? ((url) => invoke("inspect_public_video", { url }));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    if (query.mediaType !== "anime") return [];
    const keyword = query.keyword.trim();
    if (!keyword) return [];
    const direct = parsePublicVideoInput(keyword);
    if (direct) {
      const info = infoSchema.parse(await this.inspect(direct.url));
      return [{ sourceId: this.id, sourceItemId: direct.itemId, title: info.title,
        ...(info.coverUrl ? { coverUrl: info.coverUrl } : {}), raw: { ...videoMetadata(info.duration ?? undefined, info.uploader ?? undefined, direct.url, info.title),
          ...(info.qualityLabel ? { qualityLabel: info.qualityLabel } : {}), ...(info.downloadHeightLimit ? { downloadHeightLimit: info.downloadHeightLimit } : {}) } }];
    }
    const endpoint = new URL("https://api.bilibili.com/x/web-interface/search/type");
    endpoint.searchParams.set("search_type", "video"); endpoint.searchParams.set("keyword", keyword);
    endpoint.searchParams.set("page", String(query.page ?? 1)); endpoint.searchParams.set("page_size", "20");
    const response = await this.fetcher(endpoint.toString(), { method: "GET", headers: {
      Accept: "application/json", Referer: "https://search.bilibili.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    }, signal: timeoutSignal(this.timeoutMs), timeoutMs: this.timeoutMs });
    if (response.status !== 200) throw new Error(`B站公开搜索 HTTP ${response.status}；可改用公开 BV 号或投稿链接`);
    const parsed = searchSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("B站公开搜索响应格式发生变化，请改用公开投稿链接");
    if (parsed.data.code !== 0) throw new Error(`B站公开搜索不可用：${parsed.data.message || parsed.data.code}；不会尝试绕过访问限制`);
    return (parsed.data.data?.result ?? []).map((item) => {
      const title = plainText(item.title);
      const url = `https://www.bilibili.com/video/${item.bvid}/`;
      const cover = item.pic?.startsWith("//") ? `https:${item.pic}` : item.pic;
      return { sourceId: this.id, sourceItemId: item.bvid, title,
        ...(cover && /^https?:\/\//i.test(cover) ? { coverUrl: cover } : {}),
        raw: { ...videoMetadata(parseDuration(item.duration), item.author, url, title), description: item.description ?? "" } };
    });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    const target = parsePublicVideoInput(sourceItemId);
    if (!target) throw new Error("公开投稿标识无效，请使用 BV 号或 B站公开投稿链接");
    const info = infoSchema.parse(await this.inspect(target.url));
    if (!info.playable) throw new Error(info.unavailableReason || "该投稿目前没有可匿名读取的视频格式；登录、付费及受限内容不会继续解析");
    const selectedHeight = info.selectedFormat?.height;
    const qualityLabel = info.qualityLabel?.trim() || (selectedHeight ? `匿名可用 ${selectedHeight}p` : "实际画质待确认");
    const resource: ResourceItem = { id: `${this.id}:${target.itemId}`, sourceId: this.id, sourceItemId: target.itemId,
      title: info.title, protocol: "http", targetUrl: target.url, format: "MP4", createdAt: new Date().toISOString(),
      ...(selectedHeight ? { resolution: `${selectedHeight}p` } : {}),
      metadata: { ...videoMetadata(info.duration ?? undefined, info.uploader ?? undefined, target.url, info.title),
        provider: "B站公开投稿", downloadMode: "public_video", resourceLabel: `公开视频 · MP4${qualityLabel ? ` · ${qualityLabel}` : ""}`, bvid: target.bvid, page: target.page,
        ...(qualityLabel ? { qualityLabel } : {}), ...(info.downloadHeightLimit ? { downloadHeightLimit: info.downloadHeightLimit } : {}),
        ...(info.selectedFormat ? { selectedFormat: info.selectedFormat } : {}),
        seriesTitle: info.title, publicOnly: true, playable: info.playable } };
    this.resources.set(resource.id, resource);
    return [resource];
  }

  restoreResource(resource: ResourceItem): void {
    if (resource.sourceId === this.id && resource.metadata.downloadMode === "public_video" && parsePublicVideoInput(resource.targetUrl)) this.resources.set(resource.id, resource);
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("公开视频记录尚未恢复，请重新选择投稿");
    return parseDownloadTarget(resource.targetUrl);
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await this.search({ keyword: "动画", aliases: [], mediaType: "anime" });
      return { ok: true, checkedAt, message: "公开搜索接口连接正常；具体投稿是否可匿名播放与下载会单独检查" };
    } catch (cause) { return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "公开搜索接口暂不可用" }; }
  }
}

export function parsePublicVideoInput(value: string): { bvid: string; page: number; itemId: string; url: string } | undefined {
  const input = value.trim();
  let bvid: string | undefined;
  let page = 1;
  const short = input.match(/^(BV[0-9A-Za-z]{10})(?:\?p=(\d+))?$/);
  if (short) { bvid = short[1]; page = Number(short[2] ?? 1); }
  else {
    try {
      const url = new URL(input);
      if (!["http:", "https:"].includes(url.protocol) || !["www.bilibili.com", "bilibili.com"].includes(url.hostname) ||
        (url.port && !["80", "443"].includes(url.port)) || url.username || url.password || url.searchParams.getAll("p").length > 1) return undefined;
      bvid = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/)?.[1];
      const part = url.searchParams.get("p") ?? "1";
      if (!/^\d+$/.test(part)) return undefined;
      page = Number(part);
    } catch { return undefined; }
  }
  if (!bvid || !Number.isInteger(page) || page < 1 || page > 1000) return undefined;
  const itemId = bvid + (page > 1 ? `?p=${page}` : "");
  return { bvid, page, itemId, url: `https://www.bilibili.com/video/${bvid}/` + (page > 1 ? `?p=${page}` : "") };
}
function parseDuration(value: string | undefined): number | undefined {
  if (!value || !/^\d+(?::\d{1,2}){1,2}$/.test(value.trim())) return undefined;
  return value.trim().split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
}
function videoMetadata(duration: number | undefined, uploader: string | undefined, sourceUrl: string, title = ""): Record<string, unknown> {
  const warnings: string[] = [];
  const clip = duration !== undefined && duration < 600;
  const compilation = /合集|全\s*\d+\s*[集话話]|\d+\s*[-–~]\s*\d+\s*[集话話]/i.test(title) || (duration !== undefined && duration > 3600);
  if (clip) warnings.push("时长不足 10 分钟，可能是预告、片段或二创，不能当作完整正片");
  if (compilation) warnings.push("可能是合集或多集投稿，请核对分P与实际内容");
  if (/PV|预告|先行|混剪|解说|CM|MAD|AMV/i.test(title)) warnings.push("标题可能为预告或二创内容，请核对后再下载");
  const durationLabel = duration !== undefined ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}` : "时长待确认";
  return { durationSeconds: duration ?? null, durationLabel, uploader: uploader ?? "", sourceUrl,
    videoKind: clip ? "clip" : compilation ? "compilation" : "unverified", warnings };
}
function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ").trim();
}
