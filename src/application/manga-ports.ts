import type { MangaChapterInput, MangaChapterResult } from "@/domain/manga";

export interface MangaChapterService {
  downloadAndPackage(input: MangaChapterInput): Promise<MangaChapterResult>;
}
