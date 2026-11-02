import { describe, expect, it, vi } from "vitest";
import type { TextFetcher } from "@/application/feed-ports";
import { ItchFreewareSourceProvider } from "@/infrastructure/sources/itch-freeware-source-provider";
import { resourceDedupeKey } from "@/domain/resource";

const PAGE = "https://npckc.itch.io/one-night-hot-springs";
const ITEM = "npckc/one-night-hot-springs";
const ISSUED_KEY = "source-issued%2Banonymous-key%3D%3D.signature%2Fpiece";
const CSRF = "source-issued-csrf-token";
const SIGNED = "https://itchio-mirror.abc123.r2.cloudflarestorage.com/game-file?X-Amz-Signature=temporary-secret";
const query = { keyword: "one night hot springs", aliases: [], mediaType: "visual_novel" as const };
const response = (body: string, status = 200) => ({ status, text: async () => body });

function main(options: { id?: number; slug?: string; minPrice?: number; actualPrice?: number; page?: string; languages?: string[] } = {}) {
  const page = options.page ?? PAGE;
  return `<html><head><meta property="og:image" content="https://img.itch.zone/cover.png"><meta name="csrf_token" value="${CSRF}"></head>
  <body><div class="formatted_description">A complete visual novel, with a free original release.</div><div class="game_info_panel_widget"><table><tr><td>Languages</td><td>${(options.languages ?? ["en", "ja", "zh_Hans", "zh_Hant"]).map((language) => `<a href="https://itch.io/games/lang-${language}">${language}</a>`).join("")}</td></tr></table></div>
  <script>init_ViewGame('#game', ${JSON.stringify({ generate_download_url: `${page}/download_url`, game: { id: options.id ?? 226937, slug: options.slug ?? "one-night-hot-springs", min_price: options.minPrice ?? 0, actual_price: options.actualPrice ?? 0 } })});</script></body></html>`;
}
function purchase(direct = true) { return `<html><head><meta name="csrf_token" value="${CSRF}"></head><body>${direct ? '<a class="direct_download_btn" href="">No thanks, just take me to the downloads</a>' : '<form>Pay at least $5</form>'}</body></html>`; }
function upload(id: string, name: string, icons = ["windows8"], downloadable = true) {
  return `<div class="upload">${downloadable ? `<a class="button download_btn" data-upload_id="${id}" href="javascript:void(0)">Download</a>` : '<span>Payment required</span>'}<div class="info_column"><div class="upload_name"><strong class="name" title="${name}">${name}</strong><span class="file_size"><span>72</span> MB</span>${icons.map((icon) => `<span class="icon icon-${icon}"></span>`).join("")}</div><div>Version 1.55</div></div></div>`;
}
function downloadPage(cards = [upload("2436127", "one-night-hot-springs-win-linux.zip", ["windows8", "tux"]), upload("1868851", "one-night-hot-springs-osx.zip", ["apple"]), upload("13264421", "com.npckc.onsen-1.55-1770985503-release.apk", ["android"])].join("")) {
  return `<html><head><meta name="csrf_token" value="${CSRF}"></head><body>${cards}</body></html>`;
}
function provider(fetcher: TextFetcher, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  return new ItchFreewareSourceProvider(undefined, { fetcher, ...options });
}
function flow(cards?: string, signed = SIGNED) {
  return vi.fn<TextFetcher>()
    .mockResolvedValueOnce(response(main()))
    .mockResolvedValueOnce(response(purchase()))
    .mockResolvedValueOnce(response(JSON.stringify({ url: `${PAGE}/download/${ISSUED_KEY}` })))
    .mockResolvedValueOnce(response(downloadPage(cards)))
    .mockResolvedValueOnce(response(JSON.stringify({ url: signed, external: false })));
}

