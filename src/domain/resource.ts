import type { DownloadProtocol } from "@/domain/download";

export interface ResourceItem {
  id: string;
  sourceId: string;
  sourceItemId: string;
  mediaId?: string;
  title: string;
  protocol: DownloadProtocol;
  targetUrl: string;
  episode?: number;
  chapter?: number;
  volume?: number;
  language?: string;
  resolution?: string;
  format?: string;
  sizeBytes?: number;
  publishedAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function resourceDedupeKey(resource: Pick<ResourceItem, "protocol" | "targetUrl">): string {
  try {
    const parsed = new URL(resource.targetUrl);
    parsed.hash = "";
    return `${resource.protocol}:${parsed.toString()}`;
  } catch {
    return `${resource.protocol}:${resource.targetUrl.trim()}`;
  }
}
