import { describe, expect, it } from "vitest";
import { matchAuthorName, type Author } from "@/domain/author";

function author(name: string, aliases: string[] = [], summary?: string): Author {
  return { id: "6207", name, aliases, ...(summary ? { summary } : {}) };
}

describe("author name matching", () => {
  it("matches an exact official name or alias with the same highest score", () => {
    const iruma = author("入間人間", ["入间人间", "Iruma Hitoma"]);
    expect(matchAuthorName(iruma, "入間人間")).toBe(100);
    expect(matchAuthorName(iruma, "入间人间")).toBe(100);
    expect(matchAuthorName(iruma, "Iruma Hitoma")).toBe(100);
    expect(matchAuthorName(author("原名", ["完全不同的笔名"]), "完全不同的笔名")).toBe(100);
  });

  it("matches common traditional and simplified name variants even without saved aliases", () => {
    expect(matchAuthorName(author("入間人間"), "入间人间")).toBe(100);
    expect(matchAuthorName(author("劉德華"), "刘德华")).toBe(100);
    expect(matchAuthorName(author("張達島"), "张达岛")).toBe(100);
    expect(matchAuthorName(author("與野華"), "与野华")).toBe(100);
    expect(matchAuthorName(author("横濑纪彦"), "橫瀨紀彥")).toBe(100);
  });

  it("normalizes NFKC, case, spaces and punctuation for Latin and Japanese names", () => {
    expect(matchAuthorName(author("入間人間", ["Iruma Hitoma"]), "ＩＲＵＭＡ　ＨＩＴＯＭＡ")).toBe(100);
    expect(matchAuthorName(author("CLAMP"), "ｃｌａｍｐ")).toBe(100);
    expect(matchAuthorName(author("J. R. R. Tolkien"), "jrr tolkien")).toBe(100);
    expect(matchAuthorName(author("アン・マキャフリイ"), "アン マキャフリイ")).toBe(100);
    expect(matchAuthorName(author("入間 人間"), " 入间\u200b人间　")).toBe(100);
  });

  it("splits explicit composite alias separators without changing the original display text", () => {
    const original = author("入間人間", ["入间人间 / Iruma Hitoma", "別名甲；別名乙", "原名丙、原名丁", "Alias One|Alias Two"]);
    const before = structuredClone(original);
    expect(matchAuthorName(original, "IRUMAHITOMA")).toBe(100);
    expect(matchAuthorName(original, "別名乙")).toBe(100);
    expect(matchAuthorName(original, "原名丁")).toBe(100);
    expect(matchAuthorName(original, "alias two")).toBe(100);
    expect(original).toEqual(before);
  });

  it("ignores all summaries, unrelated aliases and title-like metadata noise", () => {
    const noise = author("劉德華", ["Andy Lau"], "出身民間，作品评论曾提到入間人間和安达与岛村。");
    expect(matchAuthorName(noise, "入间人间")).toBe(0);
    expect(matchAuthorName(noise, "民间")).toBe(0);
    expect(matchAuthorName(noise, "安达与岛村")).toBe(0);
    expect(matchAuthorName(author("入江泰浩"), "入间人间")).toBe(0);
    expect(matchAuthorName(author("入間人間"), "间人")).toBe(0);
    expect(matchAuthorName(author("入間人間"), "人间")).toBe(0);
  });

  it("allows prefixes only at three or more normalized characters and ranks exact matches first", () => {
    expect(matchAuthorName(author("入間人間"), "入间人")).toBe(80);
    expect(matchAuthorName(author("入間人間"), "入间")).toBe(0);
    expect(matchAuthorName(author("入間人間"), "入")).toBe(0);
    expect(matchAuthorName(author("入江泰浩"), "入")).toBe(0);
    expect(matchAuthorName(author("Iruma Hitoma"), "iru")).toBe(80);
    expect(matchAuthorName(author("Iruma Hitoma"), "ir")).toBe(0);
    expect(matchAuthorName(author("Iruma"), "Iruma Hitoma")).toBe(0);
    const exact = author("入間人", ["別名"]);
    expect(matchAuthorName(exact, "入间人")).toBeGreaterThan(matchAuthorName(author("入間人間"), "入间人"));
  });

  it("gives equally named people equal scores so identity selection stays with the caller", () => {
    expect([author("入間人間"), author("入间人间", ["同名"]), author("入江泰浩")].map((entry) => matchAuthorName(entry, "入间人间"))).toEqual([100, 100, 0]);
  });

  it("rejects empty or punctuation-only queries and does not transliterate pinyin", () => {
    for (const query of ["", "　 ", "---", "· / 。"]) expect(matchAuthorName(author("入間人間"), query)).toBe(0);
    expect(matchAuthorName(author("入間人間"), "ru jian ren jian")).toBe(0);
    expect(matchAuthorName(author(""), "作者")).toBe(0);
  });
});
