import { mkdir } from "node:fs/promises";
import { test, expect, animeTitle, feedUrl, httpUrl, magnetUrl, torrentUrl, openHome, saveAnime, searchAnime, installPublicVideoNativeSimulation, publicVideoTitle, publicVideoBvid, publicVideoUrl } from "./fixtures";

test.beforeAll(async () => { await mkdir(".work/e2e", { recursive: true }); });

test("discovery calendar loads covers; the cover and title both open a useful detail page", async ({ page }) => {
  await openHome(page);
  await expect(page.getByRole("heading", { name: "每周放送", exact: true })).toBeVisible();
  const featuredImage = page.locator(".spotlight-poster img");
  await expect(featuredImage).toBeVisible();
  await expect.poll(() => featuredImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: ".work/e2e/home.png", fullPage: true });
  await page.locator(".spotlight-poster").click();
  await expect(page.getByRole("heading", { name: animeTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查找资源", exact: false }).first()).toBeVisible();
  await searchAnime(page);
  await expect(page.getByLabel("动画名称")).toHaveValue(animeTitle);
  await expect(page.locator(".poster-results-grid .poster-loaded")).toHaveCount(1);
  await page.screenshot({ path: ".work/e2e/search-results.png", fullPage: true, animations: "disabled" });
  await page.locator(".poster-results-grid .subject-name").first().click();
  await expect(page).toHaveURL(/#\/media\/bangumi/);
  await expect(page.getByRole("heading", { name: animeTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登场角色", exact: true })).toBeVisible();
  await expect(page.getByText("菲伦", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".work/e2e/subject-detail.png", fullPage: true });
});

test("tracking status and progress persist; the library filters real saved records", async ({ page }) => {
  await saveAnime(page);
  await page.getByRole("combobox", { name: "追番状态", exact: true }).selectOption("watching");
  await page.getByRole("button", { name: /标记下一集/ }).click();
  await expect(page.locator(".subject-tracking")).toContainText("已看 1 / 28 集");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "追番状态", exact: true })).toHaveValue("watching");
  await expect(page.locator(".subject-tracking")).toContainText("已看 1 / 28 集");
  await page.goto("/#/library?status=watching");
  await expect(page.getByRole("button", { name: /^在看/ })).toHaveClass(/active/);
  await expect(page.locator(".collection-grid .subject-name")).toHaveText(animeTitle);
  await page.getByRole("searchbox", { name: "搜索收藏作品" }).fill("不存在的作品");
  await expect(page.locator(".collection-grid .subject-name")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "搜索收藏作品" }).fill("芙莉莲");
  await expect(page.locator(".collection-grid .subject-name")).toHaveText(animeTitle);
  await page.getByRole("button", { name: /^看过/ }).click();
  await expect(page.getByRole("heading", { name: "这个分组还没有作品" })).toBeVisible();
  await page.getByRole("button", { name: /^在看/ }).click();
  await page.screenshot({ path: ".work/e2e/library-persisted.png", fullPage: true });
});

test("a damaged local library cannot block opening a search result already selected by the user", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("acgn-hub.media-library.v1", "{damaged-library-original"); });
  await searchAnime(page);
  await page.locator(".poster-results-grid").getByRole("link", { name: "查看" + animeTitle, exact: true }).click();
  await expect(page.getByRole("heading", { name: animeTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /查找资源/ }).first()).toBeVisible();
  await expect(page.locator(".subject-inline-error")).toContainText("原始数据已保留");
  expect(await page.evaluate(() => localStorage.getItem("acgn-hub.media-library.v1"))).toBe("{damaged-library-original");
});

