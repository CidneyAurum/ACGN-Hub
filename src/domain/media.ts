export type MediaType = "anime" | "manga" | "novel" | "visual_novel";

export interface ExternalId {
  provider: string;
  value: string;
}

export interface Media {
  id: string;
  type: MediaType;
  title: string;
  originalTitle?: string;
  aliases: string[];
  description?: string;
  coverUrl?: string;
  releaseYear?: number;
  externalIds: ExternalId[];
  metadata: Record<string, unknown>;
}

export interface MediaRating {
  /** 0-10 score; providers use different scales so the UI normalizes. */
  score?: number;
  count?: number;
}

export interface MediaStaffMember {
  name: string;
  originalName?: string;
  role?: string;
}

export interface MediaCharacterActor {
  name: string;
  role?: string;
}

export interface MediaCharacter {
  name: string;
  role?: string;
  actors: MediaCharacterActor[];
}

/** Structured, provider-normalized introduction shown on the media page. */
export interface MediaDetails {
  providerId: string;
  externalId: string;
  summary?: string;
  tags: string[];
  rating?: MediaRating;
  episodes?: number;
  airDate?: string;
  studios: string[];
  platforms: string[];
  durationMinutes?: number;
  developers: string[];
  staff: MediaStaffMember[];
  characters: MediaCharacter[];
}
