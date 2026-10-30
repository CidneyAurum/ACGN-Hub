import { test, expect } from "./fixtures";

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
