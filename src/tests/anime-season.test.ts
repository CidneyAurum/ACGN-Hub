import { describe, expect, it } from "vitest";
import { getAnimeSeasonLabel, getAnimeSeasonRange, getCurrentAnimeSeason, isDateInAnimeSeason, listAnimeSeasons } from "@/domain/anime-season";

describe("anime seasons", () => {
  it("rolls over on local January, April, July and October boundaries", () => {
    for (const [month, expectedQuarter] of [[0, 1], [2, 1], [3, 2], [5, 2], [6, 3], [8, 3], [9, 4], [11, 4]] as const) {
      expect(getCurrentAnimeSeason(new Date(2026, month, 1, 0, 0, 0))).toEqual({ year: 2026, quarter: expectedQuarter });
    }
    expect(getCurrentAnimeSeason(new Date(2027, 0, 1, 0, 0, 0))).toEqual({ year: 2027, quarter: 1 });
  });

  it("uses half-open date windows including leap day and the next year", () => {
    expect(getAnimeSeasonRange({ year: 2026, quarter: 4 })).toEqual({ startDate: "2026-10-01", endDateExclusive: "2027-01-01" });
    expect(getAnimeSeasonRange({ year: 2024, quarter: 1 })).toEqual({ startDate: "2024-01-01", endDateExclusive: "2024-04-01" });
    expect(isDateInAnimeSeason("2024-02-29", { year: 2024, quarter: 1 })).toBe(true);
    expect(isDateInAnimeSeason("2026-02-29", { year: 2026, quarter: 1 })).toBe(false);
    expect(isDateInAnimeSeason("2026-10-01", { year: 2026, quarter: 4 })).toBe(true);
    expect(isDateInAnimeSeason("2026-12-31", { year: 2026, quarter: 4 })).toBe(true);
    expect(isDateInAnimeSeason("2026-09-30", { year: 2026, quarter: 4 })).toBe(false);
    expect(isDateInAnimeSeason("2027-01-01", { year: 2026, quarter: 4 })).toBe(false);
    expect(isDateInAnimeSeason("2026-10", { year: 2026, quarter: 4 })).toBe(false);
    expect(isDateInAnimeSeason("2026-11-31", { year: 2026, quarter: 4 })).toBe(false);
  });

  it("lists the current and eleven previous seasons with correct labels", () => {
    const seasons = listAnimeSeasons(new Date(2027, 0, 1));
    expect(seasons).toHaveLength(12);
    expect(seasons.slice(0, 3)).toEqual([{ year: 2027, quarter: 1 }, { year: 2026, quarter: 4 }, { year: 2026, quarter: 3 }]);
    expect(seasons[11]).toEqual({ year: 2024, quarter: 2 });
    expect(getAnimeSeasonLabel({ year: 2026, quarter: 4 })).toBe("2026年10月·秋季");
    expect(getAnimeSeasonLabel({ year: 2027, quarter: 1 })).toBe("2027年1月·冬季");
  });

  it("rejects invalid dates, quarters and counts instead of silently switching seasons", () => {
    expect(() => getCurrentAnimeSeason(new Date(NaN))).toThrow(RangeError);
    expect(() => getAnimeSeasonRange({ year: 2026, quarter: 5 } as never)).toThrow(RangeError);
    expect(() => getAnimeSeasonRange({ year: 2026.5, quarter: 1 })).toThrow(RangeError);
    expect(() => listAnimeSeasons(new Date(), 0)).toThrow(RangeError);
    expect(listAnimeSeasons(new Date(1900, 0, 1), 12)).toEqual([{ year: 1900, quarter: 1 }]);
  });
});
