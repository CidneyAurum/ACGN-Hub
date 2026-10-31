import { describe, expect, it, vi } from "vitest";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { KUNGalgameSourceProvider } from "@/infrastructure/sources/kungal-source-provider";
import { loadSourceItemResources, searchSourceCandidates } from "@/application/resource-discovery";
import type { SourceConfig } from "@/domain/source";
function json(status: number, body: unknown) { return { status, json: async () => body }; }
const work = { object: "work", id: "86", display_name: "クラナド", localized: { en: { value: "CLANNAD", is_machine: false }, "zh-Hans": { value: "CLANNAD | 克兰纳德", is_machine: false } }, cover: { url: "https://image.example/86.webp" }, is_nsfw: false, release_date: "2004-04-28" };
const card = { object: "galgame_resource", id: "64056", work: { id: "86" }, resource_type: "game", resource_languages: ["zh-cn"], resource_platforms: ["win"], resource_runtimes: ["native-win"], title: "", size: "4.8 GB", provider_names: ["夸克网盘"], state: "valid", updated_at: "2026-10-29T05:43:47Z" };

describe("KUN Galgame public v1 catalog", () => {
  it("retains a localized-name match through application ranking even when the displayed title is different", async () => {
    const translated = { ...work, display_name: "リトルバスターズ！", localized: {
      en: { value: "Little Busters!" }, ja: { value: "リトルバスターズ！" }, "zh-Hans": { value: "小小克星！" },
    } };
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, { object: "list", items: [translated] }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const source: SourceConfig = { id: "kun", type: "kungal", name: "鲲", url: "https://www.kungal.com", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    for (const keyword of ["Little Busters!", "リトルバスターズ！", "小小克星！"]) {
      const result = await searchSourceCandidates({ keyword, mediaType: "visual_novel", sources: [source] }, () => provider);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ score: 100, candidate: { title: "小小克星！", aliases: expect.arrayContaining(["Little Busters!", "リトルバスターズ！"]) } });
    }
  });
  it("searches localized names anonymously and exposes original pages without requesting download links or counters", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, { object: "list", items: [work, { ...work, id: "99", display_name: "Another Game", localized: {} }] }))
      .mockResolvedValueOnce(json(200, { object: "list", items: [card, { ...card, id: "64057", state: "expired" }, { ...card, id: "64058", work: { id: "99" } }] }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const matches = await provider.search({ keyword: "CLANNAD", aliases: [], mediaType: "visual_novel" });
    expect(matches).toHaveLength(1); expect(matches[0]).toMatchObject({ sourceItemId: "86", title: "CLANNAD | 克兰纳德", coverUrl: "https://image.example/86.webp", releaseYear: 2004 });
    const resources = await provider.listResources("86"); expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ protocol: "http", targetUrl: "https://www.kungal.com/galgame/resource/64056", metadata: { downloadMode: "external_link", resourceLabel: "站外资源索引", kungalResourceId: "64056", size: "4.8 GB", platform: "win" } });
    expect(resources[0].metadata.warnings).toEqual([expect.stringContaining("不会把网页加入文件下载")]);
    expect(resources[0]).toMatchObject({ language: "简体中文", sizeBytes: 5_153_960_755, metadata: {
      resourceTypeLabel: "游戏本体", platformLabels: ["Windows"], runtimeLabels: ["Windows 原生"], sizeLabel: "4.8 GB",
    } });
    expect(resources[0].title).toContain("Windows");
    await expect(provider.resolve(resources[0].id)).resolves.toMatchObject({ url: resources[0].targetUrl });
    const firstUrl = new URL(fetcher.mock.calls[0][0]); expect(firstUrl.pathname).toBe("/api/v1/search/works"); expect(firstUrl.searchParams.get("q")).toBe("CLANNAD"); expect(firstUrl.searchParams.get("include_nsfw")).toBe("false");
    expect(fetcher.mock.calls[1][0]).toBe("https://www.kungal.com/api/v1/works/86/resources?page=1&limit=50");
    for (const [url, init] of fetcher.mock.calls) { expect(init?.method).toBe("GET"); expect(url).not.toMatch(/\/downloads|\/source|\/search\/picker/); expect(init?.headers).not.toHaveProperty("Cookie"); }
  });
  it("matches Japanese and Chinese aliases while excluding unrelated and NSFW works", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, { object: "list", items: [work, { ...work, id: "2", is_nsfw: true }, { ...work, id: "3", display_name: "別の作品", localized: {} }] }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const matches = await provider.search({ keyword: "克兰纳德", aliases: ["クラナド"], mediaType: "visual_novel" });
    expect(matches.map((item) => item.sourceItemId)).toEqual(["86"]); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reports public API failure without falling back to legacy authenticated routes", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(401, { code: 205, message: "用户登录失效" }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    await expect(provider.search({ keyword: "CLANNAD", aliases: [], mediaType: "visual_novel" })).rejects.toThrow("公开目录 HTTP 401"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not query non-Galgame types or blank searches", async () => {
    const fetcher = vi.fn<JsonFetcher>(); const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    await expect(provider.search({ keyword: "作品", aliases: [], mediaType: "anime" })).resolves.toEqual([]);
    await expect(provider.search({ keyword: " ", aliases: [], mediaType: "visual_novel" })).resolves.toEqual([]); expect(fetcher).not.toHaveBeenCalled();
  });
  it("loads an already selected work directly after restart without a broad title search", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, work))
      .mockResolvedValueOnce(json(200, { object: "list", items: [card], total: 1 }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const source: SourceConfig = { id: "kun", type: "kungal", name: "鲲", url: "https://www.kungal.com", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const result = await loadSourceItemResources({ config: source, sourceItemId: "86", title: "旧中文别名" }, () => provider);
    expect(result.resources).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://www.kungal.com/api/v1/works/86", "https://www.kungal.com/api/v1/works/86/resources?page=1&limit=50",
    ]);
  });
  it.each(["86", "https://www.kungal.com/galgame/86"]) ("supports an explicit public work ID or same-source URL: %s", async (keyword) => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, work));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const result = await searchSourceCandidates({ keyword, mediaType: "visual_novel", sources: [{ id: "kun", type: "kungal", name: "鲲", url: "https://www.kungal.com", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" }] }, () => provider);
    expect(result.candidates[0]).toMatchObject({ score: 100, candidate: { sourceItemId: "86" } });
    expect(fetcher.mock.calls[0][0]).toBe("https://www.kungal.com/api/v1/works/86");
  });
  it("keeps NSFW works excluded when loading a known ID and rejects malformed IDs before networking", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, { ...work, is_nsfw: true }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    await expect(provider.listResources("../../86")).rejects.toThrow("作品 ID 无效");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(provider.search({ keyword: "86", aliases: [], mediaType: "visual_novel" })).resolves.toEqual([]);
    await expect(provider.listResources("86")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reads subsequent resource pages and filters invalid or foreign cards without losing later valid entries", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ ...card, id: String(index + 1), state: index === 0 ? "expired" : "valid" }));
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, work))
      .mockResolvedValueOnce(json(200, { object: "list", items: firstPage, total: 52 }))
      .mockResolvedValueOnce(json(200, { object: "list", items: [{ ...card, id: "51" }, { ...card, id: "52", work: { id: "99" } }], total: 52 }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const resources = await provider.listResources("86");
    expect(resources).toHaveLength(50);
    expect(resources.at(-1)?.id).toBe(`${provider.id}:v1:51`);
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe("https://www.kungal.com/api/v1/works/86/resources?page=2&limit=50");
    expect(resources[0].metadata.catalogTruncated).toBeUndefined();
  });
  it("bounds oversized catalogs and labels incomplete results", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockImplementation(async (url) => {
      const page = new URL(url).searchParams.get("page");
      return page ? json(200, { object: "list", total: 10_000, items: Array.from({ length: 50 }, (_, index) => ({ ...card, id: String((Number(page) - 1) * 50 + index + 1) })) }) : json(200, work);
    });
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const resources = await provider.listResources("86");
    expect(resources).toHaveLength(500);
    expect(fetcher).toHaveBeenCalledTimes(11);
    expect(resources[0].metadata).toMatchObject({ catalogTruncated: true, warnings: expect.arrayContaining([expect.stringContaining("前 500 条")]) });
    expect(fetcher.mock.calls.every(([url, init]) => !url.includes("/downloads") && init?.method === "GET")).toBe(true);
  });
  it("stops when a server repeats a full resource page instead of advancing", async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ ...card, id: String(index + 1) }));
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, work))
      .mockResolvedValue(json(200, { object: "list", items }));
    const resources = await new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher }).listResources("86");
    expect(resources).toHaveLength(50);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(resources[0].metadata.catalogTruncated).toBe(true);
  });
  it("does not interpret unknown size strings or invent a downloadable file format", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, work))
      .mockResolvedValueOnce(json(200, { object: "list", items: [{ ...card, size: "多种版本", resource_platforms: ["android"], resource_runtimes: ["emulator"] }] }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const resources = await provider.listResources("86");
    expect(resources[0].sizeBytes).toBeUndefined();
    expect(resources[0].format).toBeUndefined();
    expect(resources[0].metadata).toMatchObject({ sizeLabel: "多种版本", platformLabels: ["Android"], runtimeLabels: ["模拟器"] });
  });
  it("labels the observed Android platform and mobile runtimes while matching both 安卓 and original runtime codes", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, work))
      .mockResolvedValueOnce(json(200, { object: "list", items: [{ ...card, resource_platforms: ["and"], resource_runtimes: ["native-and", "kirikiroid2", "tyranor"] },
        { ...card, id: "64057", resource_platforms: ["android"], resource_runtimes: ["native-android"] }] }));
    const resources = await new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher }).listResources("86");
    expect(resources[0].metadata).toMatchObject({ platform: "and", platformLabels: ["Android"], runtimeLabels: ["Android 原生", "吉里吉里2", "Tyranor"] });
    expect(resources[0].metadata.searchTerms).toEqual(expect.stringContaining("安卓"));
    expect(resources[0].metadata.searchTerms).toEqual(expect.stringContaining("kirikiroid2"));
    expect(resources[1].metadata.searchTerms).toEqual(expect.stringContaining("安卓"));
  });
});
