import type { DownloadTarget, DownloadProtocol } from "@/domain/download";
import type { MediaType } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";
import type { MangaChapterDescriptor, MangaChapterInput, MangaChapterResult } from "@/domain/manga";
import type { NovelDownloadDescriptor, NovelDownloadInput, NovelDownloadResult } from "@/domain/novel";

export interface SourceSearchQuery {
  keyword: string;
  aliases: string[];
  mediaType: MediaType;
  page?: number;
}

export interface SourceSearchResult {
  sourceId: string;
  sourceItemId: string;
  title: string;
  /** Alternate titles supplied by the source, retained for matching after search. */
  aliases?: string[];
  coverUrl?: string;
  releaseYear?: number;
  raw?: Record<string, unknown>;
}

export interface SourceHealth {
  ok: boolean;
  checkedAt: string;
  message?: string;
}

export interface SourceProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedTypes: MediaType[];

  search(query: SourceSearchQuery): Promise<SourceSearchResult[]>;
  listResources(sourceItemId: string): Promise<ResourceItem[]>;
  resolve(resourceId: string): Promise<DownloadTarget>;
  /** Optional native chapter download used by sources that return protected page images. */
  prepareMangaDownload?(resourceId: string): Promise<MangaChapterDescriptor>;
  downloadMangaChapter?(resourceId: string, input: MangaChapterInput): Promise<MangaChapterResult>;
  prepareNovelDownload?(resourceId: string): Promise<NovelDownloadDescriptor>;
  downloadNovel?(resourceId: string, input: NovelDownloadInput): Promise<NovelDownloadResult>;
  healthCheck(): Promise<SourceHealth>;
}

export function protocolFromUrl(url: string): DownloadProtocol {
  const parsed = new URL(url);
  if (parsed.protocol === "magnet:" || /\.torrent(?:$|\?)/i.test(decodeURIComponent(parsed.pathname))) {
    throw new Error("动漫磁力/种子下载已移除，资源只支持 HTTP/HTTPS 直链");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("资源只支持 HTTP/HTTPS 直链");
  }
  return "http";
}