describe("itch.io audited complete freeware", () => {
  it("searches real title, VNDB identity and canonical author page without inventing a site-wide search", async () => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(response(main()));
    const source = provider(fetcher);
    for (const keyword of [query.keyword, "v22619", ITEM, PAGE]) {
      const matches = await source.search({ ...query, keyword });
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ sourceId: "itch_freeware:https://itch.io", sourceItemId: ITEM, title: "one night, hot springs", coverUrl: "https://img.itch.zone/cover.png", raw: { sourceUrl: PAGE, curatedCatalogue: true, languages: ["en", "ja", "zh-Hans", "zh-Hant"] } });
      expect(JSON.stringify(matches)).not.toContain(CSRF);
    }
    await expect(source.search({ ...query, keyword: "CLANNAD" })).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([url]) => url === PAGE)).toBe(true);
  });

  it("matches the Chinese title/alias of a second author and keeps traditional Chinese accurate", async () => {
    const page = "https://brianna-lei.itch.io/butterfly-soup";
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(response(main({ id: 143899, slug: "butterfly-soup", page, languages: ["en", "zh_Hant"] })));
    const source = provider(fetcher);
    const results = await source.search({ ...query, keyword: "蝴蝶湯" });
    expect(results).toMatchObject([{ title: "蝴蝶汤", sourceItemId: "brianna-lei/butterfly-soup", aliases: expect.arrayContaining(["Butterfly Soup", "蝴蝶湯"]), raw: { languages: ["en", "zh-Hant"] } }]);
    expect(fetcher.mock.calls[0][0]).toBe(page);
  });

  it("uses a working original-title alias without treating an unrelated author as a title match", async () => {
    const source = provider(vi.fn<TextFetcher>().mockResolvedValue(response(main())));
    await expect(source.search({ ...query, keyword: "Some translated label", aliases: ["one night, hot springs"] })).resolves.toHaveLength(1);
    await expect(source.search({ ...query, keyword: "npckc" })).resolves.toEqual([]);
  });

  it("lists free accessible full-game files with separate platforms and stable non-secret identities", async () => {
    const fetcher = flow();
    const resources = await provider(fetcher).listResources(ITEM);
    expect(resources).toHaveLength(3);
    expect(resources[0]).toMatchObject({ id: `itch_freeware:${ITEM}:2436127`, targetUrl: `${PAGE}?acgn_upload=2436127`, format: "ZIP", language: "英文 / 日文 / 简体中文 / 繁体中文",
      metadata: { downloadMode: "direct_file", needsFreshDownloadTarget: true, resourceType: "game", official: true, freeware: true,
        languages: ["en", "ja", "zh-Hans", "zh-Hant"], platforms: ["win", "lin"], size: "72 MB（来源约数）", version: "1.55", sourceUrl: PAGE,
        downloadFileName: "one night, hot springs - 简繁中文 - Windows-Linux - v1.55.zip" } });
    expect(resources[1].metadata.platformLabels).toEqual(["macOS"]);
    expect(resources[2]).toMatchObject({ format: "APK", metadata: { platforms: ["and"], searchTerms: expect.arrayContaining(["安卓"]) } });
    expect(new Set(resources.map(resourceDedupeKey)).size).toBe(3);
    expect(JSON.stringify(resources)).not.toMatch(new RegExp(`${ISSUED_KEY}|${CSRF}|temporary-secret|download_url|/file/`));
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).has("Cookie")).toBe(false);
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    }
    expect(fetcher.mock.calls[2]).toMatchObject([`${PAGE}/download_url`, { method: "POST", body: new URLSearchParams({ csrf_token: CSRF }).toString() }]);
  });

  it("never turns bonus art, goodies, supporter packs, patches or demos into full games", async () => {
    const cards = [
      upload("2436127", "one-night-hot-springs-win-linux.zip"),
      upload("2", "one-night-hot-springs-soundtrack.zip"), upload("3", "one-night-hot-springs-demo.zip"),
      upload("4", "one-night-hot-springs-patch.zip"), upload("5", "art collection.pdf"), upload("6", "goodies.zip"),
      upload("7", "one-night-hot-springs-osx.zip", ["apple"], false),
      upload("8", "one-night-hot-springs-supporter.zip"), upload("9", "unrelated-full-game.zip"),
    ].join("");
    const resources = await provider(flow(cards)).listResources(ITEM);
    expect(resources).toHaveLength(1);
    expect(resources[0].metadata.itchUploadId).toBe("2436127");
  });

  it("preserves valid extension when a second author's upload uses a display label", async () => {
    const page = "https://brianna-lei.itch.io/butterfly-soup";
    const fetcher = vi.fn<TextFetcher>()
      .mockResolvedValueOnce(response(main({ page, id: 143899, slug: "butterfly-soup", languages: ["en", "zh_Hant"] })))
      .mockResolvedValueOnce(response(purchase()))
      .mockResolvedValueOnce(response(JSON.stringify({ url: `${page}/download/${ISSUED_KEY}` })))
      .mockResolvedValueOnce(response(downloadPage(upload("3509369", "Butterfly Soup - PC (v2.20)").replace("Version 1.55", "Version 2.20"))));
    const resources = await provider(fetcher).listResources("brianna-lei/butterfly-soup");
    expect(resources).toMatchObject([{ title: expect.stringContaining("2.20"), format: "ZIP", language: "英文 / 繁体中文", metadata: { downloadFileName: expect.stringMatching(/^蝴蝶汤 - 繁体中文 - Windows.*\.zip$/) } }]);
  });

  it("recreates a cold saved file and asks the ordinary free endpoint for a fresh CDN URL", async () => {
    const fetcher = flow();
    const target = await provider(fetcher).resolve(`itch_freeware:${ITEM}:2436127`);
    expect(target).toEqual({ protocol: "http", url: SIGNED, filename: "one night, hot springs - 简繁中文 - Windows-Linux - v1.55.zip" });
    expect(fetcher.mock.calls[4]).toMatchObject([`${PAGE}/file/2436127`, { method: "POST", body: new URLSearchParams({ csrf_token: CSRF }).toString() }]);
    expect(fetcher.mock.calls.every(([url]) => !url.startsWith("https://itchio-mirror."))).toBe(true);
  });

  it("does not re-use old anonymous handles across later resolve attempts", async () => {
    const fetcher = vi.fn<TextFetcher>();
    const sequence = [main(), purchase(), JSON.stringify({ url: `${PAGE}/download/first-issued-key` }), downloadPage(), JSON.stringify({ url: SIGNED }),
      main(), purchase(), JSON.stringify({ url: `${PAGE}/download/second-issued-key` }), downloadPage(), JSON.stringify({ url: SIGNED.replace("temporary-secret", "new-secret") })];
    for (const body of sequence) fetcher.mockResolvedValueOnce(response(body));
    const source = provider(fetcher);
    const one = await source.resolve(`itch_freeware:${ITEM}:2436127`);
    const two = await source.resolve(`itch_freeware:${ITEM}:2436127`);
    expect(one.url).not.toBe(two.url);
    expect(fetcher.mock.calls.filter(([url]) => url === `${PAGE}/download_url`)).toHaveLength(2);
  });

  it.each([1, 500])("stops before free acquisition when a title becomes paid (%s)", async (price) => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(response(main({ minPrice: price, actualPrice: price })));
    await expect(provider(fetcher).listResources(ITEM)).rejects.toThrow("不再免费");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires the author's normal no-payment option and never submits the payment form", async () => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(response(main())).mockResolvedValueOnce(response(purchase(false)));
    await expect(provider(fetcher).listResources(ITEM)).rejects.toThrow("匿名免费获取选项");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a different game identity, missing CSRF and script data without evaluating scripts", async () => {
    await expect(provider(vi.fn<TextFetcher>().mockResolvedValue(response(main({ id: 1 })))).listResources(ITEM)).rejects.toThrow("作品身份");
    const noCsrf = vi.fn<TextFetcher>().mockResolvedValueOnce(response(main())).mockResolvedValueOnce(response('<a class="direct_download_btn">No thanks</a>'));
    await expect(provider(noCsrf).listResources(ITEM)).rejects.toThrow("源站签发");
    const injected = `<script>globalThis.itchAuditExecuted = true; init_ViewGame('#game', {game: globalThis.itchAuditExecuted});</script>`;
    await expect(provider(vi.fn<TextFetcher>().mockResolvedValue(response(injected))).search(query)).rejects.toThrow("无效目录数据");
    expect((globalThis as Record<string, unknown>).itchAuditExecuted).toBeUndefined();
  });

  it.each(["https://evil.example/download/key", `${PAGE}/download/key?secret=x`, `${PAGE}/download/../purchase`])("rejects an off-contract generated download page: %s", async (url) => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(response(main())).mockResolvedValueOnce(response(purchase())).mockResolvedValueOnce(response(JSON.stringify({ url })));
    await expect(provider(fetcher).listResources(ITEM)).rejects.toThrow("列表地址无效");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["http://cdn.itch.io/file.zip", "https://evil.example/file.zip", "http://127.0.0.1/file.zip", "https://user:secret@cdn.itch.io/file.zip"])('rejects unexpected or unsafe signed targets: %s', async (url) => {
    await expect(provider(flow(undefined, url)).resolve(`itch_freeware:${ITEM}:2436127`)).rejects.toThrow("文件主机");
  });

  it("will not resolve an upload that was removed or changed to paid extras", async () => {
    const fetcher = flow(upload("1868851", "one-night-hot-springs-osx.zip", ["apple"]));
    await expect(provider(fetcher).resolve(`itch_freeware:${ITEM}:2436127`)).rejects.toThrow("已不在作者当前免费完整游戏列表");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("fails closed on challenge HTML, malformed JSON and bounded oversize pages", async () => {
    await expect(provider(vi.fn<TextFetcher>().mockResolvedValue(response('<title>Just a moment...</title>'))).search(query)).rejects.toThrow("访问验证");
    await expect(provider(vi.fn<TextFetcher>().mockResolvedValue(response("x".repeat(3 * 1024 * 1024 + 1)))).search(query)).rejects.toThrow("读取上限");
    await expect(provider(vi.fn<TextFetcher>().mockResolvedValue(response("<html>No game</html>"))).search(query)).rejects.toThrow("目录格式发生变化");
  });

  it("reports HTTP/network failures without disclosing cookies or signed URLs", async () => {
    await expect(provider(vi.fn<TextFetcher>().mockResolvedValue(response("private upstream text", 403))).search(query)).rejects.toThrow("HTTP 403");
    const error = new Error(`connection failed ${SIGNED}`);
    await expect(provider(vi.fn<TextFetcher>().mockRejectedValue(error)).search(query)).rejects.toThrow("暂时无法连接");
  });

  it("honors cancellation before networking and during a stalled response", async () => {
    const signal = new AbortController();
    signal.abort(new DOMException("user cancelled", "AbortError"));
    const never = vi.fn<TextFetcher>(() => new Promise(() => undefined));
    await expect(provider(never, { signal: signal.signal }).search(query)).rejects.toThrow("user cancelled");
    expect(never).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = provider(never, { signal: active.signal }).search(query);
    await vi.waitFor(() => expect(never).toHaveBeenCalledTimes(1));
    active.abort(new DOMException("cancel pending", "AbortError"));
    await expect(pending).rejects.toThrow("cancel pending");
  });

  it("ends a stalled fetch at the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const source = provider(vi.fn<TextFetcher>(() => new Promise(() => undefined)), { timeoutMs: 500 });
      const pending = expect(source.search(query)).rejects.toThrow("请求超时");
      await vi.advanceTimersByTimeAsync(550);
      await pending;
    } finally { vi.useRealTimers(); }
  });

  it("rejects arbitrary author IDs, invalid base URLs and non-applicable search", async () => {
    const fetcher = vi.fn<TextFetcher>();
    const source = provider(fetcher);
    await expect(source.search({ ...query, mediaType: "anime" })).resolves.toEqual([]);
    await expect(source.search({ ...query, keyword: " " })).resolves.toEqual([]);
    await expect(source.search({ ...query, page: 2 })).resolves.toEqual([]);
    await expect(source.search({ ...query, page: -1 })).rejects.toThrow("页码无效");
    await expect(source.listResources("evil/unreviewed-game")).rejects.toThrow("精选作品 ID 无效");
    await expect(source.resolve("itch_freeware:npckc/one-night-hot-springs:0")).rejects.toThrow("文件 ID 无效");
    await expect(source.resolve("itch_freeware:evil/game:123")).rejects.toThrow("精选作品 ID 无效");
    for (const base of ["https://itch.io/?token=x", "http://itch.io", "https://other.itch.io", "https://user:secret@itch.io", "https://itch.io/path"]) expect(() => new ItchFreewareSourceProvider(base, { fetcher })).toThrow("官方");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("health-checks a real public game page without creating a download grant", async () => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(response(main()));
    await expect(provider(fetcher).healthCheck()).resolves.toMatchObject({ ok: true, message: expect.stringContaining("精选完整作品") });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
  });
});
