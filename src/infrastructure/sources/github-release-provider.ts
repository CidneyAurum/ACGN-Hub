import { z } from "zod";
import type { SourceProvider, SourceHealth, SourceSearchQuery, SourceSearchResult } from "@/application/source-ports";
import { parseDownloadTarget } from "@/shared/validation";
import type { DownloadTarget } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import { createJsonFetcher, type JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { parseFeedXml } from "@/infrastructure/feeds/rss-atom-provider";
import { createTextFetcher } from "@/infrastructure/feeds/text-transport";
import type { TextFetcher } from "@/application/feed-ports";

const releaseAssetSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  name: z.string().min(1),
  browser_download_url: z.string().url(),
  size: z.number().int().nonnegative().optional(),
  content_type: z.string().optional(),
}).passthrough();

const releaseSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  tag_name: z.string().min(1),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string().url().optional(),
  published_at: z.string().nullable().optional(),
  assets: z.array(releaseAssetSchema).default([]),
}).passthrough();

const releasesSchema = z.array(releaseSchema);

export interface GithubReleaseProviderOptions {
  fetcher?: JsonFetcher;
  textFetcher?: TextFetcher;
  maxRetries?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GithubReleaseSourceProvider implements SourceProvider {
  readonly id: string;
  readonly name = "GitHub Releases";
  readonly supportedTypes: MediaType[] = ["anime", "manga", "novel", "visual_novel"];
  private readonly fetcher: JsonFetcher;
  private readonly textFetcher: TextFetcher;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly apiUrl: string;
  private readonly repository: { owner: string; repo: string };
  private readonly releases = new Map<string, z.infer<typeof releaseSchema>>();
  private readonly resources = new Map<string, ResourceItem>();
  private releaseCache?: { expiresAt: number; value: Array<z.infer<typeof releaseSchema>> };
  private readonly releaseAssetsLoaded = new Set<string>();

  constructor(repositoryUrl: string, options: GithubReleaseProviderOptions = {}) {
    const repository = parseGithubRepositoryUrl(repositoryUrl);
    this.repository = repository;
    this.id = `github:${repository.owner}/${repository.repo}`;
    this.apiUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases?per_page=20`;
    this.fetcher = options.fetcher ?? createJsonFetcher();
    this.textFetcher = options.textFetcher ?? createTextFetcher();
    this.maxRetries = options.maxRetries ?? 1;
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async search(query: SourceSearchQuery): Promise<SourceSearchResult[]> {
    const releases = await this.loadReleases();
    const terms = [query.keyword, ...query.aliases].map(normalize).filter(Boolean);
    return releases
      .filter((release) => {
        if (!terms.length) return true;
        const haystack = normalize([release.name ?? "", release.tag_name, release.body ?? ""].join(" "));
        return terms.some((term) => haystack.includes(term));
      })
      .map((release) => {
        const sourceItemId = String(release.id);
        this.releases.set(sourceItemId, release);
        return {
          sourceId: this.id,
          sourceItemId,
          title: release.name?.trim() || release.tag_name,
          raw: release as unknown as Record<string, unknown>,
        };
      });
  }

  async listResources(sourceItemId: string): Promise<ResourceItem[]> {
    let release = this.releases.get(sourceItemId);
    if (!release) {
      const releases = await this.loadReleases();
      release = releases.find((item) => String(item.id) === sourceItemId);
    }
    if (!release) return [];
    await this.loadReleaseAssets(release);
    this.releases.set(sourceItemId, release);
    return release.assets.flatMap((asset) => {
      try {
        const target = parseDownloadTarget(asset.browser_download_url);
        const resource: ResourceItem = {
          id: `${this.id}:${release.id}:${asset.id}`,
          sourceId: this.id,
          sourceItemId,
          title: `${release.name?.trim() || release.tag_name} · ${asset.name}`,
          protocol: target.protocol,
          targetUrl: target.url,
          format: fileExtension(asset.name),
          ...(asset.size !== undefined ? { sizeBytes: asset.size } : {}),
          ...(release.published_at ? { publishedAt: release.published_at } : {}),
          metadata: { releaseTag: release.tag_name, releaseUrl: release.html_url ?? null, assetName: asset.name, contentType: asset.content_type ?? null },
          createdAt: new Date().toISOString(),
        };
        this.resources.set(resource.id, resource);
        return [resource];
      } catch {
        return [];
      }
    });
  }

  async resolve(resourceId: string): Promise<DownloadTarget> {
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("GitHub Release 资源已过期，请重新刷新来源");
    return parseDownloadTarget(resource.targetUrl);
  }

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await this.loadReleases();
      return { ok: true, checkedAt };
    } catch (cause) {
      return { ok: false, checkedAt, message: cause instanceof Error ? cause.message : "GitHub 来源不可用" };
    }
  }

  private async loadReleases(): Promise<Array<z.infer<typeof releaseSchema>>> {
    if (this.releaseCache && this.releaseCache.expiresAt > Date.now()) return this.releaseCache.value;
    try {
      const releases = await this.loadReleasesFromApi();
      this.releaseCache = { expiresAt: Date.now() + this.cacheTtlMs, value: releases };
      return releases;
    } catch (apiCause) {
      try {
        const releases = await this.loadReleasesFromAtom();
        this.releaseCache = { expiresAt: Date.now() + this.cacheTtlMs, value: releases };
        return releases;
      } catch (atomCause) {
        const apiMessage = apiCause instanceof Error ? apiCause.message : "GitHub API 请求失败";
        const atomMessage = atomCause instanceof Error ? atomCause.message : "Release Atom 请求失败";
        throw new Error(apiMessage + "；已尝试 Releases Atom 降级：" + atomMessage);
      }
    }
  }

  private async loadReleasesFromApi(): Promise<Array<z.infer<typeof releaseSchema>>> {
    let attempt = 0;
    while (true) {
      try {
        const response = await this.fetcher(this.apiUrl, {
          method: "GET",
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status >= 200 && response.status < 300) {
          const parsed = releasesSchema.safeParse(await response.json());
          if (!parsed.success) throw new Error("GitHub Release 响应格式不符合预期");
          return parsed.data;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(response.status === 404 ? "GitHub 仓库或 Release 不存在" : `GitHub API HTTP ${response.status}`);
      } catch (cause) {
        if (attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        throw cause instanceof Error ? cause : new Error("无法连接 GitHub API");
      }
    }
  }

  private async loadReleasesFromAtom(): Promise<Array<z.infer<typeof releaseSchema>>> {
    const atomUrl = "https://github.com/" + this.repository.owner + "/" + this.repository.repo + "/releases.atom";
    const response = await this.textFetcher(atomUrl, {
      method: "GET",
      headers: { Accept: "application/atom+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error("GitHub Releases Atom HTTP " + response.status);
    }
    const feed = parseFeedXml(await response.text(), atomUrl);
    return feed.items.map((item) => ({
      id: "atom:" + item.id,
      tag_name: item.title,
      name: item.title,
      ...(item.description ? { body: item.description } : {}),
      ...(item.url ? { html_url: item.url } : {}),
      ...(item.publishedAt || item.updatedAt ? { published_at: item.publishedAt ?? item.updatedAt } : {}),
      assets: [],
    }));
  }

  private async loadReleaseAssets(release: z.infer<typeof releaseSchema>): Promise<void> {
    const releaseId = String(release.id);
    if (release.assets.length || this.releaseAssetsLoaded.has(releaseId) || !release.html_url) return;
    this.releaseAssetsLoaded.add(releaseId);
    try {
      const response = await this.textFetcher(release.html_url, {
        method: "GET",
        headers: { Accept: "text/html, application/xhtml+xml" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status < 200 || response.status >= 300) return;
      release.assets = extractHtmlReleaseAssets(await response.text());
    } catch {
      // Atom 降级仍可展示 Release；页面无法读取附件时保持资源列表为空。
    }
  }
}

function extractHtmlReleaseAssets(html: string): Array<z.infer<typeof releaseAssetSchema>> {
  const assets: Array<z.infer<typeof releaseAssetSchema>> = [];
  const seen = new Set<string>();
  const pattern = /href\s*=\s*["']([^"']*\/releases\/download\/[^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const rawHref = decodeHtmlEntities(match[1]);
    try {
      const url = new URL(rawHref, "https://github.com");
      if (url.hostname.toLowerCase() !== "github.com" || seen.has(url.toString())) continue;
      const segments = url.pathname.split("/").filter(Boolean);
      const name = decodeUrlSegment(segments.at(-1) ?? "");
      if (segments.length < 5 || !name) continue;
      seen.add(url.toString());
      assets.push({ id: "html:" + (assets.length + 1), name, browser_download_url: url.toString() });
    } catch {
      // 忽略无法解析的页面链接。
    }
  }
  return assets;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x2F;/gi, "/");
}

function decodeUrlSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseGithubRepositoryUrl(rawUrl: string): { owner: string; repo: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("GitHub 仓库地址无效");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("GitHub 来源必须是公开的 https://github.com/<owner>/<repo> 地址");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || !isSafeSegment(segments[0]) || !isSafeSegment(segments[1])) {
    throw new Error("GitHub 仓库地址必须包含 owner 和 repo");
  }
  return { owner: segments[0], repo: segments[1].replace(/\.git$/i, "") };
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function fileExtension(value: string): string | undefined {
  const match = value.match(/\.([a-z0-9]{1,12})$/i);
  return match?.[1]?.toLowerCase();
}
