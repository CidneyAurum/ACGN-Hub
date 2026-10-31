import { describe, expect, it } from "vitest";
import { canAutoContinueReading, parseNovelText } from "@/domain/novel-reader";

describe("plain text novel structure", () => {
  it("recognizes Chinese chapters, volume labels and book afterwords without interpreting HTML", () => {
    const parsed = parseNovelText("\uFEFF序章\r\n<script>literal</script>\r\n\r\n第一章 启程\n第一段。\n第二行。\n\n第2卷 新的旅程\n卷内容\n\n后记\n&<>");
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(["序章", "第一章 启程", "第2卷 新的旅程", "后记"]);
    expect(parsed.blocks.find((block) => block.text.includes("script"))?.heading).toBe(false);
    expect(parsed.blocks.find((block) => block.text.includes("第一段"))?.text).toBe("第一段。\n第二行。");
    for (const chapter of parsed.chapters) expect(parsed.blocks[chapter.blockIndex].id).toBe(chapter.id);
  });

  it("does not misclassify ordinary prose as a chapter and retains unstructured content", () => {
    const text = "第一章的故事现在开始。\n这是正文里的序章说明。\n\n<script>alert(1)</script>";
    const parsed = parseNovelText(text);
    expect(parsed.structured).toBe(false);
    expect(parsed.chapters).toEqual([]);
    expect(parsed.blocks.map((block) => block.text).join("\n\n")).toBe(text);
  });

  it("bounds the number of rendered blocks and never discards the remaining text", () => {
    const text = Array.from({ length: 15_000 }, (_, index) => `段落${index}`).join("\n\n");
    const parsed = parseNovelText(text);
    expect(parsed.blocks.length).toBeLessThanOrEqual(12_001);
    expect(parsed.blocks.at(-1)?.text).toContain("段落14999");
  });
});

describe("automatic next volume eligibility", () => {
  const input = { enabled: true, interacted: true, ready: true, atEnd: true, hasNext: true, cancelled: false };
  it("requires user reading interaction, completed rendering and another downloaded unit", () => {
    expect(canAutoContinueReading(input)).toBe(true);
    for (const key of ["enabled", "interacted", "ready", "atEnd", "hasNext"] as const) expect(canAutoContinueReading({ ...input, [key]: false })).toBe(false);
    expect(canAutoContinueReading({ ...input, cancelled: true })).toBe(false);
  });
});
