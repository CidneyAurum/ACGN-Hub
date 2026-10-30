import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, seasonAnimeTitle } from "./fixtures";
import type { SourceConfig } from "../../src/domain/source";
import type { DownloadTask } from "../../src/domain/download";

type Kind = "manga" | "novel" | "anime";
type BookKind = Exclude<Kind, "anime">;
type Sort = "heat" | "score" | "recent";
const names = { manga: "漫画", novel: "轻小说", anime: "动画" };
const sorts: Sort[] = ["heat", "score", "recent"];
const bookTitle = (kind: BookKind, sort: Sort, index = 1) => `Soak ${names[kind]} ${sort} ${String(index).padStart(2, "0")}`;
const bookWall = (page: Page, kind: BookKind) => page.getByRole("region", { name: names[kind] + "推荐封面墙", exact: true });
const animeWall = (page: Page) => page.getByRole("region", { name: "季度新番", exact: true });

async function installSoakNetwork(page: Page) {
  const books: Array<{ kind: BookKind; sort: Sort; offset: number; dates?: string[]; at: number }> = [];
  const gates = new Map<string, Promise<void>>();
  const active = new Set<import("@playwright/test").Request>();
  const subjects = new Map<number, Record<string, unknown>>();
  let peakConcurrency = 0;
  let abortedRequests = 0;
  let manualSearches = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).hostname !== "api.bgm.tv") return;
    active.add(request);
    peakConcurrency = Math.max(peakConcurrency, active.size);
  });
  const finished = (request: import("@playwright/test").Request) => active.delete(request);
  page.on("requestfinished", finished);
  page.on("requestfailed", (request) => { if (request.failure()?.errorText.includes("ABORT")) abortedRequests++; finished(request); });
  await page.route("https://api.bgm.tv/v0/search/subjects?*", async (route) => {
    const input = route.request().postDataJSON() as { keyword: string; sort: string; filter: { type: number[]; tag?: string[]; air_date?: string[]; nsfw?: boolean; rating_count?: string[] } };
    if (input.keyword) {
      manualSearches++;
      const subject = { id: 940000 + manualSearches, type: 2, name: input.keyword, name_cn: input.keyword, platform: "TV", date: "2026-07-01", tags: [], images: { large: "https://lain.bgm.tv/soak/search.jpg" }, summary: "固定搜索导航资料" };
      subjects.set(subject.id, subject);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 1, limit: 30, offset: 0, data: [subject] }) });
    }
    if (input.filter.type[0] !== 1) return route.fallback();
    const kind: BookKind = input.filter.tag?.[0] === "轻小说" ? "novel" : "manga";
    const sort: Sort = input.sort === "score" ? "score" : input.filter.air_date ? "recent" : "heat";
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    expect(input.filter.nsfw).toBe(false);
    if (sort === "score") expect(input.filter.rating_count).toEqual([">=50"]);
    books.push({ kind, sort, offset, ...(input.filter.air_date ? { dates: input.filter.air_date } : {}), at: Date.now() });
    await gates.get(`${kind}:${sort}`);
    const base = (kind === "manga" ? 910000 : 920000) + sorts.indexOf(sort) * 1000;
    const data = Array.from({ length: Math.max(0, Math.min(limit, 49 - offset)) }, (_, index) => {
      const position = offset + index + 1;
      const subject = { id: base + position, type: 1, name: bookTitle(kind, sort, position), name_cn: bookTitle(kind, sort, position), date: "2026-07-01", platform: names[kind], nsfw: false,
        summary: "固定稳定性检验故事资料。", images: { large: `https://lain.bgm.tv/soak/${kind}/${sort}/${position}.jpg` },
        rating: { score: 8.7, total: 1000 }, tags: [{ name: names[kind], count: 200 }], collection: { doing: 100 } };
      subjects.set(subject.id, subject); return subject;
    });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 49, limit, offset, data }) });
  });
  await page.route(/https:\/\/api\.bgm\.tv\/v0\/subjects\/\d+$/, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    let subject = subjects.get(id);
    if (!subject && id >= 20_000_000) {
      const year = Math.floor(id / 10_000);
      const quarter = Math.floor((id % 10_000) / 100);
      const position = id % 100 + 1;
      if (quarter >= 1 && quarter <= 4) subject = { id, type: 2, name: seasonAnimeTitle(year, quarter, position), name_cn: seasonAnimeTitle(year, quarter, position), platform: "TV", date: `${year}-${String(quarter * 3 - 2).padStart(2, "0")}-01`, tags: [], images: { large: "https://lain.bgm.tv/soak/anime.jpg" }, summary: "固定季度详情资料" };
    }
    if (!subject) return route.fallback();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(subject) });
  });
  return { books, gates, metrics: () => ({ peakConcurrency, abortedRequests, manualSearches }) };
}

