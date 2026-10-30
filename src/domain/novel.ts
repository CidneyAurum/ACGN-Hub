export interface NovelDownloadInput {
  incomingRoot: string;
  outputRoot: string;
  outputPath: string;
  isCancelled?: () => boolean;
  onProgress?: (progress: { stage: "downloading" | "packaging"; completed: number; total: number; detail?: string }) => void;
}

export interface NovelDownloadDescriptor {
  title: string;
  volume: string;
  chapterCount: number;
}

export interface NovelDownloadResult {
  outputPath: string;
  chapterCount: number;
  characterCount: number;
}
