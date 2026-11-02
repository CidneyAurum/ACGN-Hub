import { test, expect } from "./fixtures";

test("editing a completed source query clears stale candidates and never saves them with the new keyword", async ({ page }) => {
  await page.goto("/#/resources?type=manga&provider=mangabz");
  await page.getByRole("searchbox").fill("固定中文漫画");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: "固定中文漫画", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const staleTitle = document.querySelector<HTMLButtonElement>(".resource-title-button")!;
    const keyword = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    keyword.value = "完全不同的作品";
    keyword.dispatchEvent(new Event("input", { bubbles: true }));
    // An already queued click must not use the new form text with an old work.
    staleTitle.click();
  });
  await expect(page.getByRole("region", { name: "来源作品候选", exact: true })).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.media-library.v1") ?? "[]"));
  expect(saved).toEqual([]);
  await page.getByRole("searchbox").fill("固定中文漫画");
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  await page.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  const chosen = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.media-library.v1") ?? "[]"));
  expect(chosen[0].metadata.sourceQuery).toBe("固定中文漫画");
  expect(chosen[0].aliases).not.toContain("完全不同的作品");
  await page.goBack();
  await expect(page.getByRole("searchbox")).toHaveValue("固定中文漫画");
  await expect(page.getByRole("combobox")).toHaveValue("builtin:mangabz");
});

test("two title clicks in one event batch save a source work once", async ({ page }) => {
  await page.goto("/#/resources?type=manga&provider=mangabz");
  await page.getByRole("searchbox").fill("固定中文漫画");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: "固定中文漫画", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { sourceWorkSaveCount: number }).sourceWorkSaveCount = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === "acgn-hub.media-library.v1" && value.includes("source:builtin:mangabz:7020")) (window as unknown as { sourceWorkSaveCount: number }).sourceWorkSaveCount += 1;
      original.call(this, key, value);
    };
    const title = document.querySelector<HTMLButtonElement>(".resource-title-button")!;
    title.click(); title.click();
  });
  await expect(page).toHaveURL(/#\/media\/source/);
  expect(await page.evaluate(() => (window as unknown as { sourceWorkSaveCount: number }).sourceWorkSaveCount)).toBe(1);
});

test("stopping a partial source search during a pending work save releases the selection lock", async ({ page }) => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  await page.addInitScript(() => {
    const stamp = "2026-10-30T00:00:00Z";
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify(["fast", "slow"].map((id) => ({
      id: `rss:${id}`, type: "rss", name: id, url: `https://selection-fixture.example.test/${id}.xml`, enabled: true, createdAt: stamp, updatedAt: stamp,
    }))));
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
  });
  await page.route("https://selection-fixture.example.test/**", async (route) => {
    if (route.request().url().includes("/slow.xml")) await slow;
    await route.fulfill({ contentType: "application/rss+xml", body: '<?xml version="1.0"?><rss version="2.0"><channel><title>测试订阅</title><item><guid>episode</guid><title>待选作品 第一话</title><enclosure url="https://fixture.example.test/selected.mkv" type="video/x-matroska" length="10"/></item></channel></rss>' });
  });
  try {
    await page.goto("/#/resources?type=anime&sourceId=all");
    await page.getByRole("searchbox").fill("待选作品");
    await page.getByRole("button", { name: "搜索来源", exact: true }).click();
    await expect(page.getByRole("heading", { name: "待选作品 第一话", exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const modulePath = "/src/stores/media-library.ts";
      const { useMediaLibraryStore } = await import(modulePath);
      const store = useMediaLibraryStore();
      const original = store.save;
      const state = window as unknown as { finishSourceSave(): void; sourceSaveStarted: boolean; sourceSaveReturned: boolean };
      const gate = new Promise<void>((resolve) => { state.finishSourceSave = resolve; });
      state.sourceSaveStarted = false; state.sourceSaveReturned = false;
      store.save = async (media: unknown) => { state.sourceSaveStarted = true; await gate; await original(media); state.sourceSaveReturned = true; };
    });
    const title = page.getByRole("button", { name: "待选作品 第一话", exact: true });
    await title.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { sourceSaveStarted: boolean }).sourceSaveStarted)).toBe(true);
    await page.getByRole("button", { name: "停止等待", exact: true }).click();
    await page.evaluate(() => (window as unknown as { finishSourceSave(): void }).finishSourceSave());
    await expect.poll(() => page.evaluate(() => (window as unknown as { sourceSaveReturned: boolean }).sourceSaveReturned)).toBe(true);
    await expect(page).toHaveURL(/#\/resources/);
    await expect(title).toBeEnabled();
    await expect(page.getByRole("button", { name: "搜索来源", exact: true })).toBeEnabled();
    await title.click();
    await expect(page).toHaveURL(/#\/media\/source/);
  } finally { releaseSlow(); }
});

