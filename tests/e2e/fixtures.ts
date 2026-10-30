import { test as base, expect, type Page } from "@playwright/test";
import {
  bangumiSearchFixture, bangumiDetailsFixture, bangumiCharactersFixture, bangumiPersonsFixture,
} from "../../src/tests/fixtures/bangumi";
import { vndbDetailsFixture, vndbCharactersFixture } from "../../src/tests/fixtures/vndb";

export const animeTitle = "葬送的芙莉莲";
export const feedUrl = "https://fixture.example.test/rss.xml";
export const magnetUrl = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Fixture-Anime";
export const torrentUrl = "https://fixture.example.test/Fixture-Anime.torrent";
export const httpUrl = "https://fixture.example.test/Fixture-Anime.mkv";
export const publicVideoTitle = "固定公开动画 第1话";
export const publicVideoBvid = "BV1A11111111";
export const publicVideoUrl = `https://www.bilibili.com/video/${publicVideoBvid}/`;
export const mangaSourceFixtures = {
  mangabz: { presetId: "builtin:mangabz", title: "固定中文漫画", sourceItemId: "7020", total: 45, sourceName: "MangaBZ · 中文日漫" },
} as const;
export const seasonAnimeTitle = (year: number, quarter: number, index = 1) => `${year}年Q${quarter}新番 ${String(index).padStart(2, "0")}`;

export interface SeasonRequest {
  key: string;
  startDate: string;
  endDate: string;
  limit: number;
  offset: number;
}

function seasonPage(request: SeasonRequest, namedByQuarter: boolean) {
  const [year, month] = request.startDate.split("-").map(Number);
  const quarter = Math.floor((month - 1) / 3) + 1;
  const total = 49;
  return { total, limit: request.limit, offset: request.offset,
    data: Array.from({ length: Math.max(0, Math.min(request.limit, total - request.offset)) }, (_, slot) => {
      const index = request.offset + slot;
      const title = namedByQuarter ? seasonAnimeTitle(year, quarter, index + 1) : index === 0 ? animeTitle : `当季番剧 ${index + 1}`;
      const id = !namedByQuarter && index === 0 ? 12345 : year * 10_000 + quarter * 100 + index;
      const date = `${request.startDate.slice(0, 7)}-${String(index % 28 + 1).padStart(2, "0")}`;
      return { id, type: 2, name: title, name_cn: title, date, air_date: date, platform: "TV", summary: `${request.key} 的固定新番资料`,
        images: { large: `https://lain.bgm.tv/e2e-season/${request.key}/${index + 1}.jpg` },
        rating: { score: 8.8, total: 1000 - index }, collection: { doing: 10_000 - index }, tags: [] };
    }),
  };
}

const mangabzSearchHtml = `<ul class="mh-list"><li><a href="/7020bz/"><img src="https://image.mangabz.com/e2e-cover.jpg"></a><h2><a href="/7020bz/">${mangaSourceFixtures.mangabz.title}</a></h2></li></ul>`;
const mangabzDetailHtml = `<p class="detail-info-title">${mangaSourceFixtures.mangabz.title}</p><div id="chapterlistload">${Array.from({ length: 45 }, (_, index) => 45 - index).map((chapter) => `<a class="detail-list-form-item" href="/m${117617 + chapter}/">第${chapter}話 <span>（${chapter === 1 ? 39 : 20}P）</span></a>`).join("")}</div>`;

const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
  <title>固定动漫更新</title><link>https://fixture.example.test</link>
  <item><guid>http-episode</guid><title>葬送的芙莉莲 第01话</title><description>已核对的固定附件</description><enclosure url="${httpUrl}" type="video/x-matroska" length="1048576" /></item>
  <item><guid>magnet-episode</guid><title>葬送的芙莉莲 第02话</title><enclosure url="${magnetUrl.replaceAll("&", "&amp;")}" type="application/x-magnet" /></item>
  <item><guid>torrent-episode</guid><title>葬送的芙莉莲 第03话</title><enclosure url="${torrentUrl}" type="application/x-bittorrent" /></item>