test("Galgame search uses VNDB; an entire result cover can open the selected work", async ({ page }) => {
  await page.goto("/#/search?type=visual_novel");
  await expect(page.getByRole("button", { name: "Galgame", exact: true })).toHaveClass(/active/);
  await page.getByLabel("Galgame名称").fill("Fate");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("link", { name: "查看Fate/stay night", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fate/stay night", exact: true })).toBeVisible();
  await expect(page.getByText("TYPE-MOON", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "♡ 收藏作品", exact: true }).click();
  await page.goto("/#/library");
  await page.getByRole("button", { name: "Galgame", exact: true }).click();
  await expect(page.locator(".collection-grid .subject-name")).toHaveText("Fate/stay night");
});

test("direct source search confirms an exact manga before loading only its chapter list", async ({ page, mockNetwork }) => {
  await page.goto("/#/resources?type=manga");
  await page.getByRole("searchbox").fill("测试漫画");
  await page.getByRole("combobox").selectOption("builtin:copymanga");
  await expect(page.getByRole("button", { name: "启用此来源并搜索", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: "测试漫画", exact: true })).toBeVisible();
  expect(mockNetwork.sourceCalls.some((path) => path.endsWith("/chapters"))).toBe(false);
  await page.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  await expect(page.getByRole("heading", { name: "测试漫画", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "这部作品的资源", exact: true })).toBeVisible();
  await expect(page.locator(".subject-resource-item")).toHaveCount(1);
  await expect(page.locator(".subject-resource-item")).toContainText("第 1 话 · 固定章节");
  await expect(page.getByRole("button", { name: /下载章节/ })).toBeVisible();
  expect(mockNetwork.sourceCalls.filter((path) => path.includes("/search/comic"))).toHaveLength(1);
  await page.reload();
  await expect(page.locator(".subject-resource-item")).toHaveCount(1);
  expect(mockNetwork.sourceCalls.filter((path) => path.includes("/search/comic"))).toHaveLength(1);
  await page.screenshot({ path: ".work/e2e/source-exact-manga.png", fullPage: true });
});

test("a confirmed public submission keeps its stable BV URL and reaches a completed MP4 task", async ({ page }) => {
  test.skip(process.env.E2E_PREVIEW === "1", "The native-process boundary simulation intentionally targets development ESM modules; real native media is verified separately.");
  const inspected = await installPublicVideoNativeSimulation(page);
  await page.addInitScript(() => {
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ libraryDirectory: "D:\\ACGN-E2E\\Library", incomingDirectory: "D:\\ACGN-E2E\\Incoming" }));
  });
  await page.goto("/#/resources?type=anime");
  await page.getByRole("searchbox").fill("固定公开动画");
  await page.getByRole("combobox").selectOption("builtin:public-video");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  const candidate = page.locator("article.resource-work-card").filter({ has: page.getByRole("heading", { name: publicVideoTitle, exact: true }) });
  await expect(candidate).toContainText("24:00");
  await expect(candidate).toContainText("固定公开视频投稿者");
  await expect(page.locator("article.resource-work-card").filter({ hasText: "PV预告" })).toContainText("不足 10 分钟");
  expect(inspected).toEqual([]);
  await candidate.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page.locator(".subject-resource-item")).toHaveCount(1);
  expect(inspected).toEqual([publicVideoUrl]);
  await expect(page.locator(".subject-resource-item")).toContainText("1080p");
  await page.locator(".subject-resource-item").getByRole("button", { name: /下载视频/ }).click();
  await expect.poll(() => page.evaluate(() => {
    const tasks = JSON.parse(localStorage.getItem("acgn-hub.local-download-tasks.v1") || "[]");
    return tasks[0]?.completedUnits;
  })).toBe(42);
  const storedResources = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.resources.v1") || "[]"));
  expect(storedResources[0]).toMatchObject({ targetUrl: publicVideoUrl, format: "MP4", metadata: { downloadMode: "public_video" } });
  expect(JSON.stringify(storedResources)).not.toMatch(/\.m4s|bilivideo\.com|deadline=|token=/);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "下载", exact: false }).click();
  const task = page.locator(".local-downloads article.task-row").filter({ hasText: publicVideoTitle });
  await expect(task.locator('[data-state="downloading"]')).toBeVisible();
  await expect(task).toContainText("视频 MP4");
  await expect(task).toContainText("42%");
  await expect(task.locator(".progress-track > span")).toHaveAttribute("style", /width:\s*42%/);
  await expect(page.locator(".download-summary .summary-card").filter({ hasText: "全部下载" }).locator("strong")).toHaveText("1");
  await expect(page.locator(".download-summary .summary-card").filter({ hasText: "正在进行" }).locator("strong")).toHaveText("1");
  await expect(page.getByText("还没有下载任务", { exact: true })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "搜索任务", exact: true }).fill("不匹配的本地视频");
  await expect(page.locator(".local-downloads article.task-row")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "搜索任务", exact: true }).fill("固定公开动画");
  await expect(task).toBeVisible();
  await page.screenshot({ path: ".work/e2e/public-video-mp4-progress.png", fullPage: true, animations: "disabled" });
  await page.evaluate(() => {
    const bridge = window as typeof window & { __e2eCompletePublicVideoDownload?: () => void };
    if (!bridge.__e2eCompletePublicVideoDownload) throw new Error("Simulated native operation has not started");
    bridge.__e2eCompletePublicVideoDownload();
  });
  await expect(task.locator('[data-state="completed"]')).toBeVisible();
  await expect(task.locator(".progress-track > span")).toHaveAttribute("style", /width:\s*100%/);
  await expect(task).toContainText(".mp4");
  await expect(page.locator(".download-summary .summary-card").filter({ hasText: "已完成" }).locator("strong")).toHaveText("1");
  await expect(page.locator(".download-summary .summary-card").filter({ hasText: "正在进行" }).locator("strong")).toHaveText("0");
  await page.screenshot({ path: ".work/e2e/public-video-mp4-completed.png", fullPage: true, animations: "disabled" });
  await page.reload();
  await expect(page.locator(".local-downloads article.task-row").filter({ hasText: publicVideoTitle }).locator('[data-state="completed"]')).toBeVisible();
});

