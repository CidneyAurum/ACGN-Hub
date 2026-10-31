import { test, expect } from "./fixtures";

const stamp = "2026-10-31T00:00:00Z";
const work = { object: "work", id: "12", display_name: "ATRI -My Dear Moments-", localized: { "zh-Hans": { value: "亚托莉" }, en: { value: "ATRI -My Dear Moments-" } }, release_date: "2020-06-19", is_nsfw: false };

test("all enabled Galgame sources search together, isolate failures and leave closed sources unchanged", async ({ page }) => {
  await page.addInitScript(() => {
    const stamp = "2026-10-31T00:00:00Z";
    const source = (id: string, type: string, name: string, url: string, enabled = true) => ({ id, type, name, url, enabled, createdAt: stamp, updatedAt: stamp });
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([
      source("kun", "kungal", "我的中文社区", "https://www.kungal.com"),
      source("official", "vndb_release", "官方发行参考", "https://api.vndb.org/kana"),
      source("closed-feed", "rss", "已关闭的来源", "https://closed.example/rss.xml", false),
    ]));
  });
  let kunCalls = 0;
  let officialCalls = 0;
  let officialFails = false;
  await page.route("https://www.kungal.com/api/v1/**", async (route) => {
    kunCalls++;
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(path.endsWith("/resources") ? { object: "list", items: [], total: 0 } : path === "/api/v1/works/12" ? work : { object: "list", items: [work] }) });
  });
  await page.route("https://api.vndb.org/kana/vn", async (route) => {
    officialCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(officialFails ? { error: "fixture unavailable" } : { results: [{ id: "v21905", title: "ATRI -My Dear Moments-", titles: [{ title: "亚托莉", lang: "zh-Hans" }], aliases: ["ATRI"], image: null }], more: false }) });
  });
  await page.goto("/#/resources?type=visual_novel&q=ATRI");
  const selector = page.locator(".resource-source select");
  await expect(selector).toHaveValue("all");
  await expect(page.locator(".resource-source-note")).toContainText("我的中文社区、官方发行参考");
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  await expect(page.locator(".resource-work-card")).toHaveCount(2);
  expect((await page.locator(".resource-work-source").allTextContents()).sort()).toEqual(["我的中文社区", "官方发行参考"].sort());
  await expect(page.locator(".resource-search-sources")).toContainText("我的中文社区、官方发行参考");
  expect(kunCalls).toBeGreaterThan(0); expect(officialCalls).toBeGreaterThan(0);
  officialFails = true;
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  await expect(page.locator(".resource-work-card")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("官方发行参考");
  await expect(page.locator(".resource-work-source")).toHaveText(["我的中文社区"]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") ?? "[]").find((item: { id: string }) => item.id === "closed-feed").enabled)).toBe(false);
  await page.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  const savedAliases = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.media-library.v1") ?? "[]")[0].aliases as string[]);
  expect(savedAliases).toEqual(expect.arrayContaining(["ATRI", "亚托莉", "ATRI -My Dear Moments-"]));
});

test("all-source search with no enabled sources does not activate a preset", async ({ page }) => {
  await page.goto("/#/resources?type=visual_novel&q=ATRI");
  await expect(page.locator(".resource-source select")).toHaveValue("all");
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("还没有已启用的适用来源");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") ?? "[]").filter((item: { enabled: boolean }) => item.enabled))).toEqual([]);
});

