export type LocalDownloadKind = "novel" | "manga" | "video";
export type LocalDownloadStage = "preparing" | "downloading" | "packaging" | "completed" | "failed" | "cancelled";

export interface LocalDownloadCleanupPath {
  path: string;
  allowedRoot: string;
}

export interface LocalDownloadTask {
  id: string;
  kind: LocalDownloadKind;
  title: string;
  sourceName: string;
  directory: string;
  outputPath: string;
  cleanupPaths?: LocalDownloadCleanupPath[];
  stage: LocalDownloadStage;
  completedUnits: number;
  totalUnits: number;
  detail?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