</channel></rss>`;

export interface MockNetwork {
  aria2Failure: boolean;
  searchEmpty: boolean;
  completeTransfers: boolean;
  calls: Array<{ method: string; params: unknown[] }>;
  unexpected: string[];
  taskStates: Map<string, "active" | "paused" | "removed">;
  sourceCalls: string[];
  seasonCalls: SeasonRequest[];
  seasonNamesByQuarter: boolean;
  seasonFailures: Set<string>;
  seasonGates: Map<string, Promise<void>>;
  aria2Statuses: Map<string, Record<string, unknown>>;
  aria2StatusErrors: Map<string, string>;
  aria2ActionGates: Map<string, Promise<void>>;
}

const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#adccb9"/><stop offset="1" stop-color="#334f64"/></linearGradient></defs><path fill="url(#g)" d="M0 0h400v560H0z"/><circle cx="292" cy="127" r="55" fill="#e6e9c9" opacity=".8"/><path fill="#557d7a" d="m0 360 110-140 106 110 70-75 114 130v175H0z"/><path fill="#254955" d="m0 442 140-99 150 108 110-54v163H0z"/><path fill="#d7e0d4" d="m175 438 27-151 22 151-15 83h-20z"/><path fill="#e8e7d8" d="m181 290 41-1-11-39-19 1z"/></svg>`;