test("Galgame conditions combine, keep unknown variants honest and preserve split archive names when queuing", async ({ page, mockNetwork }) => {
  const mediaId = "source:stored-kun:12";
  const sourceId = "kungal:https://www.kungal.com";
  const defaults = { resourceType: "game", languages: ["zh-CN"], platforms: ["win"], languageLabels: ["简体中文"], platformLabels: ["Windows"], downloadMode: "direct_file" };
  const resource = (id: string, title: string, metadata: Record<string, unknown>) => ({ id, sourceId, sourceItemId: "12", mediaId, title, protocol: "http", targetUrl: `https://files.example/${id}.7z.001`, metadata, createdAt: stamp });
  const resources = [
    resource("patch", "汉化补丁", { ...defaults, resourceType: "patch" }),
    resource("external", "社区分享页", { ...defaults, downloadMode: "external_link" }),
    resource("android", "安卓移植版", { ...defaults, platforms: ["and"], platformLabels: ["Android"] }),
    resource("unknown", "未知平台的中文标题", { downloadMode: "direct_file" }),
    resource("wanted", "ATRI 中文本体.7z.001", { ...defaults, editionLabel: "完整汉化版", translationLabel: "汉化", formLabel: "压缩包", downloadFileName: "亚托莉 - 简体中文.7z.001", files: [{ fileName: "亚托莉 - 简体中文.7z.001", sha256: "a".repeat(64), hashVerified: false }] }),
  ];
  await page.addInitScript(({ mediaId, resources, stamp }) => {
    const opened: string[] = [];
    Object.assign(window, { galOpened: opened });
    window.open = ((url: string | URL | undefined) => { opened.push(String(url)); return null; }) as typeof window.open;
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([{ id: "stored-kun", type: "kungal", name: "准确中文社区", url: "https://www.kungal.com", enabled: false, createdAt: stamp, updatedAt: stamp }]));
    localStorage.setItem("acgn-hub.media-library.v1", JSON.stringify([{ id: mediaId, type: "visual_novel", title: "亚托莉", aliases: ["ATRI"], externalIds: [], metadata: { sourceConfigId: "stored-kun", sourceItemId: "12" } }]));
    localStorage.setItem("acgn-hub.resources.v1", JSON.stringify(resources));
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming", downloadDirectory: "D:\\ACGN-E2E\\Incoming" }));
  }, { mediaId, resources, stamp });
  await page.goto("/#/media/" + encodeURIComponent(mediaId));
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(panel.locator(".subject-resource-item")).toHaveCount(5);
  await expect(panel.locator(".subject-resource-item").first()).toContainText("ATRI 中文本体.7z.001");
  await expect(panel.locator(".resource-exact-note")).toContainText("准确中文社区");
  const conditions = panel.getByLabel("Galgame 资源条件", { exact: true });
  await conditions.getByRole("button", { name: "中文", exact: true }).click();
  await conditions.getByRole("button", { name: "Windows", exact: true }).click();
  await conditions.getByRole("button", { name: "游戏本体", exact: true }).click();
  await panel.getByRole("combobox", { name: "Galgame 获取方式", exact: true }).selectOption("direct");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await expect(panel.locator(".resource-meta-chips")).toContainText("完整汉化版");
  await panel.getByText("原站文件与校验信息", { exact: true }).click();
  await expect(panel.locator(".resource-source-files")).toContainText("不代表已校验本地下载文件");
  await expect(panel.locator(".resource-source-files code")).toHaveText("SHA-256 " + "a".repeat(64));
  await panel.getByRole("searchbox", { name: "筛选资源", exact: true }).fill("中文 Windows 本体");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await panel.locator(".subject-resource-item").getByRole("button", { name: /直接下载/ }).click();
  const queued = mockNetwork.calls.filter((call) => call.method === "aria2.addUri");
  expect(queued).toHaveLength(1);
  expect(queued[0].params).toEqual(expect.arrayContaining([["https://files.example/wanted.7z.001"], expect.objectContaining({ out: "亚托莉 - 简体中文.7z.001" })]));
  await panel.getByRole("searchbox", { name: "筛选资源", exact: true }).fill("中文 Android");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(0);
  await expect(panel).toContainText("没有符合这些条件的资源");
  await expect(conditions.getByRole("button", { name: "Windows", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(panel.locator(".subject-resource-item")).toHaveCount(5);
  await panel.getByRole("combobox", { name: "Galgame 获取方式", exact: true }).selectOption("external");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await panel.getByRole("button", { name: /打开来源/ }).click();
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(1);
  await panel.getByRole("link", { name: "跨来源寻找这个作品 ↗", exact: true }).click();
  await expect(page).toHaveURL(/#\/resources\?type=visual_novel&q=/);
  await expect(page.getByRole("searchbox")).toHaveValue("亚托莉");
  await expect(page.locator(".resource-source select")).toHaveValue("all");
  await expect(page.locator(".resource-work-card")).toHaveCount(0);
});

test("batch selection stays inside the active edition and separate editions own separate archive directories", async ({ page, mockNetwork }) => {
  const mediaId = "source:edition-fixture:12";
  const sourceId = "kungal:https://www.kungal.com";
  const resources = [
    { id: "one-first", sourceItemId: "edition-one", title: "版本一 Game.7z.001", filename: "Game.7z.001", path: "one/Game.7z.001" },
    { id: "one-second", sourceItemId: "edition-one", title: "版本一 Game.7z.002", filename: "Game.7z.002", path: "one/Game.7z.002" },
    { id: "two", sourceItemId: "edition-two", title: "版本二 Game.7z", filename: "Game.7z", path: "two/Game.7z" },
  ].map((item) => ({ id: item.id, sourceId, sourceItemId: item.sourceItemId, mediaId, title: item.title, protocol: "http", targetUrl: `https://files.example/${item.path}`,
    metadata: { downloadMode: "direct_file", downloadFileName: item.filename, resourceType: "game", languages: ["zh-CN"], platforms: ["win"] }, createdAt: stamp }));
  await page.addInitScript(({ mediaId, resources, stamp }) => {
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([{ id: "edition-fixture", type: "kungal", name: "版本测试来源", url: "https://www.kungal.com", enabled: false, createdAt: stamp, updatedAt: stamp }]));
    localStorage.setItem("acgn-hub.media-library.v1", JSON.stringify([{ id: mediaId, type: "visual_novel", title: "相同作品", aliases: [], externalIds: [], metadata: { sourceConfigId: "edition-fixture", sourceItemId: "12" } }]));
    localStorage.setItem("acgn-hub.resources.v1", JSON.stringify(resources));
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming", downloadDirectory: "D:\\ACGN-E2E\\Incoming" }));
  }, { mediaId, resources, stamp });
  await page.goto("/#/media/" + encodeURIComponent(mediaId));
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  const editions = panel.getByRole("combobox", { name: "作品改编版本", exact: true });
  await expect(editions.locator("option")).toHaveCount(3);
  await editions.selectOption(sourceId + ":edition-one");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(2);
  await panel.locator(".subject-resource-item").first().getByRole("checkbox").check();
  await expect(panel.getByRole("button", { name: "下载所选 1", exact: true })).toBeEnabled();
  await editions.selectOption(sourceId + ":edition-two");
  await expect(editions.locator("option")).toHaveCount(3);
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /下载所选/ })).toBeDisabled();
  await panel.getByRole("checkbox", { name: "全选", exact: true }).check();
  await expect(panel.getByRole("button", { name: "下载所选 1", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "下载所选 1", exact: true }).click();
  await expect.poll(() => mockNetwork.calls.filter((call) => call.method === "aria2.addUri").length).toBe(1);
  let queued = mockNetwork.calls.filter((call) => call.method === "aria2.addUri");
  expect(queued[0].params[0]).toEqual(["https://files.example/two/Game.7z"]);
  await editions.selectOption(sourceId + ":edition-one");
  await panel.getByRole("checkbox", { name: "全选", exact: true }).check();
  await expect(panel.getByRole("button", { name: "下载所选 2", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "下载所选 2", exact: true }).click();
  await expect.poll(() => mockNetwork.calls.filter((call) => call.method === "aria2.addUri").length).toBe(3);
  queued = mockNetwork.calls.filter((call) => call.method === "aria2.addUri");
  expect(queued.map((call) => call.params[0])).toEqual([["https://files.example/two/Game.7z"], ["https://files.example/one/Game.7z.001"], ["https://files.example/one/Game.7z.002"]]);
  const options = queued.map((call) => call.params[1] as { dir: string; out: string });
  expect(options.map((item) => item.out)).toEqual(["Game.7z", "Game.7z.001", "Game.7z.002"]);
  expect(options[1].dir).toBe(options[2].dir);
  expect(options[0].dir).not.toBe(options[1].dir);
  for (const item of options) expect(item.dir).toMatch(/^D:\\ACGN-E2E\\Incoming\\Galgame\\相同作品 \[kungal-[a-f\d]{32}\]$/);
});
