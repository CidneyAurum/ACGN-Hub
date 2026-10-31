import { describe, expect, it } from "vitest";
import type { ResourceItem } from "@/domain/resource";
import { compareGalgameResources, emptyGalgameResourceFilters, galgameDownloadDirectory, galgameDownloadFileName, galgameResourceFacets, matchesGalgameResource, resourceMatchesKeywords } from "@/domain/galgame-resource";

function resource(id: string, metadata: Record<string, unknown> = {}, extra: Partial<ResourceItem> = {}): ResourceItem {
  return { id, sourceId: "fixture", sourceItemId: "work", title: id, protocol: "http", targetUrl: `https://files.example/${id}.7z`, createdAt: "2026-10-31", metadata, ...extra };
}
const declaredGame = { resourceType: "game", languages: ["zh-CN"], platforms: ["win"], downloadMode: "direct_file" };

describe("Galgame resource conditions", () => {
  it("reads KUN's declared fields and official release metadata without requiring adapter-specific source IDs", () => {
    expect(galgameResourceFacets(resource("kun", { resourceType: "game", languageLabels: ["简体中文"], platform: "win", downloadMode: "external_link" }))).toEqual({ chinese: true, windows: true, content: "game", acquisition: "external" });
    expect(galgameResourceFacets(resource("official", { releaseType: "complete", patch: false, languages: ["en", "zh-Hant"], platforms: ["win", "lin"], downloadMode: "external_link" }))).toEqual({ chinese: true, windows: true, content: "game", acquisition: "external" });
    expect(galgameResourceFacets(resource("direct", declaredGame))).toEqual({ chinese: true, windows: true, content: "game", acquisition: "direct" });
  });

  it("keeps unknown language, platform and HTTP file behavior unknown", () => {
    const unknown = resource("unknown", { text: "中文 Windows 游戏", platform: "PC" }, { title: "中文名字的作品.7z" });
    expect(galgameResourceFacets(unknown)).toEqual({ chinese: false, windows: false, content: "other", acquisition: "other" });
    expect(matchesGalgameResource(unknown, { ...emptyGalgameResourceFilters(), chinese: true })).toBe(false);
    expect(matchesGalgameResource(unknown, { ...emptyGalgameResourceFilters(), windows: true })).toBe(false);
  });

  it("does not mistake a source's untranslated-language note for a Chinese release", () => {
    expect(galgameResourceFacets(resource("original", { language: "日文原版 / 未汉化" })).chinese).toBe(false);
    expect(galgameResourceFacets(resource("original", { language: "Japanese / no Chinese" })).chinese).toBe(false);
  });

  it.each([
    [{ ...declaredGame, patch: true, releaseType: "complete" }, "patch"],
    [{ ...declaredGame, resourceType: "patch" }, "patch"],
    [{ ...declaredGame, releaseType: "trial", freeware: true }, "trial"],
    [{ ...declaredGame, releaseType: "partial" }, "other"],
    [{ ...declaredGame, resourceType: "collection" }, "collection"],
  ])("does not describe a patch, trial, partial or collection as a standalone game: %j", (metadata, content) => {
    const value = resource("variant", metadata);
    expect(galgameResourceFacets(value).content).toBe(content);
    expect(matchesGalgameResource(value, { ...emptyGalgameResourceFilters(), game: true })).toBe(false);
  });

  it("combines language, platform, game and acquisition conditions", () => {
    const options = [resource("wanted", declaredGame), resource("android", { ...declaredGame, platforms: ["and"] }),
      resource("japanese", { ...declaredGame, languages: ["ja"] }), resource("patch", { ...declaredGame, resourceType: "patch" }),
      resource("external", { ...declaredGame, downloadMode: "external_link" })];
    expect(options.filter((item) => matchesGalgameResource(item, { chinese: true, windows: true, game: true, acquisition: "direct" })).map((item) => item.id)).toEqual(["wanted"]);
    expect(options.filter((item) => matchesGalgameResource(item, { ...emptyGalgameResourceFilters(), acquisition: "external" })).map((item) => item.id)).toEqual(["external"]);
  });

  it("does not classify BT links as HTTP file downloads even with a stale direct-file marker", () => {
    expect(galgameResourceFacets(resource("bt", declaredGame, { protocol: "magnet" })).acquisition).toBe("other");
  });

  it("matches multiple words across independent fields and normalizes full-width text", () => {
    const value = resource("原版压缩包", { ...declaredGame, languageLabels: ["简体中文"], platformLabels: ["Windows"], providerNames: ["公开文件站"] });
    expect(resourceMatchesKeywords(value, " 中文　Ｗｉｎｄｏｗｓ 公开文件站 本体 ")).toBe(true);
    expect(resourceMatchesKeywords(value, "中文 Android")).toBe(false);
    expect(resourceMatchesKeywords(value, "文件直链")).toBe(true);
    expect(resourceMatchesKeywords(value, "")).toBe(true);
  });

  it("ignores malformed optional metadata", () => {
    const value = resource("正常标题", { languages: [{ lang: "zh-CN" }], platformLabels: [null, 2], language: false, resourceType: {}, searchTerms: ["有效词", null] });
    expect(galgameResourceFacets(value)).toEqual({ chinese: false, windows: false, content: "other", acquisition: "other" });
    expect(resourceMatchesKeywords(value, "有效词 标题")).toBe(true);
  });

  it("ranks declared Chinese Windows game files ahead of share pages, mobile builds, trials and patches", () => {
    const items = [resource("trial", { ...declaredGame, releaseType: "trial" }), resource("patch", { ...declaredGame, patch: true }),
      resource("android", { ...declaredGame, platforms: ["and"] }), resource("external", { ...declaredGame, downloadMode: "external_link" }),
      resource("wanted", declaredGame)];
    const snapshot = JSON.stringify(items);
    expect([...items].sort(compareGalgameResources).map((item) => item.id)).toEqual(["wanted", "external", "android", "trial", "patch"]);
    expect(JSON.stringify(items)).toBe(snapshot);
  });

  it("uses actual source update times as a tie breaker and preserves equal source order", () => {
    const items = [resource("old", { ...declaredGame, sourceUpdatedAt: "2025-01-01" }), resource("new", { ...declaredGame, sourceUpdatedAt: "2026-10-31" }), resource("equal", { ...declaredGame, sourceUpdatedAt: "2026-10-31" })];
    expect([...items].sort(compareGalgameResources).map((item) => item.id)).toEqual(["new", "equal", "old"]);
  });
});

