import { describe, expect, it } from "vitest";
import type { SourceConfig } from "@/domain/source";
import { filterSourcesByType, getSourceCapability, getSourcePriority, getSourceUsage, sourceSupportsType } from "@/infrastructure/sources/source-catalog";
import { DEFAULT_RESOURCE_SOURCE_CONFIGS } from "@/infrastructure/sources/default-sources";

function source(type: SourceConfig["type"], overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { id: type, type, name: type, url: "https://custom.example.test/feed.xml", enabled: false, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z", ...overrides };
}

describe("source catalog", () => {
  it.each(["https://mikanani.me/RSS/Classic", "https://www.mikanani.me/RSS/Classic", "https://acgnx.se/rss.xml", "https://share.acgnx.se/rss.xml", "https://nyaa.si/?page=rss", "https://api.anime.garden/feed"])("keeps the recognized anime feed %s out of book and game choices", (url) => {
    const config = source("rss", { url });
    expect(getSourceCapability(config).supportedTypes).toEqual(["anime"]);
    expect(sourceSupportsType(config, "manga")).toBe(false);
    expect(sourceSupportsType(config, "novel")).toBe(false);
    expect(sourceSupportsType(config, "visual_novel")).toBe(false);
  });

  it("retains broad custom subscriptions without mistaking a lookalike hostname for a known anime site", () => {
    const custom = source("rss", { url: "https://mikanani.me.custom.example.test/manga.xml" });
    expect(getSourceCapability(custom).supportedTypes).toEqual(["anime", "manga", "novel", "visual_novel"]);
    expect(getSourceUsage(custom).tier).toBe("custom");
    expect(getSourceCapability("nyaa").supportedTypes).toEqual(["anime"]);
    expect(getSourceCapability("anime_garden").supportedTypes).toEqual(["anime"]);
  });

  it("filters by adapter purpose and prioritizes the intended Chinese book sources", () => {
    const list = DEFAULT_RESOURCE_SOURCE_CONFIGS;
    const forType = (type: "anime" | "manga" | "novel" | "visual_novel") => filterSourcesByType(list, type).sort((left, right) => getSourcePriority(left, type) - getSourcePriority(right, type));
    expect(forType("anime").slice(0, 2).map((item) => item.id)).toEqual(["builtin:mikan", "builtin:acgnx"]);
    expect(forType("manga").map((item) => item.type)).toEqual(["mangabz", "copymanga", "mangadex", "jmcomic"]);
    expect(forType("novel").map((item) => item.type)).toEqual(["lnovel", "archive"]);
    expect(forType("visual_novel").map((item) => item.type)).toEqual(["kungal", "vndb_release"]);
  });

  it("preserves custom addresses, credentials and enablement while filtering the displayed list", () => {
    const copy = source("copymanga", { id: "my-copy", url: "https://my-api.example.test", token: "private-token", enabled: true });
    const custom = source("rss", { id: "my-feed", url: "https://my.example.test/updated.xml", enabled: false });
    const invalid = source("rss", { id: "fix-me", url: "broken saved URL" });
    const list = [copy, custom, invalid];
    const original = JSON.stringify(list);
    expect(filterSourcesByType(list)).toEqual(list);
    expect(filterSourcesByType(list, "novel")).toEqual([custom, invalid]);
    expect(filterSourcesByType(list, "manga")).toEqual(list);
    expect(JSON.stringify(list)).toBe(original);
    expect(filterSourcesByType(list)[0]).toBe(copy);
  });

  it("keeps optional project attachments and Python bridges below the main anime sources", () => {
    const mikan = source("rss", { url: "https://mikanani.me/RSS/Classic" });
    expect(getSourcePriority(source("github_release"), "anime")).toBeGreaterThan(getSourcePriority(mikan, "anime"));
    expect(getSourceUsage(source("github_release")).label).toBe("项目附件");
    expect(getSourcePriority(source("jmcomic"), "anime")).toBe(1000);
    expect(getSourceUsage(source("jmcomic")).requirements.join(" ")).toContain("Python");
    expect(getSourceUsage(source("public_video")).requirements.join(" ")).toContain("FFmpeg");
  });

  it("describes optional tokens without exposing credentials or promising chapter permission", () => {
    const anonymous = getSourceUsage(source("copymanga"));
    const authenticated = getSourceUsage(source("copymanga", { token: "real-secret-sample" }));
    expect(anonymous.requirements.join(" ")).toContain("公开章节无需Token");
    expect(authenticated.requirements.join(" ")).toContain("权限需原站验证");
    expect(JSON.stringify(authenticated)).not.toContain("real-secret-sample");
  });

  it("distinguishes public uploads, multilingual chapters and external indexes from full episodes", () => {
    const publicVideo = getSourceUsage(source("public_video"));
    expect(publicVideo.tier).toBe("backup");
    expect(publicVideo.description).toContain("解说、片段或合集");
    expect(publicVideo.format).not.toContain("正片");
    expect(getSourceUsage(source("mangadex")).description).toContain("不代表该语言有章节");
    const index = getSourceUsage(source("kungal"));
    expect(index.tier).toBe("index");
    expect(index.format).toBe("站外资源索引");
    expect(index.requirements.join(" ")).toContain("原站登录");
  });

  it("does not turn adapter preference or descriptions into a live health result", () => {
    const original = source("mangabz");
    const failed = { ...original, lastHealth: { ok: false, checkedAt: "2026-10-30T12:00:00Z", message: "HTTP 503" } };
    expect(getSourcePriority(failed, "manga")).toBe(getSourcePriority(original, "manga"));
    expect(getSourceUsage(failed)).toEqual(getSourceUsage(original));
    expect(failed.lastHealth.ok).toBe(false);
  });

  it("handles unsupported and retired types without restoring retired presets", () => {
    expect(getSourceCapability("__proto__").supportedTypes).toEqual([]);
    expect(getSourceCapability("toString").supportedTypes).toEqual([]);
    for (const type of ["weebcentral", "kuaikan"] as const) {
      expect(getSourcePriority(source(type))).toBe(1000);
      expect(getSourceUsage(source(type)).tier).toBe("unsupported");
      expect(DEFAULT_RESOURCE_SOURCE_CONFIGS.some((item) => item.type === type)).toBe(false);
    }
  });
});
