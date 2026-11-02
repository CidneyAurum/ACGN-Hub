import { afterEach, expect, it, vi } from "vitest";
import type { SourceConfig } from "@/domain/source";
import { filterSourcesByType, filterSourcesForPlatform, sourcePlatformUnavailableReason } from "@/infrastructure/sources/source-catalog";
import { loadSourceItemResources, searchSourceCandidates } from "@/application/resource-discovery";
import { setRuntimePlatform } from "@/shared/runtime";

const jm: SourceConfig = { id: "my-jm", type: "jmcomic", name: "我的 JMComic", url: "python://jmcomic", enabled: true, createdAt: "2026-11-01", updatedAt: "2026-11-01" };
const manga: SourceConfig = { ...jm, id: "manga", type: "mangabz", url: "https://mangabz.com" };
afterEach(() => { setRuntimePlatform(""); vi.unstubAllGlobals(); });

it("keeps existing desktop bridge configuration visible without offering it for Android searches", () => {
  const configs = [jm, manga]; const saved = JSON.stringify(configs);
  expect(filterSourcesByType(configs, "manga")).toEqual(configs);
  expect(filterSourcesForPlatform(configs, true)).toEqual([manga]);
  expect(filterSourcesForPlatform(configs, false)).toEqual(configs);
  expect(sourcePlatformUnavailableReason(jm, true)).toContain("电脑端 Python");
  expect(sourcePlatformUnavailableReason(jm, true)).toContain("配置已保留");
  expect(sourcePlatformUnavailableReason(manga, true)).toBeUndefined();
  expect(JSON.stringify(configs)).toBe(saved);
  expect(jm.enabled).toBe(true);
});

it("blocks a saved JMComic route and all-source searches before any unavailable native bridge is invoked", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { userAgent: "Android WebView" });
  setRuntimePlatform("android");
  const factory = vi.fn();
  const result = await searchSourceCandidates({ keyword: "固定漫画", mediaType: "manga", sources: [jm] }, factory);
  expect(result).toEqual({ candidates: [], failures: [], searchedSources: 0 });
  await expect(loadSourceItemResources({ config: jm, sourceItemId: "123", title: "固定漫画", mediaType: "manga" }, factory)).rejects.toThrow("电脑端 Python");
  expect(factory).not.toHaveBeenCalled();
});

it("rejects saved public-video routes on Android before Python inspection and preserves desktop access", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { userAgent: "Android WebView" });
  setRuntimePlatform("android");
  const video: SourceConfig = { ...jm, id: "my-public-video", type: "public_video", name: "公开投稿", url: "https://www.bilibili.com" };
  const factory = vi.fn();
  const result = await searchSourceCandidates({ keyword: "BV1Abcdefghi", mediaType: "anime", sources: [video] }, factory);
  expect(result).toEqual({ candidates: [], failures: [], searchedSources: 0 });
  await expect(loadSourceItemResources({ config: video, sourceItemId: "BV1Abcdefghi", title: "投稿", mediaType: "anime" }, factory)).rejects.toThrow("电脑版");
  expect(factory).not.toHaveBeenCalled();
  expect(sourcePlatformUnavailableReason(video, false)).toBeUndefined();
  expect(video.enabled).toBe(true);
});
