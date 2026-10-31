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

export function resourceDedupeKey(resource: Pick<ResourceItem, "protocol" | "targetUrl"> & Partial<Pick<ResourceItem, "metadata">>): string {
  // Official releases may share one landing page across platforms or editions.
  // Keep those records distinct while ordinary file downloads still dedupe by URL.
  const releaseId = resource.metadata?.downloadMode === "external_link" && typeof resource.metadata.vndbReleaseId === "string"
    && /^r[1-9]\d*$/.test(resource.metadata.vndbReleaseId) ? resource.metadata.vndbReleaseId : undefined;
  const suffix = releaseId ? `#release=${releaseId}` : "";
  try {
    const parsed = new URL(resource.targetUrl);
    parsed.hash = "";
    return `${resource.protocol}:${parsed.toString()}${suffix}`;
  } catch {
    return `${resource.protocol}:${resource.targetUrl.trim()}${suffix}`;
  }
}