test("the exact second RSS source survives searching, detail return and reload instead of reverting to the first RSS", async ({ page }) => {
  const firstUrl = "https://source-fixture.example.test/first.xml";
  const secondUrl = "https://source-fixture.example.test/second.xml";
  await page.addInitScript(({ firstUrl, secondUrl }) => {
    if (localStorage.getItem("e2e.exact-rss-seeded")) return;
    const stamp = "2026-10-30T00:00:00Z";
    const source = (id: string, type: string, name: string, url: string) => ({ id, type, name, url, enabled: true, createdAt: stamp, updatedAt: stamp });
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([
      source("rss:first", "rss", "第一个RSS来源", firstUrl), source("rss:second", "rss", "第二个RSS来源", secondUrl),
      source("manga:only", "copymanga", "仅漫画来源", "https://mapi.hotmangasg.com"),
    ]));
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("e2e.exact-rss-seeded", "1");
  }, { firstUrl, secondUrl });
  const requests: string[] = [];
  await page.route("https://source-fixture.example.test/**", async (route) => {
    const second = route.request().url() === secondUrl;
    requests.push(second ? "second" : "first");
    const title = second ? "精确订阅 第二话" : "精确订阅 第一话";
    await route.fulfill({ contentType: "application/rss+xml", body: `<?xml version="1.0"?><rss version="2.0"><channel><title>固定订阅</title><item><guid>${second ? "second-episode" : "first-episode"}</guid><title>${title}</title><enclosure url="https://fixture.example.test/${second ? "second" : "first"}.mkv" type="video/x-matroska" length="1000000"/></item></channel></rss>` });
  });
  await page.goto("/#/resources?type=anime");
  await page.getByRole("searchbox").fill("精确订阅");
  await page.getByRole("combobox").selectOption("rss:second");
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  await expect(page.getByRole("combobox")).toHaveValue("rss:second");
  await expect(page.getByRole("heading", { name: "精确订阅 第二话", exact: true })).toBeVisible();
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("sourceId")).toBe("rss:second");
  expect(requests).toEqual(["second"]);
  await page.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  await expect(page.getByRole("heading", { name: "精确订阅 第二话", level: 1, exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("combobox")).toHaveValue("rss:second");
  await expect(page.getByRole("searchbox")).toHaveValue("精确订阅");
  await page.reload();
  await expect(page.getByRole("combobox")).toHaveValue("rss:second");
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  await expect(page.getByRole("heading", { name: "精确订阅 第二话", exact: true })).toBeVisible();
  expect(requests.every((request) => request === "second")).toBe(true);

  await page.getByRole("button", { name: "漫画", exact: true }).click();
  await expect(page).toHaveURL(/type=manga/);
  let params = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
  expect(params.has("sourceId")).toBe(false);
  expect(params.has("provider")).toBe(false);
  await page.goto("/#/resources?type=anime&sourceId=manga%3Aonly&provider=copymanga");
  await expect(page.getByRole("combobox")).toHaveValue("rss:first");
  await expect(page.getByRole("combobox").locator('option[value="manga:only"]')).toHaveCount(0);
  await page.goto("/#/resources?type=anime&provider=rss");
  await expect(page.getByRole("combobox")).toHaveValue("rss:first");
});

test("changing a source invalidates a slow previous source search", async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  let finished = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/v3/search/comic**", async (route) => {
    started();
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, results: { list: [{ name: "固定旧来源漫画", path_word: "old-source", cover: "https://lain.bgm.tv/old-cover.jpg" }] } }) });
    finished = true;
  });
  await page.goto("/#/resources?type=manga");
  await page.getByRole("searchbox").fill("固定中文漫画");
  await page.getByRole("combobox").selectOption("builtin:copymanga");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await requested;
  await page.getByRole("combobox").selectOption("builtin:mangabz");
  await expect(page.getByRole("heading", { name: "正在读取来源目录", exact: true })).toHaveCount(0);
  release();
  await expect.poll(() => finished).toBe(true);
  await expect(page.getByRole("region", { name: "来源作品候选", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveValue("builtin:mangabz");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: "固定中文漫画", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "固定旧来源漫画", exact: true })).toHaveCount(0);
});

test("resource type, keyword and provider follow same-page navigation and browser history", async ({ page }) => {
  await page.goto("/#/resources?type=manga&q=初始漫画&provider=mangabz");
  await expect(page.getByRole("searchbox")).toHaveValue("初始漫画");
  await expect(page.getByRole("combobox")).toHaveValue("builtin:mangabz");
  await page.getByRole("button", { name: "小说", exact: true }).click();
  await expect(page).toHaveURL(/type=novel/);
  await expect(page.getByRole("combobox")).toHaveValue("builtin:lnovel");
  await page.evaluate(() => { window.location.hash = "/resources?type=manga&q=另一部漫画&provider=copymanga"; });
  await expect(page.getByRole("searchbox")).toHaveValue("另一部漫画");
  await expect(page.getByRole("combobox")).toHaveValue("builtin:copymanga");
  await page.goBack();
  await expect(page.getByRole("button", { name: "小说", exact: true })).toHaveClass(/active/);
  await expect(page.getByRole("searchbox")).toHaveValue("初始漫画");
  await expect(page.getByRole("combobox")).toHaveValue("builtin:lnovel");
  await page.goForward();
  await expect(page.getByRole("button", { name: "漫画", exact: true })).toHaveClass(/active/);
  await expect(page.getByRole("searchbox")).toHaveValue("另一部漫画");
});

test("global search retains the selected reading category", async ({ page }) => {
  await page.goto("/#/?type=novel");
  const globalSearch = page.getByRole("textbox", { name: "全局搜索作品", exact: true });
  await globalSearch.fill("文学少女");
  await globalSearch.press("Enter");
  await expect(page).toHaveURL(/#\/search\?.*type=novel/);
  await expect(page.getByRole("button", { name: "小说", exact: true })).toHaveClass(/active/);
  await expect(page.getByRole("searchbox", { name: "小说名称", exact: true })).toHaveValue("文学少女");
});

test("opening source search from a manga detail retains the work and manga category", async ({ page }) => {
  await page.goto("/#/resources?type=manga&provider=mangabz");
  await page.getByRole("searchbox").fill("固定中文漫画");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await page.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  await page.getByRole("link", { name: "直接在来源中选作品 ↗", exact: true }).click();
  await expect(page).toHaveURL(/type=manga/);
  await expect(page.getByRole("searchbox")).toHaveValue("固定中文漫画");
  await expect(page.getByRole("button", { name: "漫画", exact: true })).toHaveClass(/active/);
});
