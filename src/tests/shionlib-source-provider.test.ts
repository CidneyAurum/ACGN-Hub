import { describe, expect, it, vi } from "vitest";
import { resourceDedupeKey } from "@/domain/resource";
import { emptyGalgameResourceFilters, galgameResourceFacets, matchesGalgameResource } from "@/domain/galgame-resource";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { ShionlibSourceProvider } from "@/infrastructure/sources/shionlib-source-provider";
import { rankSourceCandidates } from "@/infrastructure/sources/source-matching";

function json(status: number, data: unknown) { return { status, json: async () => data }; }
function ok(data: unknown) { return json(200, { code: 0, message: "", data }); }
const hash = "1".repeat(64);
const game = {
  id: 37, title_jp: "ATRI -My Dear Moments-", title_zh: "亚托莉 -我挚爱的时光-", title_en: "",
  aliases: ["亚托莉"], release_date: "2020-06-19T00:00:00.000Z",
  covers: [{ url: "https://images.yurari.moe/atri.webp", masked: false, sexual: 0, violence: 0 }],
};
const file = {
  id: 2552, file_name: "ATRI steam版.rar", file_size: 3_928_959_761,
  file_status: 3, stage: "stored", hash_algorithm: "blake3", file_hash: "a".repeat(64), sha256: hash,
  is_virus_false_positive: false, malware_scan_cases: [],
  s3_file_key: "not-a-download-url", file_url: "https://untrusted.example/payload.exe",
};
const resource = {
  id: 2561, platform: ["win"], language: ["zh", "en", "jp"], translation: "official", translators: [],
  edition: "steam", edition_name: null, form: "portable", patch_version: null, simulator: null,
  published_at: "2025-12-21T11:54:32.396Z", updated: "2026-01-03T07:53:13.090Z", files: [file], missing_volumes: [],
};
function catalog(items: unknown[]) { return ok({ games: { items, total: items.length } }); }