test("an explicit BV opens the provider-confirmed work even when the title is entirely different", async ({ page, mockNetwork }) => {
  test.skip(process.env.E2E_PREVIEW === "1", "The native inspection simulation targets development ESM modules, without replacing application discovery.");
  const inspected = await installPublicVideoNativeSimulation(page);
  await page.goto("/#/resources?type=anime");
  await page.getByRole("searchbox").fill(publicVideoBvid);
  await page.getByRole("combobox").selectOption("builtin:public-video");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  const candidate = page.locator("article.resource-work-card").filter({ has: page.getByRole("heading", { name: publicVideoTitle, exact: true }) });
  await expect(candidate).toBeVisible();
  await expect(candidate).toContainText("24:00");
  expect(publicVideoTitle).not.toContain(publicVideoBvid);
  expect(inspected).toEqual([publicVideoUrl]);
  expect(mockNetwork.sourceCalls.filter((path) => path === "/x/web-interface/search/type")).toEqual([]);
  await page.screenshot({ path: ".work/e2e/public-video-bv-exact-candidate.png", fullPage: true, animations: "disabled" });
  await candidate.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page.getByRole("heading", { name: publicVideoTitle, exact: true }).first()).toBeVisible();
  await expect(page.locator(".subject-resource-item")).toHaveCount(1);
  await expect(page.locator(".subject-resource-item")).toContainText("1080p");
  expect(inspected).toEqual([publicVideoUrl, publicVideoUrl]);
  await page.screenshot({ path: ".work/e2e/public-video-bv-exact-detail.png", fullPage: true, animations: "disabled" });
});

test("pasting a public submission into downloads routes to its source instead of downloading HTML", async ({ page, mockNetwork }) => {
  test.skip(process.env.E2E_PREVIEW === "1", "The native inspection simulation targets development ESM modules only.");
  const inspected = await installPublicVideoNativeSimulation(page);
  await page.goto("/#/downloads");
  await page.getByLabel("下载目录", { exact: true }).fill("D:\\ACGN-E2E\\Incoming");
  await page.getByLabel("链接", { exact: true }).fill(`http://www.bilibili.com/video/${publicVideoBvid}/?vd_source=tracking`);
  await page.getByRole("button", { name: "开始下载", exact: true }).click();
  await expect(page).toHaveURL(/#\/resources\?/);
  await expect(page.getByRole("searchbox")).toHaveValue(publicVideoUrl);
  await expect(page.getByRole("combobox")).toHaveValue("builtin:public-video");
  await expect(page.getByRole("button", { name: "启用此来源并搜索", exact: true })).toBeVisible();
  expect(inspected).toEqual([]);
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") || "[]").find((source: { id: string }) => source.id === "builtin:public-video")?.enabled)).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") || "[]"))).toEqual([]);
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: publicVideoTitle, exact: true })).toBeVisible();
  expect(inspected).toEqual([publicVideoUrl]);
  await page.screenshot({ path: ".work/e2e/downloads-public-video-source-routing.png", fullPage: true, animations: "disabled" });
});

test("an invalid BV does not turn unrelated public-search results into arbitrary work choices", async ({ page, mockNetwork }) => {
  const inspected = await installPublicVideoNativeSimulation(page);
  await page.goto("/#/resources?type=anime");
  await page.getByRole("searchbox").fill("BV1A1111111");
  await page.getByRole("combobox").selectOption("builtin:public-video");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: "这个来源没有找到对应作品", exact: true })).toBeVisible();
  await expect(page.locator("article.resource-work-card")).toHaveCount(0);
  expect(mockNetwork.sourceCalls.filter((path) => path === "/x/web-interface/search/type")).toHaveLength(1);
  expect(inspected).toEqual([]);
});

