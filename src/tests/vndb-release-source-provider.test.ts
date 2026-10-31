import { describe, expect, it, vi } from "vitest";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";
import { VndbReleaseSourceProvider } from "@/infrastructure/sources/vndb-release-source-provider";

function json(status: number, body: unknown) { return { status, json: async () => body }; }
const game = { id: "v20424", title: "Summer Pockets", alttitle: "サマーポケッツ", aliases: ["サマポケ"],
  titles: [{ title: "夏日口袋", lang: "zh-Hans" }, { title: "Summer Pockets", lang: "en", latin: null }],
  released: "2018-06-29", image: { url: "https://example.com/cover.jpg" } };
const release = { id: "r71942", title: "Summer Pockets", alttitle: null, languages: [{ lang: "en" }, { lang: "zh-Hans" }],
  platforms: ["win"], freeware: false, patch: false, official: true, released: "2020-02-06",
  vns: [{ id: "v20424", rtype: "complete" }],
  extlinks: [{ url: "https://store.steampowered.com/app/897220/", label: "Steam", name: "steam" },
    { url: "https://steamdb.info/app/897220/info/", label: "SteamDB", name: "steamdb" }] };
function provider(fetcher: JsonFetcher, options: ConstructorParameters<typeof VndbReleaseSourceProvider>[0] = {}) {
  return new VndbReleaseSourceProvider({ fetcher, minIntervalMs: 0, ...options });
}
const query = { keyword: "夏日口袋", aliases: [], mediaType: "visual_novel" as const };

