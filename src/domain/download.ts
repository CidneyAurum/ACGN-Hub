export const DOWNLOAD_STATES = [
  "queued",
  "downloading",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export type DownloadState = (typeof DOWNLOAD_STATES)[number];

export type DownloadProtocol = "http" | "magnet" | "torrent";
export type DownloadStage = "queued_engine" | "fetching_torrent" | "fetching_metadata" | "connecting" | "downloading" | "checking" | "completed";

export interface DownloadNaming {
  status: "renamed" | "failed" | "skipped";
  originalFileName?: string;
  originalPath?: string;
  currentFileName?: string;
  renamedAt?: string;
  message?: string;
}

export interface DownloadDiagnostics {
  stage?: DownloadStage;
  /** Connected peers reported by the BT engine, rather than a public swarm estimate. */
  peers?: number;
  infoHash?: string;
  verifiedBytes?: number;
  verifyIntegrityPending?: boolean;
}

export interface DownloadEngineSettings {
  maxConcurrentDownloads: number;
  speedLimitBytesPerSecond: number;
}

export const isLegacyDownloadProtocol = (protocol: string): boolean =>
  !["http", "magnet", "torrent"].includes(protocol);

export interface DownloadTarget {
  protocol: DownloadProtocol;
  url: string;
  filename?: string;
}

export interface DownloadTask extends DownloadDiagnostics {
  naming?: DownloadNaming;
  id: string;
  engineId: string;
  engineEndpoint?: string;
  engineTaskId?: string;
  mediaId?: string;
  resourceId?: string;
  sourceName?: string;
  sourceUrl: string;
  protocol: DownloadProtocol;
  directory: string;
  filename?: string;
  state: DownloadState;
  totalBytes: number;
  completedBytes: number;
  speedBytesPerSecond: number;
  connections?: number;
  /** Connected seeders reported by the download engine. */
  seeders?: number;
  errorCode?: string;
  files: string[];
  tempPath?: string;
  finalPath?: string;
  error?: string;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadStatus extends DownloadDiagnostics {
  engineTaskId?: string;
  filename?: string;
  /** Native mobile downloads return the checked canonical output directory. */
  directory?: string;
  state: DownloadState;
  totalBytes: number;
  completedBytes: number;
  speedBytesPerSecond: number;
  files: string[];
  connections?: number;
  seeders?: number;
  error?: string;
  errorCode?: string;
}

export interface DownloadOptions {
  directory: string;
  filename?: string;
  speedLimitBytesPerSecond?: number;
  clientTag?: string;
}
