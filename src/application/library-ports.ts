import type { Media } from "@/domain/media";

export interface MediaLibraryRepository {
  initialize(): Promise<void>;
  list(): Promise<Media[]>;
  upsert(media: Media): Promise<void>;
  remove(mediaId: string): Promise<void>;
}
