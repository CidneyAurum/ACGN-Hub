import type { Media, MediaDetails, MediaType } from "@/domain/media";

export interface MetadataSearchQuery {
  keyword: string;
  type?: MediaType;
  page?: number;
  pageSize?: number;
}

export type SearchMatchReason =
  | "exact"
  | "alias"
  | "prefix"
  | "contains"
  | "pinyin"
  | "fuzzy";

export interface SearchCandidate {
  media: Media;
  score: number;
  reason: SearchMatchReason;
}

export interface MetadataProvider {
  readonly id: string;
  readonly supportedTypes: readonly MediaType[];
  search(query: MetadataSearchQuery): Promise<Media[]>;
  getById(externalId: string): Promise<Media>;
  /**
   * Rich structured introduction (tags/rating/staff/characters…).
   * Optional: providers without deep endpoints simply omit it, and the UI
   * degrades to the plain Media description.
   */
  getDetails?(externalId: string): Promise<MediaDetails>;
}