export const test = base.extend<{ mockNetwork: MockNetwork; browserErrors: string[] }>({
  mockNetwork: [async ({ page }, use, testInfo) => {
    const network: MockNetwork = { aria2Failure: false, searchEmpty: false, completeTransfers: false, calls: [], unexpected: [], taskStates: new Map(), sourceCalls: [],
      seasonCalls: [], seasonNamesByQuarter: false, seasonFailures: new Set(), seasonGates: new Map(),
      aria2Statuses: new Map(), aria2StatusErrors: new Map(), aria2ActionGates: new Map() };
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === "http://127.0.0.1:1420") return route.continue();
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      if (url.hostname === "api.bgm.tv") {
        if (url.pathname === "/calendar") return json(Array.from({ length: 7 }, (_, index) => ({ weekday: { id: index + 1, cn: "周" + (index + 1) }, items: [{ ...bangumiDetailsFixture, air_date: "2023-09-29", collection: { doing: 100 } }] })));
        if (url.pathname.includes("/search/subjects")) {
          const input = request.method() === "POST" ? request.postDataJSON() as { keyword?: unknown; filter?: { air_date?: unknown; type?: unknown; nsfw?: unknown }; sort?: unknown } : undefined;
          if (input?.keyword === "" && Array.isArray(input.filter?.air_date)) {
            const dates = input.filter.air_date.filter((value): value is string => typeof value === "string");
            const startDate = dates.find((value) => value.startsWith(">="))?.slice(2) ?? "";
            const endDate = dates.find((value) => value.startsWith("<") && !value.startsWith("<="))?.slice(1) ?? "";
            const [year, month] = startDate.split("-").map(Number);
            const expectedEnd = Number.isFinite(year) && Number.isFinite(month) ? new Date(Date.UTC(year, month + 2, 1)).toISOString().slice(0, 10) : "";
            const limit = Number(url.searchParams.get("limit"));
            const offset = Number(url.searchParams.get("offset"));
            if (!/^\d{4}-(?:01|04|07|10)-01$/.test(startDate) || endDate !== expectedEnd || !Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(offset) || offset < 0
              || input.sort !== "heat" || JSON.stringify(input.filter.type) !== "[2]" || input.filter.nsfw !== false) {
              network.unexpected.push("Invalid season query: " + JSON.stringify({ url: url.toString(), body: input }));
              return json({ error: "季度请求的窗口或过滤条件不符合契约" });
            }
            const item: SeasonRequest = { key: `${year}-Q${Math.floor((month - 1) / 3) + 1}`, startDate, endDate, limit, offset };
            network.seasonCalls.push(item);
            const gate = network.seasonGates.get(item.key);
            if (gate) await gate;
            if (network.seasonFailures.has(item.key)) return json({ error: "固定季度接口暂不可用" });
            return json(seasonPage(item, network.seasonNamesByQuarter));
          }
          return json(network.searchEmpty ? { ...bangumiSearchFixture, data: [] } : bangumiSearchFixture);
        }
        if (url.pathname.endsWith("/characters")) return json(bangumiCharactersFixture);
        if (url.pathname.endsWith("/persons")) return json(bangumiPersonsFixture);
        return json(bangumiDetailsFixture);
      }
      if (url.hostname === "api.vndb.org") return json(url.pathname.endsWith("/character") ? vndbCharactersFixture : { results: [vndbDetailsFixture], more: false });
      if (url.hostname === "lain.bgm.tv" || url.hostname.endsWith("vndb.org")) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: coverSvg });
      if (url.toString() === feedUrl) return route.fulfill({ status: 200, contentType: "application/rss+xml", body: rss });
      if (url.hostname === "api.bilibili.com" && url.pathname === "/x/web-interface/search/type") {
        network.sourceCalls.push(url.pathname);
        return json({ code: 0, data: { result: [
          { bvid: publicVideoBvid, title: publicVideoTitle, pic: "https://lain.bgm.tv/fixture-video.jpg", author: "固定公开视频投稿者", duration: "24:00" },
          { bvid: "BV1B11111111", title: "固定公开动画 PV预告", author: "固定投稿者", duration: "00:25" },
        ] } });
      }
      if (url.hostname === "mapi.hotmangasg.com") {
        network.sourceCalls.push(url.pathname);
        if (url.pathname.includes("/search/comic")) return json({ code: 200, results: { list: [{ name: "测试漫画", path_word: "fixture-manga", alias: "Fixture Manga", cover: "https://lain.bgm.tv/fixture-manga.jpg" }] } });
        if (url.pathname.includes("/comic2/")) return json({ code: 200, results: { groups: { default: { path_word: "default" } } } });
        if (url.pathname.endsWith("/chapters")) return json({ code: 200, results: { total: 1, list: [{ uuid: "chapter-1", name: "第 1 话 · 固定章节", index: 0 }] } });
      }
      if (url.hostname === "mangabz.com") {
        network.sourceCalls.push(url.pathname);
        if (url.pathname === "/search") return route.fulfill({ status: 200, contentType: "text/html", body: mangabzSearchHtml });
        if (url.pathname === "/7020bz/") return route.fulfill({ status: 200, contentType: "text/html", body: mangabzDetailHtml });
      }
      if (url.hostname === "image.mangabz.com") {
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: coverSvg });
      }
      if (url.hostname === "127.0.0.1" && url.pathname === "/jsonrpc") {
        const input = request.postDataJSON() as { id: string; method: string; params: unknown[] };
        network.calls.push(input);
        if (network.aria2Failure) return json({ jsonrpc: "2.0", id: input.id, error: { code: -32000, message: "固定测试引擎：RPC Secret 不正确" } });
        const params = input.params.filter((value) => !(typeof value === "string" && value.startsWith("token:")));
        const gate = network.aria2ActionGates.get(input.method + ":" + String(params[0] ?? ""));
        if (gate) await gate;
        if (input.method === "aria2.tellStatus" && network.aria2StatusErrors.has(String(params[0]))) {
          return json({ jsonrpc: "2.0", id: input.id, error: { code: 1, message: network.aria2StatusErrors.get(String(params[0])) } });
        }
        let result: unknown = "OK";
        if (input.method === "aria2.getVersion") result = { version: "1.37.0" };
        if (input.method === "aria2.addUri") { result = (network.taskStates.size + 1).toString(16).padStart(16, "0"); network.taskStates.set(String(result), "active"); }
        if (input.method === "aria2.pause") network.taskStates.set(String(params[0]), "paused");
        if (input.method === "aria2.unpause") network.taskStates.set(String(params[0]), "active");
        if (input.method === "aria2.forceRemove") network.taskStates.set(String(params[0]), "removed");
        if (input.method === "aria2.tellStatus") result = {
          gid: params[0], status: network.completeTransfers ? "complete" : network.taskStates.get(String(params[0])) ?? "active",
          totalLength: "1048576", completedLength: network.completeTransfers ? "1048576" : "262144",
          downloadSpeed: network.completeTransfers ? "0" : "65536", files: [{ path: "D:\\ACGN-E2E\\Incoming\\Fixture-Anime.mkv" }],
        };
        if (input.method === "aria2.tellStatus" && network.aria2Statuses.has(String(params[0]))) {
          result = { gid: params[0], ...network.aria2Statuses.get(String(params[0])) };
          const state = network.taskStates.get(String(params[0]));
          if (state) (result as Record<string, unknown>).status = { active: "active", paused: "paused", removed: "removed" }[state];
        }
        return json({ jsonrpc: "2.0", id: input.id, result });
      }
      network.unexpected.push(request.method() + " " + request.url());
      return route.abort("blockedbyclient");
    });
    await use(network);
    await testInfo.attach("mock-network", { body: Buffer.from(JSON.stringify({ calls: network.calls, sourceCalls: network.sourceCalls, seasonCalls: network.seasonCalls, unexpected: network.unexpected }, null, 2)), contentType: "application/json" });
    expect(network.unexpected, "Every external request must have a fixed fixture; real sites and downloads are blocked").toEqual([]);
  }, { auto: true }],
  browserErrors: [async ({ page }, use, testInfo) => {
    const errors: string[] = [];
    const consoleMessages: Array<{ type: string; text: string }> = [];
    page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
    page.on("console", (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() });
      if (message.type() === "error") errors.push("console: " + message.text());
    });
    await use(errors);
    await testInfo.attach("browser-console", { body: Buffer.from(JSON.stringify({ errors, consoleMessages }, null, 2)), contentType: "application/json" });
    expect(errors, "The tested user flow must not produce browser errors").toEqual([]);
  }, { auto: true }],
});