describe("VNDB official distribution and trial source", () => {
  it("searches official aliases and emits real store pages as external links, never files", async () => {
    const fetcher = vi.fn<JsonFetcher>()
      .mockResolvedValueOnce(json(200, { results: [game], more: false }))
      .mockResolvedValueOnce(json(200, { results: [release], more: false }));
    const source = provider(fetcher);
    await expect(source.search(query)).resolves.toMatchObject([{ sourceId: "vndb-release", sourceItemId: "v20424", title: "夏日口袋", releaseYear: 2018,
      raw: { aliases: ["Summer Pockets", "サマーポケッツ", "サマポケ", "夏日口袋"], sourceUrl: "https://vndb.org/v20424" } }]);
    const resources = await source.listResources("v20424");
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ targetUrl: "https://store.steampowered.com/app/897220/", protocol: "http", language: "en / zh-Hans",
      metadata: { downloadMode: "external_link", releaseType: "complete", freeware: false, official: true, patch: false,
        platform: "win", platformLabels: ["Windows"], languageLabels: ["英语", "简体中文"], resourceTypeLabel: "完整发行版",
        releasePage: "https://vndb.org/r71942", actionLabel: "前往商店", searchTerms: expect.arrayContaining(["中文", "简体中文", "Windows"]), warnings: [expect.stringContaining("不会将网页加入文件下载")] } });
    await expect(source.resolve(resources[0].id)).resolves.toEqual({ protocol: "http", url: resources[0].targetUrl });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.vndb.org/kana/vn");
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({ filters: ["search", "=", "夏日口袋"], results: 12 });
    expect(fetcher.mock.calls[1][0]).toBe("https://api.vndb.org/kana/release");
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toMatchObject({ filters: ["and", ["vn", "=", ["id", "=", "v20424"]], ["official", "=", true]], results: 100 });
    for (const [, init] of fetcher.mock.calls) { expect(init.method).toBe("POST"); expect(init.headers).not.toHaveProperty("Cookie"); expect(init.headers).not.toHaveProperty("Authorization"); expect(init.signal).toBeInstanceOf(AbortSignal); }
  });

  it("preserves trial/partial/patch distinctions and ranks Chinese, free and playable editions", async () => {
    const editions = [
      { ...release, id: "r1", extlinks: [{ url: "https://key.visualarts.gr.jp/paid/", name: "website", label: "Official website" }] },
      { ...release, id: "r2", languages: [{ lang: "ja" }], freeware: true, vns: [{ id: "v20424", rtype: "trial" }], extlinks: [{ url: "https://key.visualarts.gr.jp/summer/download.html", name: "website", label: "Official website" }] },
      { ...release, id: "r3", freeware: true, patch: true, extlinks: [{ url: "https://key.visualarts.gr.jp/patch/", name: "website", label: "Official website" }] },
      { ...release, id: "r4", freeware: true, vns: [{ id: "v20424", rtype: "partial" }], extlinks: [{ url: "https://key.visualarts.gr.jp/partial/", name: "website", label: "Official website" }] },
    ];
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, { results: [game] })).mockResolvedValueOnce(json(200, { results: editions }));
    const source = provider(fetcher); await source.search(query); const resources = await source.listResources("v20424");
    expect(resources.map((resource) => resource.metadata.vndbReleaseId)).toEqual(["r1", "r4", "r3", "r2"]);
    expect(resources.find((resource) => resource.metadata.vndbReleaseId === "r2")).toMatchObject({
      title: expect.stringContaining("试玩版"), metadata: { resourceLabel: "试玩版 · 免费发行", warnings: expect.arrayContaining(["试玩版只包含体验内容，不是完整游戏。"]) },
    });
    expect(resources.find((resource) => resource.metadata.vndbReleaseId === "r3")).toMatchObject({ title: expect.stringContaining("补丁（需游戏本体）") });
    expect(resources.find((resource) => resource.metadata.vndbReleaseId === "r4")).toMatchObject({ title: expect.stringContaining("部分内容"), metadata: { warnings: expect.arrayContaining(["此发行版本只包含部分内容。"]) } });
  });

  it("filters unrelated and non-official releases even if the endpoint returns them", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, { results: [game] })).mockResolvedValueOnce(json(200, { results: [
      { ...release, official: false }, { ...release, vns: [{ id: "v4", rtype: "complete" }] },
    ] }));
    const source = provider(fetcher); await source.search(query); await expect(source.listResources("v20424")).resolves.toEqual([]);
  });

  it("loads a persisted VNDB work ID after restart without requiring a search cache", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, { results: [release] }));
    const source = provider(fetcher); await expect(source.listResources("v20424")).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe("https://api.vndb.org/kana/release");
  });

  it.each(["v20424", "https://vndb.org/v20424", "https://vndb.org/v20424/"])("looks up a canonical VNDB identity directly: %s", async (keyword) => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, { results: [game, { ...game, id: "v4" }] }));
    const source = provider(fetcher);
    const found = await source.search({ ...query, keyword, aliases: ["Other"] });
    expect(found.map((item) => item.sourceItemId)).toEqual(["v20424"]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({ filters: ["id", "=", "v20424"], fields: expect.any(String), results: 1, page: 1 });
    await expect(source.search({ ...query, keyword, page: 2 })).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects tracking/wiki/archive/forum/share URLs and mismatched store hosts without losing valid links", async () => {
    const urls = [
      { url: "https://evil.example/store/", name: "steam", label: "Steam" },
      { url: "https://store.steampowered.com.evil.example/app/1/", name: "steam", label: "Steam" },
      { url: "https://user:password@key.visualarts.gr.jp/", name: "website", label: "Official website" },
      { url: "http://127.0.0.1/private", name: "website", label: "Official website" },
      { url: "http://[::1]/private", name: "website", label: "Official website" },
      { url: "http://localhost/private", name: "website", label: "Official website" },
      { url: "https://key.visualarts.gr.jp:444/private", name: "website", label: "Official website" },
      { url: "javascript:alert(1)", name: "website", label: "Official website" },
      { url: "https://web.archive.org/web/123/http://key.visualarts.gr.jp/", name: "website", label: "Official website" },
      { url: "https://en.wikipedia.org/wiki/Summer_Pockets", name: "website", label: "Official website" },
      { url: "https://m.apkpure.net/app/foo", name: "website", label: "Official website" },
      { url: "https://game.example/bbs/showtopic-1.aspx", name: "website", label: "Official website" },
      { url: "https://pan.baidu.com/s/1234", name: "website", label: "Official website" },
      { url: "https://game.example/wiki/abc", name: "website", label: "Official website" },
      { url: "https://steamdb.info/app/1/", name: "steamdb", label: "SteamDB" },
      { url: "http://key.visualarts.gr.jp/summer/download.html#download", name: "website", label: "Official website" },
      { notAValidLink: true }, null,
    ];
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, { results: [game] })).mockResolvedValueOnce(json(200, { results: [{ ...release, extlinks: urls }] }));
    const source = provider(fetcher); await source.search(query); const resources = await source.listResources("v20424");
    expect(resources).toHaveLength(1); expect(resources[0].targetUrl).toBe("http://key.visualarts.gr.jp/summer/download.html");
  });

  it("deduplicates within each release while preserving shared pages across editions and bounding pagination", async () => {
    const paid = { ...release, id: "r100", extlinks: [release.extlinks[0], { ...release.extlinks[0], url: `${release.extlinks[0].url}#download` }] };
    const preferred = { ...paid, id: "r101", freeware: true };
    const many = Array.from({ length: 50 }, (_, index) => ({ ...paid, id: `r${index + 200}`, extlinks: [{ name: "website", label: "Official website", url: `https://game.example/release/${index}/` }] }));
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, { results: [game] }))
      .mockResolvedValueOnce(json(200, { results: [paid, preferred], more: true }))
      .mockResolvedValueOnce(json(200, { results: many, more: true }));
    const source = provider(fetcher); await source.search(query); const resources = await source.listResources("v20424");
    expect(resources).toHaveLength(40); expect(resources[0].metadata.vndbReleaseId).toBe("r101");
    expect(resources.every((resource) => resource.metadata.truncated === true)).toBe(true);
    expect(resources[0].metadata.warnings).toContain("发行目录较多，本次只检查最新 200 条发行记录；更早版本请在 VNDB 查看。");
    expect(resources.filter((resource) => resource.targetUrl === paid.extlinks[0].url)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(JSON.parse(String(fetcher.mock.calls[2][1].body)).page).toBe(2);
  });

  it.each([
    ["trial and complete", { freeware: true, vns: [{ id: "v20424", rtype: "trial" }] }, { vns: [{ id: "v20424", rtype: "complete" }] }, "releaseType", "trial", "complete"],
    ["Chinese and English", { languages: [{ lang: "zh-Hans" }] }, { languages: [{ lang: "en" }] }, "language", "zh-Hans", "en"],
    ["Windows and Switch", { platforms: ["win"] }, { platforms: ["swi"] }, "platform", "win", "swi"],
  ])("retains %s releases sharing the exact same official page", async (_name, first, second, field, firstValue, secondValue) => {
    const extlinks = [{ name: "website", label: "Official website", url: "https://game.example/game/" }];
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, { results: [
      { ...release, id: "r100", ...first, extlinks }, { ...release, id: "r101", ...second, extlinks },
    ] }));
    const source = provider(fetcher); const resources = await source.listResources("v20424");
    expect(resources).toHaveLength(2); expect(new Set(resources.map((resource) => resource.id)).size).toBe(2);
    expect(resources.map((resource) => resource.targetUrl)).toEqual([extlinks[0].url, extlinks[0].url]);
    expect(resources.find((resource) => resource.metadata.vndbReleaseId === "r100")!.metadata[String(field)]).toBe(firstValue);
    expect(resources.find((resource) => resource.metadata.vndbReleaseId === "r101")!.metadata[String(field)]).toBe(secondValue);
    for (const resource of resources) await expect(source.resolve(resource.id)).resolves.toEqual({ protocol: "http", url: extlinks[0].url });
  });

  it.each([[40, false], [41, true]])("reports the 40-result limit only when %s unique release links exceed it", async (count, truncated) => {
    const many = Array.from({ length: count }, (_, index) => ({ ...release, id: `r${index + 200}`, extlinks: [release.extlinks[0]] }));
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, { results: many, more: false }));
    const resources = await provider(fetcher).listResources("v20424");
    expect(resources).toHaveLength(40);
    expect(resources.every((resource) => resource.metadata.catalogTruncated === false && resource.metadata.resultTruncated === truncated && resource.metadata.truncated === truncated)).toBe(true);
    if (truncated) expect(resources[0].metadata.warnings).toContain("发行入口较多，本次仅展示优先的 40 个入口；其余版本请在 VNDB 查看。");
    else expect(resources[0].metadata.warnings).toHaveLength(1);
  });

  it("recovers matches from a working alias when another search fails and bounds aliases", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(503, {})).mockResolvedValue(json(200, { results: [game] }));
    const source = provider(fetcher); await expect(source.search({ ...query, aliases: ["夏日口袋", "Summer Pockets", "サマーポケッツ", "サマポケ"] })).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    [429, {}, "请求过于频繁"], [503, {}, "HTTP 503"], [200, { results: "bad" }, "作品目录格式发生变化"],
  ])("reports actionable failures for HTTP/schema %s", async (status, body, message) => {
    const source = provider(vi.fn<JsonFetcher>().mockResolvedValue(json(status as number, body)));
    await expect(source.search(query)).rejects.toThrow(message as string);
  });

  it("reports malformed release schema and does not fabricate a download", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValueOnce(json(200, { results: [game] })).mockResolvedValueOnce(json(200, { results: [{ ...release, vns: [{ id: "v20424", rtype: "unknown" }] }] }));
    const source = provider(fetcher); await source.search(query);
    await expect(source.listResources("v20424")).rejects.toThrow("发行目录格式发生变化");
    await expect(source.resolve("vndb-release:r71942")).rejects.toThrow("入口已过期");
  });

  it("honors cancellation before networking and during an unresolved request", async () => {
    const cancelled = new AbortController(); cancelled.abort(new DOMException("cancelled", "AbortError"));
    const never = vi.fn<JsonFetcher>(() => new Promise(() => undefined)); const source = provider(never);
    await expect(source.search(query, cancelled.signal)).rejects.toThrow("cancelled"); expect(never).not.toHaveBeenCalled();
    const active = new AbortController(); const pending = source.search(query, active.signal);
    await vi.waitFor(() => expect(never).toHaveBeenCalledTimes(1)); active.abort(new DOMException("user cancelled", "AbortError"));
    await expect(pending).rejects.toThrow("user cancelled");
  });

  it("stops awaiting an unresponsive fetcher when the timeout expires", async () => {
    vi.useFakeTimers();
    try {
      // Native AbortSignal.timeout uses its own clock, so inject only the timeout signal for this test.
      const timeout = new AbortController(); const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const source = provider(vi.fn<JsonFetcher>(() => new Promise(() => undefined)), { timeoutMs: 500 });
      const rejected = expect(source.search(query)).rejects.toThrow("请求超时");
      await vi.advanceTimersByTimeAsync(1); timeout.abort(new DOMException("timed out", "TimeoutError")); await rejected;
      timeoutSpy.mockRestore();
    } finally { vi.useRealTimers(); }
  });

  it("does not query incompatible/empty input and validates IDs, pages and stale resources", async () => {
    const fetcher = vi.fn<JsonFetcher>(); const source = provider(fetcher);
    await expect(source.search({ ...query, mediaType: "anime" })).resolves.toEqual([]);
    await expect(source.search({ ...query, keyword: " " })).resolves.toEqual([]);
    await expect(source.search({ ...query, page: -1 })).rejects.toThrow("页码无效");
    await expect(source.listResources("../v1")).rejects.toThrow("作品 ID 无效");
    await expect(source.resolve("unknown")).rejects.toThrow("入口已过期"); expect(fetcher).not.toHaveBeenCalled();
    expect(() => provider(fetcher, { apiUrl: "https://api.vndb.org/kana/" })).not.toThrow();
    for (const apiUrl of ["https://mirror.example/kana", "http://api.vndb.org/kana", "https://api.vndb.org/kana?key=secret", "https://user:pass@api.vndb.org/kana"]) {
      expect(() => provider(fetcher, { apiUrl })).toThrow("必须使用官方");
    }
  });

  it("health-checks release fields without mutating searches or pretending to test downloads", async () => {
    const fetcher = vi.fn<JsonFetcher>().mockResolvedValue(json(200, { results: [release] })); const source = provider(fetcher);
    await expect(source.healthCheck()).resolves.toMatchObject({ ok: true, message: expect.stringContaining("具体获取条件以原站为准") });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.vndb.org/kana/release");
    const failed = provider(vi.fn<JsonFetcher>().mockRejectedValue(new Error("network failure")));
    await expect(failed.healthCheck()).resolves.toMatchObject({ ok: false, message: "无法连接 VNDB 发行目录，请检查网络后重试" });
  });
});