async function assertBook(page: Page, kind: BookKind, sort: Sort, count = 24): Promise<void> {
  const wall = bookWall(page, kind);
  await expect(wall.locator(".subject-name")).toHaveCount(count);
  await expect(page.getByRole("combobox", { name: names[kind] + "推荐排序", exact: true })).toHaveValue(sort);
  const titles = await wall.locator(".subject-name").allTextContents();
  expect(titles.every((value) => value.startsWith(`Soak ${names[kind]} ${sort} `))).toBe(true);
  await expect(bookWall(page, kind === "manga" ? "novel" : "manga")).toHaveCount(0);
  await expect(animeWall(page)).toHaveCount(0);
}

test.use({ timezoneId: "Asia/Shanghai", trace: "on" });

test("48 rounds preserve category, navigation, refresh boundaries and user state under mixed interactions", async ({ page, mockNetwork, browserErrors }, testInfo) => {
  test.setTimeout(180_000);
  await mkdir(".work/e2e", { recursive: true });
  const network = await installSoakNetwork(page);
  mockNetwork.seasonNamesByQuarter = true;
  const savedSource: SourceConfig = { id: "soak-source", type: "copymanga", name: "保留的来源", url: "https://mapi.hotmangasg.com", token: "soak-synthetic-token", enabled: false, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z" };
  const savedTask: DownloadTask = { id: "soak-completed", engineId: "aria2", engineEndpoint: "http://127.0.0.1:16800/jsonrpc", sourceUrl: "https://fixture.example.test/already-completed.mp4", protocol: "http", directory: "D:\\ACGN-E2E\\Incoming", filename: "保留的已完成视频.mp4", state: "completed", totalBytes: 1000, completedBytes: 1000, speedBytesPerSecond: 0, files: ["D:\\ACGN-E2E\\Incoming\\保留的已完成视频.mp4"], dedupeKey: "soak-completed", createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z" };
  await page.addInitScript(({ savedSource, savedTask }) => {
    if (localStorage.getItem("soak.seeded")) return;
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ autoRenameDownloads: false, aria2Endpoint: "http://127.0.0.1:16800/jsonrpc", incomingDirectory: "D:\\ACGN-E2E\\Incoming", libraryDirectory: "D:\\ACGN-E2E\\Library" }));
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([savedSource]));
    localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify([savedTask]));
    localStorage.setItem("acgn-hub.media-library.v1", JSON.stringify([{ id: "bangumi:899999", type: "manga", title: "保留的收藏作品", aliases: [], externalIds: [], metadata: {} }]));
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("soak.seeded", "1");
  }, { savedSource, savedTask });
  let clock = Date.parse("2026-10-30T04:00:00Z");
  await page.clock.setFixedTime(new Date(clock));
  await page.goto("/#/?type=manga");
  await assertBook(page, "manga", "heat");
  const snapshot = () => page.evaluate(() => Object.fromEntries(["acgn-hub.settings.v1", "acgn-hub.source-configs.v1", "acgn-hub.download-tasks.v1", "acgn-hub.media-library.v1"].map((key) => [key, localStorage.getItem(key)])));
  const baseline = await snapshot();
  const rounds: Array<Record<string, unknown>> = [];
  const operations = { detailReturns: 0, historyPairs: 0, unknownTypes: 0, abandonedRequests: 0, expiryRefreshes: 0, crossDayRefreshes: 0, pagination: 0 };
  const releases: Array<() => void> = [];
  const chooseKind = async (kind: Kind) => page.getByRole("navigation", { name: "发现作品分类", exact: true }).getByRole("button", { name: names[kind], exact: true }).click();
  const assertCurrent = async (kind: Kind, sort: Sort) => {
    if (kind !== "anime") { await assertBook(page, kind, sort); return; }
    await expect(animeWall(page).locator(".subject-name")).toHaveCount(24);
    const local = new Date(clock + 8 * 60 * 60_000);
    await expect(animeWall(page).getByRole("link", { name: seasonAnimeTitle(local.getUTCFullYear(), Math.floor(local.getUTCMonth() / 3) + 1), exact: true })).toBeVisible();
    await expect(page.locator(".book-discovery")).toHaveCount(0);
  };
  try {
    for (let round = 0; round < 48; round++) {
      let kind: Kind = (["manga", "novel", "anime"] as const)[round % 3];
      let sort = sorts[Math.floor(round / 3) % sorts.length];
      const beforeBooks = network.books.length;
      const beforeSeasons = mockNetwork.seasonCalls.length;
      await chooseKind(kind);
      if (kind !== "anime") await page.getByRole("combobox", { name: names[kind] + "推荐排序", exact: true }).selectOption(sort);
      await assertCurrent(kind, sort);

      if (round % 12 === 0 && kind !== "anime") {
        const key = `${kind}:${sort}`;
        let release = () => {};
        network.gates.set(key, new Promise<void>((resolve) => { release = resolve; }));
        releases.push(release);
        const before = network.books.length;
        await page.getByRole("button", { name: "刷新" + names[kind] + "推荐", exact: true }).click();
        await expect.poll(() => network.books.length).toBe(before + 1);
        kind = kind === "manga" ? "novel" : "manga";
        await chooseKind(kind);
        await assertBook(page, kind, sort);
        release(); network.gates.delete(key);
        await assertBook(page, kind, sort);
        operations.abandonedRequests++;
      }

      if (round % 7 === 0 && kind !== "anime") {
        const previous = sort;
        sort = sorts[(sorts.indexOf(sort) + 1) % sorts.length];
        await page.getByRole("combobox", { name: names[kind] + "推荐排序", exact: true }).selectOption(sort);
        await assertBook(page, kind, sort);
        await page.goBack(); await assertBook(page, kind, previous);
        await page.goForward(); await assertBook(page, kind, sort);
        operations.historyPairs++;
      }

      if (round % 8 === 0) {
        clock += 31 * 60_000;
        await page.clock.setFixedTime(new Date(clock));
        const before = kind === "anime" ? mockNetwork.seasonCalls.length : network.books.length;
        await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
        await expect.poll(() => kind === "anime" ? mockNetwork.seasonCalls.length : network.books.length).toBe(before + 2);
        await assertCurrent(kind, sort);
        if (kind !== "anime") await expect(bookWall(page, kind).locator("time")).toHaveAttribute("datetime", new Date(clock).toISOString());
        operations.expiryRefreshes++;
      }

      if (round === 18) {
        if (kind === "anime") { kind = "manga"; await chooseKind(kind); }
        sort = "recent";
        await page.getByRole("combobox", { name: names[kind] + "推荐排序", exact: true }).selectOption(sort);
        await assertBook(page, kind, sort);
        clock += 24 * 60 * 60_000;
        await page.clock.setFixedTime(new Date(clock));
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        const localDay = new Date(clock + 8 * 60 * 60_000).toISOString().slice(0, 10);
        await expect.poll(() => network.books.at(-1)?.dates?.[1]).toBe("<" + new Date(Date.parse(localDay) + 24 * 60 * 60_000).toISOString().slice(0, 10));
        await assertBook(page, kind, sort);
        operations.crossDayRefreshes++;
      }

      if (round % 13 === 0 && kind !== "anime") {
        await page.getByRole("button", { name: "加载更多" + names[kind], exact: true }).click();
        await assertBook(page, kind, sort, 48);
        operations.pagination++;
      }

      if (round % 5 === 0) {
        const target = kind === "anime" ? animeWall(page).locator(".subject-cover-link").first() : page.getByRole("region", { name: names[kind] + "精选", exact: true }).getByRole("link", { name: "探索这部作品", exact: true });
        const title = kind === "anime" ? await animeWall(page).locator(".subject-name").first().textContent() : bookTitle(kind, sort);
        await target.click();
        await expect(page).toHaveURL(/#\/media\/bangumi/);
        await expect(page.getByRole("heading", { name: title!, exact: true })).toBeVisible();
        await page.goBack();
        await assertCurrent(kind, sort);
        operations.detailReturns++;
      }

      if (round % 11 === 0) {
        // Distinct titles avoid intentionally matching a previous title through
        // the product's persistent fuzzy-search index.
        const keyword = ["星际远行", "海边邮差", "机械森林", "冬日灯塔", "沙漠画师"][Math.floor(round / 11)];
        await page.goto(`/#/search?q=${encodeURIComponent(keyword)}&type=${round % 2 ? "__proto__" : "toString"}`);
        await expect(page.getByRole("searchbox", { name: "动画名称", exact: true })).toHaveValue(keyword);
        await expect(page.locator(".poster-results-grid .subject-name")).toHaveText(keyword);
        await expect(page).toHaveURL(/type=anime/);
        await page.goBack();
        await assertCurrent(kind, sort);
        operations.unknownTypes++;
      }

      expect(await snapshot()).toEqual(baseline);
      expect(browserErrors).toEqual([]);
      const dom = await page.evaluate(() => ({ images: document.querySelectorAll(".media-poster img").length, cards: document.querySelectorAll(".subject-card").length,
        observedJsHeapBytes: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize }));
      rounds.push({ round: round + 1, kind, sort, route: new URL(page.url()).hash, bookRequests: network.books.length - beforeBooks, seasonRequests: mockNetwork.seasonCalls.length - beforeSeasons, ...dom });
    }
    await chooseKind("anime");
    clock = Date.parse("2026-12-31T16:00:05Z");
    await page.clock.setFixedTime(new Date(clock));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("combobox", { name: "番剧季度", exact: true })).toHaveValue("2027-Q1");
    await assertCurrent("anime", "heat");
    expect(mockNetwork.seasonCalls.some((call) => call.key === "2027-Q1")).toBe(true);
    expect(await snapshot()).toEqual(baseline);
    await page.screenshot({ path: ".work/e2e/soak-stability-final.png", animations: "disabled" });
  } finally {
    releases.forEach((release) => release());
    const report = { completedRounds: rounds.length, requestedRounds: 48, operations, bookRequests: network.books.length, seasonRequests: mockNetwork.seasonCalls.length,
      ...network.metrics(), browserErrors, peakCoverDom: Math.max(0, ...rounds.map((round) => Number(round.images))), peakCardDom: Math.max(0, ...rounds.map((round) => Number(round.cards))),
      memoryNote: "Heap samples are observations only; no leak or leak-free claim is inferred from GC-dependent values.", rounds, bookCalls: network.books, seasonCalls: mockNetwork.seasonCalls };
    await writeFile(".work/e2e/soak-stability-metrics.json", JSON.stringify(report, null, 2) + "\n");
    await testInfo.attach("soak-stability-metrics", { body: Buffer.from(JSON.stringify(report, null, 2)), contentType: "application/json" });
  }
});
