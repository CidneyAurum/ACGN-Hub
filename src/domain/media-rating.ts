import type { Media } from "./media";

/** Normalize provider ratings without turning missing or malformed data into zero. */
export function normalizeMediaRating(value: unknown): number | undefined {
  let score: number;
  if (typeof value === "number") score = value;
  else if (typeof value === "string" && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) score = Number(value.trim());
  else return undefined;
  return Number.isFinite(score) && score >= 0 && score <= 10 ? score : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prefer normalized metadata, then the provider's raw score when available. */
export function getMediaRating(media: Pick<Media, "metadata">): number | undefined {
  const metadata = media.metadata;
  if (!record(metadata)) return undefined;
  const preferred = normalizeMediaRating(metadata.rating);
  if (preferred !== undefined) return preferred;
  const raw = metadata.raw;
  if (!record(raw) || !record(raw.rating)) return undefined;
  return normalizeMediaRating(raw.rating.score);
}