describe("Galgame archive names", () => {
  it.each(["中文版.7z", "中文版.7z.001", "中文版.7z.002", "中文版.part1.rar", "中文版.part2.rar"])("preserves the complete source filename without duplicating suffixes: %s", (filename) => {
    expect(galgameDownloadFileName(resource(filename, { downloadFileName: filename }), "English.7z")).toBe(filename);
    expect(galgameDownloadFileName(resource(filename), filename)).toBe(filename);
  });
  it("preserves split-volume suffixes even when the stem needs shortening", () => {
    const name = "作品".repeat(100) + ".7z.001";
    const result = galgameDownloadFileName(resource("标题", { downloadFileName: name }));
    expect(result).toHaveLength(180);
    expect(result.endsWith(".7z.001")).toBe(true);
    expect(result.replace(/\.001$/, ".002")).toBe(galgameDownloadFileName(resource("标题", { downloadFileName: name.replace(/\.001$/, ".002") })));
  });
  it("sanitizes filename characters and falls back to the resource title", () => {
    expect(galgameDownloadFileName(resource("作品完整包.7z"))).toBe("作品完整包.7z");
    expect(galgameDownloadFileName(resource("标题", { downloadFileName: "  作品:原版.7z.001  " }))).toBe("作品_原版.7z.001");
  });
});

describe("Galgame edition download directories", () => {
  it("isolates identically named archives from different source works and catalogs", async () => {
    const first = resource("Game.7z", {}, { sourceId: "direct:https://source.example", sourceItemId: "works/a" });
    const second = { ...first, sourceItemId: "works/b" };
    const otherSource = { ...first, sourceId: "direct:https://other.example" };
    const paths = await Promise.all([first, second, otherSource].map((item) => galgameDownloadDirectory("D:\\Downloads", item, "同名作品")));
    expect(new Set(paths).size).toBe(3);
    for (const path of paths) {
      expect(path).toMatch(/^D:\\Downloads\\Galgame\\同名作品 \[direct-[a-f\d]{32}\]$/);
      expect(path).not.toContain("https:");
    }
  });

  it("uses one stable directory for every archive volume in the same source edition", async () => {
    const first = resource("Game.7z.001", {}, { sourceId: "shinnku", sourceItemId: "edition-path" });
    const second = { ...first, id: "second", title: "Game.7z.002", targetUrl: "https://files.example/Game.7z.002" };
    const directory = await galgameDownloadDirectory("D:\\Downloads\\", first, "完整汉化版");
    expect(await galgameDownloadDirectory("D:\\Downloads", second, "完整汉化版")).toBe(directory);
    expect(await galgameDownloadDirectory("D:\\Downloads", first, "完整汉化版")).toBe(directory);
  });

  it("keeps case-sensitive source paths distinct on the Windows filesystem and sanitizes readable labels", async () => {
    const lower = { sourceId: "source", sourceItemId: "Games/title" };
    const upper = { ...lower, sourceItemId: "Games/TITLE" };
    const first = await galgameDownloadDirectory("D:\\Downloads", lower, "作品:第一版");
    const second = await galgameDownloadDirectory("D:\\Downloads", upper, "作品:第一版");
    expect(first.toLowerCase()).not.toBe(second.toLowerCase());
    expect(first).toContain("作品_第一版");
  });
});
