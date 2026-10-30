export type AnimeQuarter = 1 | 2 | 3 | 4;

export interface AnimeSeason {
  year: number;
  quarter: AnimeQuarter;
}

export interface AnimeSeasonRange {
  startDate: string;
  endDateExclusive: string;
}

export function validateAnimeSeason(season: AnimeSeason): void {
  if (!season || !Number.isInteger(season.year) || season.year < 1900 || season.year > 9998 ||
    !Number.isInteger(season.quarter) || season.quarter < 1 || season.quarter > 4) {
    throw new RangeError("番剧季度无效，请选择 1900 年以后的有效年份与季度");
  }
}

/** Uses the viewer's local year/month, rather than the UTC date near midnight. */
export function getCurrentAnimeSeason(now: Date = new Date()): AnimeSeason {
  if (!Number.isFinite(now.getTime())) throw new RangeError("当前日期无效");
  const season = { year: now.getFullYear(), quarter: (Math.floor(now.getMonth() / 3) + 1) as AnimeQuarter };
  validateAnimeSeason(season);
  return season;
}

export function getAnimeSeasonLabel(season: AnimeSeason): string {
  validateAnimeSeason(season);
  const names = ["冬季", "春季", "夏季", "秋季"];
  return `${season.year}年${(season.quarter - 1) * 3 + 1}月·${names[season.quarter - 1]}`;
}

export function getAnimeSeasonRange(season: AnimeSeason): AnimeSeasonRange {
  validateAnimeSeason(season);
  const month = (season.quarter - 1) * 3 + 1;
  const nextYear = season.quarter === 4 ? season.year + 1 : season.year;
  const nextMonth = season.quarter === 4 ? 1 : month + 3;
  const date = (year: number, value: number) => `${String(year).padStart(4, "0")}-${String(value).padStart(2, "0")}-01`;
  return { startDate: date(season.year, month), endDateExclusive: date(nextYear, nextMonth) };
}

/** Current season first, followed by previous seasons; never returns a future season. */
export function listAnimeSeasons(now: Date = new Date(), count = 12): AnimeSeason[] {
  if (!Number.isInteger(count) || count < 1 || count > 400) throw new RangeError("季度列表数量须在 1 到 400 之间");
  const current = getCurrentAnimeSeason(now);
  const currentIndex = current.year * 4 + current.quarter - 1;
  const result: AnimeSeason[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = currentIndex - offset;
    const year = Math.floor(index / 4);
    if (year < 1900) break;
    result.push({ year, quarter: (index % 4 + 1) as AnimeQuarter });
  }
  return result;
}

/** Strict Gregorian dates prevent partial or normalized dates from leaking across seasons. */
export function isDateInAnimeSeason(value: unknown, season: AnimeSeason): value is string {
  const { startDate, endDateExclusive } = getAnimeSeasonRange(season);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < startDate || value >= endDateExclusive) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
