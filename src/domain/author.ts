/** A real person, group or studio returned by the metadata catalogue. */
export interface Author {
  /** Bangumi person ID, kept separate from subject IDs. */
  id: string;
  name: string;
  aliases: string[];
  imageUrl?: string;
  summary?: string;
}

/** Exact name/alias = 100, a sufficiently long name prefix = 80, otherwise 0. */
export type AuthorNameMatchScore = 0 | 80 | 100;

// Deliberately limited name variants, not a general Chinese text converter.
// Japanese names commonly share these traditional forms with Chinese aliases.
const NAME_VARIANTS: Readonly<Record<string, string>> = {
  間: "间", 達: "达", 島: "岛", 與: "与", 華: "华", 劉: "刘", 陳: "陈", 張: "张", 趙: "赵", 楊: "杨",
  吳: "吴", 鄭: "郑", 馬: "马", 馮: "冯", 蔣: "蒋", 蕭: "萧", 許: "许", 葉: "叶", 蘇: "苏", 鄧: "邓",
  盧: "卢", 錢: "钱", 顧: "顾", 孫: "孙", 羅: "罗", 鍾: "钟", 鐘: "钟", 龍: "龙", 黃: "黄", 於: "于",
  澤: "泽", 岡: "冈", 崎: "崎", 齊: "齐", 齋: "斋", 齎: "赍", 橫: "横", 瀨: "濑", 櫻: "樱", 廣: "广",
  彥: "彦", 紀: "纪", 緒: "绪", 織: "织", 繪: "绘", 優: "优", 愛: "爱", 亞: "亚", 夢: "梦", 連: "连",
  東: "东", 樂: "乐", 榮: "荣", 藤: "藤", 彌: "弥", 園: "园", 國: "国", 貴: "贵", 寶: "宝", 萬: "万",
};

/**
 * Compare only official names and aliases. Search-service summaries can contain
 * unrelated names or isolated characters and must never establish authorship.
 * The source strings remain untouched so the UI can still show their spelling.
 */
export function matchAuthorName(author: Pick<Author, "name" | "aliases">, keyword: string): AuthorNameMatchScore {
  const query = normalizeAuthorName(keyword);
  if (!query) return 0;
  const candidates = [author.name, ...author.aliases.flatMap((alias) => [alias, ...alias.split(/[\/／|｜;；、\r\n]+/u)])]
    .map(normalizeAuthorName).filter(Boolean);
  if (candidates.some((name) => name === query)) return 100;
  // No substring, fuzzy or one/two-character fallback: 入 must not find 入江,
  // and 入间人间 must not find a person merely mentioning 民間 in their bio.
  if ([...query].length >= 3 && candidates.some((name) => name.startsWith(query))) return 80;
  return 0;
}

function normalizeAuthorName(value: string): string {
  return [...value.normalize("NFKC").toLowerCase()]
    .map((character) => NAME_VARIANTS[character] ?? character).join("")
    .replace(/[\s\p{P}\p{Z}\p{Cf}]+/gu, "");
}