describe("Shionlib public resource catalog", () => {
  it("uses the anonymous catalog, retains translated aliases, and removes unrelated fuzzy results", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(catalog([game, { ...game, id: 20, title_jp: "Unrelated", title_zh: "其他作品", aliases: [] }]));
    const provider = new ShionlibSourceProvider(undefined, { fetcher });
    const found = await provider.search({ keyword: "ATRI", aliases: [], mediaType: "visual_novel" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sourceId: "shionlib", sourceItemId: "37", title: "亚托莉 -我挚爱的时光-", releaseYear: 2020,
      aliases: expect.arrayContaining(["ATRI -My Dear Moments-", "亚托莉"]), coverUrl: "https://images.yurari.moe/atri.webp" });
    const endpoint = new URL(fetcher.mock.calls[0][0]);
    expect(endpoint.origin).toBe("https://shionlib.com");
    expect(endpoint.pathname).toBe("/api/search");
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({ q: "ATRI", page: "1", pageSize: "24", resources: "required" });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "omit", headers: { Accept: "application/json" } });
    expect(rankSourceCandidates(found, "ATRI")[0].score).toBeGreaterThan(0);
  });

  it("supports VNDB exact-ID search without discarding the trusted ID match in shared ranking", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(catalog([game]));
    const provider = new ShionlibSourceProvider(undefined, { fetcher });
    const found = await provider.search({ keyword: "vid:v27448", aliases: ["ATRI"], mediaType: "visual_novel" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get("q")).toBe("vid:v27448");
    expect(rankSourceCandidates(found, "vid:v27448")[0]).toMatchObject({ score: 100, candidate: { sourceItemId: "37" } });
  });

  it("shows actual files, translated metadata, size and source SHA without issuing a download link", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(catalog([game])).mockResolvedValueOnce(ok([resource]));
    const provider = new ShionlibSourceProvider(undefined, { fetcher });
    await provider.search({ keyword: "ATRI", aliases: [], mediaType: "visual_novel" });
    const items = await provider.listResources("37");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceItemId: "37", protocol: "http", targetUrl: "https://shionlib.com/zh/resource/2561", sizeBytes: 3_928_959_761,
      language: "简体中文 / 英文 / 日文", metadata: { downloadMode: "external_link", actionLabel: "前往下载",
        platformLabels: ["Windows"], translationLabel: "官方中文", editionLabel: "Steam 版", formLabel: "免安装",
        fileCount: 1, sourceSha256: hash, hashVerified: false, requiresSourceVerification: true,
        files: [{ id: "2552", fileName: "ATRI steam版.rar", sizeBytes: 3_928_959_761, sha256: hash, hashVerified: false }],
      },
    });
    expect(items[0].metadata.warnings).toEqual([expect.stringContaining("Cap 人机验证")]);
    expect(JSON.stringify(items[0])).not.toContain("untrusted.example");
    expect(JSON.stringify(items[0])).not.toContain("s3_file_key");
    await expect(provider.resolve(items[0].id)).resolves.toEqual({ protocol: "http", url: items[0].targetUrl });
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).not.toMatch(/\/link|\/open\/|\/downloads|\?token=/);
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(init?.headers).not.toHaveProperty("Cookie");
      expect(init?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("retains separate translation editions with distinct resource-page identities", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(ok(game)).mockResolvedValueOnce(ok([
      { ...resource, translation: "group", translators: [{ name: "夏日纯臻汉化组" }], id: 2447 },
      { ...resource, translation: "group", translators: [{ name: "枫笛汉化组" }], id: 2448 },
    ]));
    const items = await new ShionlibSourceProvider(undefined, { fetcher }).listResources("1800");
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain("夏日纯臻汉化组");
    expect(items[1].title).toContain("枫笛汉化组");
    expect(new Set(items.map(resourceDedupeKey)).size).toBe(2);
    expect(items.map((item) => item.targetUrl)).toEqual(["https://shionlib.com/zh/resource/2447", "https://shionlib.com/zh/resource/2448"]);
  });

  it("reloads a selected game ID from details and resources without another title search", async () => {
    const { id: _id, ...detailWithoutId } = game;
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(ok(detailWithoutId)).mockResolvedValueOnce(ok([resource]));
    const items = await new ShionlibSourceProvider(undefined, { fetcher }).listResources("37");
    expect(items[0].sourceItemId).toBe("37");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://shionlib.com/api/game/37", "https://shionlib.com/api/game/37/download-source",
    ]);
  });

  it.each(["37", "https://shionlib.com/game/37", "https://shionlib.com/zh/game/37"])("supports a source ID or source game URL: %s", async (keyword) => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(ok(game));
    const found = await new ShionlibSourceProvider(undefined, { fetcher }).search({ keyword, aliases: [], mediaType: "visual_novel" });
    expect(found[0].sourceItemId).toBe("37");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://shionlib.com/api/game/37"]);
  });

  it("preserves every volume in source order, sums their actual sizes, and does not invent a combined SHA", async () => {
    const files = [
      { ...file, id: 1, file_name: "game.7z.001", file_size: 500, sha256: null, hash_algorithm: "sha256", file_hash: hash },
      { ...file, id: 2, file_name: "game.7z.002", file_size: 100, sha256: "invalid", file_hash: "invalid" },
    ];
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(ok(game)).mockResolvedValueOnce(ok([{ ...resource, files }]));
    const [item] = await new ShionlibSourceProvider(undefined, { fetcher }).listResources("37");
    expect(item.sizeBytes).toBe(600);
    expect(item.metadata).toMatchObject({ fileCount: 2, fileNames: ["game.7z.001", "game.7z.002"], hashVerified: false,
      files: [{ id: "1", sha256: hash }, { id: "2" }] });
    expect(item.metadata.sourceSha256).toBeUndefined();
    expect((item.metadata.files as Record<string, unknown>[])[1]).not.toHaveProperty("sha256");
    expect((item.metadata.files as Record<string, unknown>[])[1]).not.toHaveProperty("fileHash");
  });

  it("filters unpublished or blocked files and warns when the remaining volume set is incomplete", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(ok(game)).mockResolvedValueOnce(ok([
      { ...resource, id: 1, published_at: null },
      { ...resource, id: 2, files: [{ ...file, stage: "rejected" }] },
      { ...resource, id: 3, missing_volumes: ["game.7z.003"], files: [file, { ...file, id: 12, stage: "under_review" }] },
      { ...resource, id: 4, files: [] },
    ]));
    const items = await new ShionlibSourceProvider(undefined, { fetcher }).listResources("37");
    expect(items).toHaveLength(1);
    expect(items[0].metadata).toMatchObject({ shionlibResourceId: "3", fileCount: 1, missingVolumes: ["game.7z.003"] });
    expect(items[0].metadata.warnings).toEqual(expect.arrayContaining([expect.stringContaining("尚未就绪或缺少")]));
  });

  it("preserves the source's existing scan detections and never describes them as locally verified safe", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(ok(game)).mockResolvedValueOnce(ok([{ ...resource,
      files: [{ ...file, is_virus_false_positive: true, malware_scan_cases: [{ detected_viruses: ["Example.Detection (game.dll)"] }] }],
    }]));
    const [item] = await new ShionlibSourceProvider(undefined, { fetcher }).listResources("37");
    expect(item.metadata.files).toMatchObject([{ sourceScanFlag: true, scanDetections: ["Example.Detection (game.dll)"] }]);
    expect(item.metadata.warnings).toEqual(expect.arrayContaining([expect.stringContaining("不代表本软件已经确认文件安全")]));
  });

  it("does not mislabel an official English-only translation as Chinese", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(ok(game)).mockResolvedValueOnce(ok([{ ...resource, language: ["en"] }]));
    const [item] = await new ShionlibSourceProvider(undefined, { fetcher }).listResources("37");
    expect(item.metadata.translationLabel).toBe("官方翻译");
    expect(item.title).not.toContain("官方中文");
    expect(item.language).toBe("英文");
  });

  it.each([
    [["Game Demo.zip"], "trial", false],
    [["Game_Trial.7z"], "trial", false],
    [["Game（体験版）.zip"], "trial", false],
    [["Game OST.zip"], "ost", false],
    [["Game Soundtrack.flac"], "ost", false],
    [["Game Artbook.zip"], "artbook", false],
    [["Game 设定集.pdf"], "artbook", false],
    [["Game Savedata.7z"], "save", false],
    [["Game Save.zip"], "save", false],
    [["Game 全CG存档.zip"], "save", false],
    [["Game Patch.zip", "README.txt"], "patch", false],
    [["Game 汉化补丁.7z", "说明.pdf"], "patch", false],
    [["Game Patch.zip", "Game.zip"], "unknown", false],
    [["Game.zip", "Game OST.zip"], "unknown", false],
    [["Game + OST.zip"], "unknown", false],
    [["Game (with Artbook).zip"], "unknown", false],
    [["Game（含原声）.zip"], "unknown", false],
    [["Game Demo Patch.zip"], "unknown", false],
    [["README.txt"], "unknown", false],
    [["Game.zip", "README.txt"], "game", true],
    [["Game.7z.001", "Game.7z.002"], "game", true],
    [["77 ～And,two stars meet again(已打修正补丁,H未汉).7z"], "game", true],
    [["Game（内置汉化补丁）.zip"], "game", true],
    [["Game 附补丁.zip"], "game", true],
    [["Game Pre-patched.zip"], "game", true],
    [["Save the Date.zip"], "game", true],
  ])("the Chinese Windows game filter classifies %j as %s", async (fileNames, expected, keepAsGame) => {
    const files = fileNames.map((fileName, index) => ({ ...file, id: index + 1, file_name: fileName }));
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(ok(game)).mockResolvedValueOnce(ok([{ ...resource, files }]));
    const [item] = await new ShionlibSourceProvider(undefined, { fetcher }).listResources("37");
    expect(item.metadata.resourceType).toBe(expected);
    expect(item.metadata.fileCount).toBe(fileNames.length);
    expect(matchesGalgameResource(item, { ...emptyGalgameResourceFilters(), chinese: true, windows: true, game: true })).toBe(keepAsGame);
    if (expected === "trial") expect(galgameResourceFacets(item).content).toBe("trial");
    if (expected === "patch") expect(galgameResourceFacets(item).content).toBe("patch");
    if (keepAsGame) expect(item.metadata.warnings).not.toEqual(expect.arrayContaining([expect.stringContaining("需要对应版本的游戏本体")]));
  });

  it("handles null optional arrays and excludes masked or rated cover art", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(catalog([{ ...game, aliases: null,
      covers: [{ url: "https://images.yurari.moe/masked.webp", masked: true }, { url: "https://images.yurari.moe/rated.webp", sexual: 2 }],
    }]));
    const found = await new ShionlibSourceProvider(undefined, { fetcher }).search({ keyword: "ATRI", aliases: [], mediaType: "visual_novel" });
    expect(found[0].coverUrl).toBeUndefined();
  });

  it("continues when an alias request fails but another succeeds", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockImplementation(async (url) => new URL(url).searchParams.get("q") === "ATRI"
      ? json(503, {}) : catalog([game]));
    const found = await new ShionlibSourceProvider(undefined, { fetcher }).search({ keyword: "ATRI", aliases: ["亚托莉"], mediaType: "visual_novel" });
    expect(found).toHaveLength(1);
  });

  it.each([
    [json(429, {}), "请求过于频繁"],
    [json(403, {}), "HTTP 403"],
    [json(200, { code: 680101, data: null }), "错误码 680101"],
    [json(200, { code: 0, data: { items: [] } }), "作品目录格式发生变化"],
    [json(200, "challenge HTML"), "公开接口响应格式发生变化"],
  ])("reports an unavailable or changed catalog honestly", async (response, message) => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(response);
    await expect(new ShionlibSourceProvider(undefined, { fetcher }).search({ keyword: "ATRI", aliases: [], mediaType: "visual_novel" })).rejects.toThrow(String(message));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed source IDs, invalid endpoints and invalid pages before networking", async () => {
    const fetcher = vi.fn<JsonFetcher>();
    const provider = new ShionlibSourceProvider(undefined, { fetcher });
    for (const id of ["../37", "0", "37?token=x", "1e3", "9007199254740992"]) await expect(provider.listResources(id)).rejects.toThrow("作品 ID 无效");
    for (const page of [0, -1, 201, 1.5, NaN]) await expect(provider.search({ keyword: "ATRI", aliases: [], mediaType: "visual_novel", page })).rejects.toThrow("页码无效");
    for (const url of ["http://shionlib.com", "https://fake.example", "https://user:pass@shionlib.com", "https://shionlib.com/api", "https://shionlib.com?key=x"]) {
      expect(() => new ShionlibSourceProvider(url, { fetcher })).toThrow("必须使用官方");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does no work for other media or empty searches and rejects expired resource handles", async () => {
    const fetcher = vi.fn<JsonFetcher>();
    const provider = new ShionlibSourceProvider(undefined, { fetcher });
    await expect(provider.search({ keyword: "ATRI", aliases: [], mediaType: "anime" })).resolves.toEqual([]);
    await expect(provider.search({ keyword: " ", aliases: [], mediaType: "visual_novel" })).resolves.toEqual([]);
    await expect(provider.resolve("unknown")).rejects.toThrow("已过期");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
