import type { LocalFile, ScannedLocalFile } from "@/domain/local-file";

export interface LibraryFileScanner {
  scan(libraryRoot: string, withHash: boolean): Promise<ScannedLocalFile[]>;
}

export interface LocalFileRepository {
  initialize(): Promise<void>;
  list(): Promise<LocalFile[]>;
  replaceScan(files: ScannedLocalFile[]): Promise<void>;
  assignMedia(fileId: string, mediaId?: string): Promise<void>;
}
