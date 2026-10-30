import { describe, expect, it, vi } from "vitest";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { KUNGalgameSourceProvider } from "@/infrastructure/sources/kungal-source-provider";
function json(status: number, body: unknown) { return { status, json: async () => body }; }
const work = { object: "work", id: "86", display_name: "クラナド", localized: { en: { value: "CLANNAD", is_machine: false }, "zh-Hans": { value: "CLANNAD | 克兰纳德", is_machine: false } }, cover: { url: "https://image.example/86.webp" }, is_nsfw: false, release_date: "2004-04-28" };
const card = { object: "galgame_resource", id: "64056", work: { id: "86" }, resource_type: "game", resource_languages: ["zh-cn"], resource_platforms: ["win"], resource_runtimes: ["native-win"], title: "", size: "4.8 GB", provider_names: ["夸克网盘"], state: "valid", updated_at: "2026-10-29T05:43:47Z" };

describe("KUN Galgame public v1 catalog", () => {
  it("searches localized names anonymously and exposes original pages without requesting download links or counters", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, { object: "list", items: [work, { ...work, id: "99", display_name: "Another Game", localized: {} }] }))
      .mockResolvedValueOnce(json(200, { object: "list", items: [card, { ...card, id: "64057", state: "expired" }, { ...card, id: "64058", work: { id: "99" } }] }));
    const provider = new KUNGalgameSourceProvider("https://www.kungal.com", { fetcher });
    const matches = await provider.search({ keyword: "CLANNAD", aliases: [], mediaType: "visual_novel" });
    expect(matches).toHaveLength(1); expect(matches[0]).toMatchObject({ sourceItemId: "86", title: "CLANNAD | 克兰纳德", coverUrl: "https://image.example/86.webp", releaseYear: 2004 });
    const resources = await provider.listResources("86"); expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ protocol: "http", targetUrl: "https://www.kungal.com/galgame/resource/64056", metadata: { downloadMode: "external_link", resourceLabel: "站外资源索引", kungalResourceId: "64056", size: "4.8 GB", platform: "win" } });
    expect(resources[0].metadata.warnings).toEqual([expect.stringContaining("不会把网页加入文件下载")]);
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
});
