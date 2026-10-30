import { describe, expect, it, vi } from "vitest";
import { PublicVideoSourceProvider, parsePublicVideoInput } from "@/infrastructure/sources/public-video-source-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";

const bvid = "BV1UqHi6uEie";
const info = { id: bvid, title: "测试动画 第1话", duration: 1440, coverUrl: "https://images.example/cover.jpg", playable: true,
  uploader: "测试公开投稿者", qualityLabel: "匿名可用 360p", downloadHeightLimit: 1080, selectedFormat: { height: 360, width: 640 },
  formats: [{ id: "30016", ext: "mp4", height: 360, width: 640, hasVideo: true, hasAudio: false }] };
const response = (body: unknown, status = 200) => ({ status, json: async () => body });

describe("PublicVideoSourceProvider", () => {
  it.each([
    [`http://www.bilibili.com/video/${bvid}/?p=2&vd_source=tracking`, `https://www.bilibili.com/video/${bvid}/?p=2`],
    [`http://bilibili.com:80/video/${bvid}`, `https://www.bilibili.com/video/${bvid}/`],
    [bvid, `https://www.bilibili.com/video/${bvid}/`],
  ])("normalizes a public submission input %s before routing or inspection", (input, expected) => {
    expect(parsePublicVideoInput(input)?.url).toBe(expected);
  });

  it.each([
    `https://www.bilibili.com:8443/video/${bvid}/`, `http://www.bilibili.com:8080/video/${bvid}/`,
    `https://user:pass@www.bilibili.com/video/${bvid}/`, `https://www.bilibili.com/video/${bvid}/?p=1&p=2`,
    `https://www.bilibili.com/video/${bvid}/?p=1.0`, `https://www.bilibili.com/video/${bvid}/?p=1001`,
    `https://bilibili.com.evil.example/video/${bvid}/`,
  ])("does not recognize restricted or malformed public submission input %s", (input) => {
    expect(parsePublicVideoInput(input)).toBeUndefined();
  });

  it("searches public submissions without credentials and exposes duration, uploader and clip warnings", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher: JsonFetcher = async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return response({ code: 0, data: { result: [
        { bvid, title: '测试<em class="keyword">动画</em> 第1话', pic: "//images.example/cover.jpg", author: "公开投稿者", duration: "24:00" },
        { bvid: "BV1TuHM6REHk", title: "测试动画 PV预告", duration: "0:25", author: "测试" },
      ] } });
    };
    const provider = new PublicVideoSourceProvider(undefined, { fetcher });
    const results = await provider.search({ keyword: "测试动画", aliases: [], mediaType: "anime" });
    expect(results[0]).toMatchObject({ title: "测试动画 第1话", coverUrl: "https://images.example/cover.jpg", raw: { durationSeconds: 1440, durationLabel: "24:00", uploader: "公开投稿者" } });
    expect(results[1].raw?.videoKind).toBe("clip");
    expect(results[1].raw?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("不足 10 分钟")]));
    expect(new URL(calls[0].url).searchParams.get("keyword")).toBe("测试动画");
    expect(calls[0].headers.has("cookie")).toBe(false);
    expect(calls[0].headers.has("authorization")).toBe(false);
  });

  it("inspects a precise BV URL and preserves the selected page without persisting signed media URLs", async () => {
    const inspect = vi.fn().mockResolvedValue({ ...info, signedUrl: "https://cdn.example/video?token=temporary" });
    const provider = new PublicVideoSourceProvider(undefined, { inspect });
    const candidates = await provider.search({ keyword: `https://www.bilibili.com/video/${bvid}/?p=2`, aliases: [], mediaType: "anime" });
    const resources = await provider.listResources(candidates[0].sourceItemId);
    expect(inspect).toHaveBeenCalledWith(`https://www.bilibili.com/video/${bvid}/?p=2`);
    expect(resources[0]).toMatchObject({ targetUrl: `https://www.bilibili.com/video/${bvid}/?p=2`, format: "MP4", resolution: "360p", metadata: { downloadMode: "public_video", bvid, page: 2, publicOnly: true,
      uploader: "测试公开投稿者", qualityLabel: "匿名可用 360p", downloadHeightLimit: 1080, resourceLabel: expect.stringContaining("360p") } });
    expect(JSON.stringify(resources)).not.toContain("temporary");
    await expect(provider.resolve(resources[0].id)).resolves.toMatchObject({ url: resources[0].targetUrl });
  });

  it("restores stable resource records after restart and re-inspects exact IDs without a title search", async () => {
    const inspect = vi.fn().mockResolvedValue(info);
    const provider = new PublicVideoSourceProvider(undefined, { inspect });
    const resources = await provider.listResources(bvid);
    const restored = new PublicVideoSourceProvider();
    restored.restoreResource(resources[0]);
    await expect(restored.resolve(resources[0].id)).resolves.toMatchObject({ url: `https://www.bilibili.com/video/${bvid}/` });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("displays the inspected stream height rather than the configured quality ceiling", async () => {
    for (const height of [720, 1080]) {
      const provider = new PublicVideoSourceProvider(undefined, { inspect: async () => ({ ...info,
        selectedFormat: { height, width: height === 1080 ? 1920 : 1280 }, qualityLabel: `匿名可用 ${height}p` }) });
      const [resource] = await provider.listResources(bvid);
      expect(resource.resolution).toBe(`${height}p`);
      expect(resource.metadata.qualityLabel).toBe(`匿名可用 ${height}p`);
    }
    const failed = new PublicVideoSourceProvider(undefined, { inspect: async () => ({ ...info,
      playable: false, selectedFormat: null, unavailableReason: "所选画质未通过匿名读取检查（HTTP 403）" }) });
    await expect(failed.listResources(bvid)).rejects.toThrow("HTTP 403");
  });

  it("fails clearly on access limits instead of returning fake playable resources", async () => {
    const fetcher: JsonFetcher = async () => response({ code: -412, message: "访问受限" });
    const provider = new PublicVideoSourceProvider(undefined, { fetcher, inspect: async () => ({ ...info, playable: false }) });
    await expect(provider.search({ keyword: "测试动画", aliases: [], mediaType: "anime" })).rejects.toThrow("不会尝试绕过");
    await expect(provider.listResources(bvid)).rejects.toThrow("没有可匿名读取");
    await expect(provider.healthCheck()).resolves.toMatchObject({ ok: false });
  });

  it("rejects unrelated hosts and invalid source IDs, and does not service other media types", async () => {
    expect(() => new PublicVideoSourceProvider("https://www.bilibili.com.attacker.example")).toThrow("来源地址");
    const provider = new PublicVideoSourceProvider();
    await expect(provider.listResources(`https://attacker.example/video/${bvid}`)).rejects.toThrow("标识无效");
    await expect(provider.search({ keyword: "测试", aliases: [], mediaType: "manga" })).resolves.toEqual([]);
  });

  it("matches the native page boundary of 1000 without inspecting an out-of-range page", async () => {
    const inspect = vi.fn().mockResolvedValue(info);
    const provider = new PublicVideoSourceProvider(undefined, { inspect });
    await expect(provider.listResources(`${bvid}?p=1000`)).resolves.toMatchObject([{ metadata: { page: 1000 } }]);
    await expect(provider.listResources(`${bvid}?p=1001`)).rejects.toThrow("标识无效");
    await expect(provider.listResources(`https://www.bilibili.com/video/${bvid}/?p=0`)).rejects.toThrow("标识无效");
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("warns about long compilation uploads without claiming a verified single episode", async () => {
    const provider = new PublicVideoSourceProvider(undefined, { fetcher: async () => response({ code: 0, data: { result: [{ bvid, title: "测试动画 全12集", duration: "181:09" }] } }) });
    const results = await provider.search({ keyword: "测试动画", aliases: [], mediaType: "anime" });
    expect(results[0].raw).toMatchObject({ durationSeconds: 10869, videoKind: "compilation" });
    expect(results[0].raw?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("合集")]));
  });
});
