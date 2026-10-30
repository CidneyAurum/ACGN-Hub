export interface MangaChapterInput {
  imageUrls: string[];
  incomingRoot: string;
  tempDirectory: string;
  outputRoot: string;
  outputPath: string;
  isCancelled?: () => boolean;
  referer?: string;
  cookie?: string;
  onProgress?: (progress: { stage: "downloading" | "packaging"; completed: number; total: number; detail?: string }) => void;
}

export interface MangaChapterDescriptor {
  imageUrls: string[];
  title: string;
  chapter: string;
  referer?: string;
  cookie?: string;
}

export interface MangaChapterResult {
  outputPath: string;
  imagePaths: string[];
  pageCount: number;
}