export { expect };

export async function openHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "发现好故事" })).toBeVisible();
  await expect(page.getByRole("region", { name: "热门番剧" })).toBeVisible();
}

export async function searchAnime(page: Page): Promise<void> {
  await openHome(page);
  await page.getByRole("textbox", { name: "全局搜索作品" }).fill(animeTitle);
  await page.getByRole("textbox", { name: "全局搜索作品" }).press("Enter");
  await expect(page).toHaveURL(/#\/search\?q=/);
  await expect(page.locator(".poster-results-grid").getByRole("link", { name: "查看" + animeTitle, exact: true })).toBeVisible();
}

export async function saveAnime(page: Page): Promise<void> {
  await searchAnime(page);
  await page.locator(".poster-results-grid").getByRole("link", { name: "查看" + animeTitle, exact: true }).click();
  await page.getByRole("button", { name: "♡ 收藏作品", exact: true }).click();
  await expect(page.getByRole("button", { name: "♥ 已收藏", exact: true })).toBeVisible();
}

/** Replace only native inspection/download boundaries, not the product page or stores.
 * The development-server route makes the boundary explicit and avoids invoking
 * Tauri, yt-dlp, FFmpeg, a native GUI, or any real video download in this test.
 */
export async function installPublicVideoNativeSimulation(page: Page): Promise<string[]> {
  const inspected: string[] = [];
  await page.exposeFunction("__e2eInspectPublicVideo", async (url: string) => {
    inspected.push(url);
    return { id: publicVideoBvid, title: publicVideoTitle, duration: 1440, coverUrl: "https://lain.bgm.tv/fixture-video.jpg", playable: true,
      uploader: "固定公开视频投稿者", qualityLabel: "匿名可用 1080p", downloadHeightLimit: 1080, selectedFormat: { height: 1080, width: 1920 },
      formats: [{ id: "30080", ext: "mp4", width: 1920, height: 1080, hasVideo: true, hasAudio: false }] };
  });
  await page.route(/\/src\/infrastructure\/sources\/public-video-source-provider\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const importLine = /import\s*\{\s*invoke\s*\}\s*from\s*["'][^"']+["'];?/;
    if (!importLine.test(source)) throw new Error("Native inspection boundary import changed; update the test simulation explicitly");
    await route.fulfill({ response, body: source.replace(importLine, `const invoke = (command, args) => {
      if (command !== "inspect_public_video") throw new Error("Unexpected simulated native command");
      return window.__e2eInspectPublicVideo(args.url);
    };`) });
  });
  await page.route(/\/src\/infrastructure\/video\/tauri-public-video-service\.ts(?:\?.*)?$/, async (route) => {
    await route.fulfill({ contentType: "application/javascript", body: `export async function downloadPublicVideo(input) {
      window.__e2ePublicVideoDownloadInput = { url: input.url, outputRoot: input.outputRoot, outputPath: input.outputPath, operationId: input.operationId };
      input.onProgress?.({ id: input.operationId, percent: 42, downloadedBytes: 420000, totalBytes: 1000000, stage: "downloading" });
      await new Promise(resolve => { window.__e2eCompletePublicVideoDownload = resolve; });
      input.onProgress?.({ id: input.operationId, percent: 100, downloadedBytes: 1000000, totalBytes: 1000000, stage: "merging" });
      return { outputPath: input.outputPath, sizeBytes: 1000000 };
    }` });
  });
  return inspected;
}