test("a metadata detail can enable a source explicitly without leaving the work", async ({ page }) => {
  await saveAnime(page);
  await page.getByRole("button", { name: /查找资源/ }).first().click();
  await expect(page.getByRole("heading", { name: "选择一个来源开始", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /启用并搜索/ }).first()).toBeVisible();
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") || "[]").filter((source: { enabled: boolean }) => source.enabled).length);
  expect(before).toBe(0);
  // Use a fixed custom feed so an explicit click tests the whole request path
  // without reaching any public source or downloading a real file.
  await page.goto("/#/sources");
  await page.getByLabel("来源名称", { exact: true }).fill("固定自定义订阅");
  await page.getByLabel("RSS/Atom 地址", { exact: true }).fill(feedUrl);
  await page.getByRole("button", { name: "添加来源", exact: true }).click();
  const source = page.locator("article.source-row").filter({ hasText: "固定自定义订阅" });
  await source.getByRole("button", { name: "停用", exact: true }).click();
  await page.goto("/#/media/bangumi%3A12345");
  await page.getByRole("button", { name: /查找资源/ }).first().click();
  const suggestion = page.locator(".source-suggestion-grid article").filter({ hasText: "固定自定义订阅" });
  await suggestion.getByRole("button", { name: /启用并搜索/ }).click();
  await expect(page.locator(".subject-resource-item")).toHaveCount(3);
  await expect(page).toHaveURL(/#\/media\/bangumi/);
});

test("HTTP tasks are submitted once and support pause, resume, cancel and record removal", async ({ page, mockNetwork }) => {
  await page.goto("/#/downloads");
  await page.getByLabel("链接", { exact: true }).fill(httpUrl);
  await page.getByLabel("下载目录", { exact: true }).fill("D:\\ACGN-E2E\\Incoming");
  await page.getByRole("button", { name: "开始下载", exact: true }).click();
  const task = page.locator("article.task-row").filter({ hasText: "Fixture-Anime.mkv" });
  await expect(task.locator('[data-state="downloading"]')).toBeVisible();
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(1);
  await task.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(task.locator('[data-state="paused"]')).toBeVisible();
  await task.getByRole("button", { name: "继续", exact: true }).click();
  await expect(task.locator('[data-state="downloading"]')).toBeVisible();
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(1);
  await task.getByRole("button", { name: "取消", exact: true }).click();
  await expect(task.locator('[data-state="cancelled"]')).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await task.getByRole("button", { name: "删记录", exact: true }).click();
  await expect(task).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("还没有下载任务", { exact: true })).toBeVisible();
});

test("default Magnet and Torrent tasks use the built-in aria2 without qBittorrent setup", async ({ page, mockNetwork }) => {
  await page.goto("/#/downloads");
  await page.getByLabel("下载目录", { exact: true }).fill("D:\\ACGN-E2E\\Incoming");
  for (const url of [magnetUrl, torrentUrl]) {
    await page.getByLabel("链接", { exact: true }).fill(url);
    await page.getByRole("button", { name: "开始下载", exact: true }).click();
  }
  await expect(page.locator('article.task-row [data-state="downloading"]')).toHaveCount(2);
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(2);
  await expect(page.locator("article.task-row").filter({ hasText: "磁力链接" })).toHaveCount(1);
  await expect(page.locator("article.task-row").filter({ hasText: "种子文件" })).toHaveCount(1);
  await page.screenshot({ path: ".work/e2e/bt-default-aria2.png", fullPage: true });
});

test("settings validate paths and expose qBittorrent as an optional advanced engine", async ({ page, mockNetwork }) => {
  await page.goto("/#/settings");
  await page.getByRole("textbox", { name: /^待整理目录/ }).fill("relative-folder");
  await page.getByLabel("作品库目录").fill("D:\\ACGN-E2E\\Library");
  await page.getByLabel("电子书输出目录").fill("D:\\ACGN-E2E\\Books");
  await page.getByLabel("游戏存档备份目录").fill("D:\\ACGN-E2E\\Backups");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("alert").last()).toContainText("绝对路径");
  await page.getByRole("textbox", { name: /^待整理目录/ }).fill("D:\\ACGN-E2E\\Incoming");
  await page.getByLabel("最大并发任务数").fill("5");
  await expect(page.getByRole("combobox", { name: "BitTorrent 下载引擎" })).toHaveValue("aria2");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "设置已保存" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: /^待整理目录/ })).toHaveValue("D:\\ACGN-E2E\\Incoming");
  await expect(page.getByLabel("最大并发任务数")).toHaveValue("5");
  await page.getByRole("button", { name: "测试 aria2 连接", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "1.37.0" })).toBeVisible();
  mockNetwork.aria2Failure = true;
  await page.getByRole("button", { name: "测试 aria2 连接", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "RPC Secret 不正确" })).toBeVisible();
  await page.getByRole("button", { name: "测试 qBittorrent 连接", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "需要使用桌面版" })).toBeVisible();
  await page.getByRole("button", { name: "选择目录", exact: true }).first().click();
  await expect(page.getByRole("alert").last()).toContainText("目录选择器需要桌面端");
});

