import { describe, expect, it } from "vitest";
import { getMediaRating, normalizeMediaRating } from "@/domain/media-rating";

describe("media rating normalization", () => {
  it.each([
    [0, 0], [10, 10], [8.7, 8.7], ["8.7", 8.7], [" 9.25 ", 9.25], ["0", 0], ["10.0", 10], [".5", 0.5],
  ])("normalizes %s into the numeric rating %s", (input, expected) => {
    const score = normalizeMediaRating(input);
    expect(score).toBe(expected);
    expect(() => score!.toFixed(1)).not.toThrow();
  });

  it.each([null, undefined, "", " ", true, false, [], {}, NaN, Infinity, -Infinity, -1, 10.1,
    "NaN", "Infinity", "8.5/10", "8分", "0x9", "8e0", "8,5", "-1", "10.01", "8.5extra"])("does not invent a rating from %s", (input) => {
    expect(normalizeMediaRating(input)).toBeUndefined();
  });

  it("prefers a valid normalized rating, including zero, over the raw provider score", () => {
    expect(getMediaRating({ metadata: { rating: "8.4", raw: { rating: { score: 9.5 } } } })).toBe(8.4);
    expect(getMediaRating({ metadata: { rating: 0, raw: { rating: { score: 9.5 } } } })).toBe(0);
  });

  it("uses a valid raw score when normalized metadata is missing or invalid", () => {
    for (const rating of [undefined, null, "", false, NaN, Infinity, 11]) {
      expect(getMediaRating({ metadata: { rating, raw: { rating: { score: "8.9" } } } })).toBe(8.9);
    }
  });

  it("keeps malformed raw shapes out of the card formatter without mutating metadata", () => {
    for (const raw of [undefined, null, [], "8.5", { rating: null }, { rating: [] }, { rating: "8.5" }, { rating: { score: "invalid" } }]) {
      const media = { metadata: { raw } };
      const before = JSON.stringify(media);
      expect(getMediaRating(media)).toBeUndefined();
      expect(JSON.stringify(media)).toBe(before);
    }
  });
});