test("custom sources preserve edits and disablement through reload and control feed choices", async ({ page }) => {
  await page.goto("/#/sources");
  await page.getByLabel("来源名称", { exact: true }).fill("固定自定义订阅");
  await page.getByLabel("RSS/Atom 地址", { exact: true }).fill(feedUrl);
  await page.getByRole("button", { name: "添加来源", exact: true }).click();
  let source = page.locator("article.source-row").filter({ has: page.getByRole("heading", { name: "固定自定义订阅", exact: true }) });
  await source.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect(source).toContainText("发现 3 个可下载条目");
  await source.getByRole("button", { name: "停用", exact: true }).click();
  await source.getByRole("button", { name: "编辑", exact: true }).click();
  await source.getByLabel("名称", { exact: true }).fill("已编辑的固定订阅");
  await source.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.reload();
  source = page.locator("article.source-row").filter({ has: page.getByRole("heading", { name: "已编辑的固定订阅", exact: true }) });
  await expect(source.getByText("已停用", { exact: true })).toBeVisible();
  await page.goto("/#/feeds");
  await expect(page.getByRole("option", { name: "已编辑的固定订阅", exact: true })).toHaveCount(0);
  await page.goto("/#/sources");
  await source.getByRole("button", { name: "启用", exact: true }).click();
  await page.goto("/#/feeds");
  await expect(page.getByRole("option", { name: "已编辑的固定订阅", exact: true })).toHaveCount(1);
});

test("a reviewed RSS attachment requires a saved work before entering downloads", async ({ page }) => {
  await saveAnime(page);
  await page.goto("/#/feeds");
  await page.getByLabel("Feed 地址", { exact: true }).fill(feedUrl);
  await page.getByLabel("下载目录", { exact: true }).fill("D:\\ACGN-E2E\\Incoming");
  await page.getByRole("button", { name: "读取 Feed", exact: true }).click();
  await expect(page.locator("article.feed-item")).toHaveCount(3);
  const first = page.locator("article.feed-item").filter({ hasText: "第01话" });
  await expect(first.getByRole("button", { name: "加入下载", exact: true })).toBeDisabled();
  await first.getByRole("combobox", { name: "关联作品", exact: true }).selectOption({ label: animeTitle });
  await first.getByRole("button", { name: "加入下载", exact: true }).click();
  await expect(page.locator(".success-message")).toContainText("已关联「" + animeTitle + "」并加入下载");
  await page.goto("/#/downloads");
  await expect(page.locator("article.task-row").filter({ hasText: "RSS/Atom" })).toHaveCount(1);
});

test("empty searches and unknown routes remain recoverable", async ({ page, mockNetwork }) => {
  await page.goto("/#/library");
  await expect(page.getByRole("heading", { name: "这里，等着你喜欢的作品。" })).toBeVisible();
  await page.getByRole("link", { name: "去发现第一部作品", exact: true }).click();
  mockNetwork.searchEmpty = true;
  await page.getByLabel("动画名称").fill("没有匹配的固定结果");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: "这次没有找到", exact: true })).toBeVisible();
  await page.goto("/#/not-a-real-page");
  await expect(page.getByRole("heading", { name: /页面|找到|不存在/ }).first()).toBeVisible();
  await page.getByRole("link", { name: /返回工作台|回到工作台/ }).click();
  await expect(page.getByRole("heading", { name: "发现好故事" })).toBeVisible();
});

test("rebuilding damaged startup settings resumes automatic polling to completion", async ({ page, mockNetwork }) => {
  await page.addInitScript(() => { localStorage.setItem("acgn-hub.settings.v1", "{broken-settings"); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "本地配置没有正确加载", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("设置数据无法读取");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "重建设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "发现好故事" })).toBeVisible();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "下载", exact: false }).click();
  await page.getByLabel("链接", { exact: true }).fill(httpUrl);
  await page.getByLabel("下载目录", { exact: true }).fill("D:\\ACGN-E2E\\Incoming");
  await page.getByRole("button", { name: "开始下载", exact: true }).click();
  const task = page.locator("article.task-row").filter({ hasText: "Fixture-Anime.mkv" });
  await expect(task.locator('[data-state="downloading"]')).toBeVisible();
  mockNetwork.completeTransfers = true;
  await expect(task.locator('[data-state="completed"]')).toBeVisible({ timeout: 10_000 });
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.tellStatus").length).toBeGreaterThan(0);
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(1);
});
