import { test, expect } from "./fixtures";

const work = { object: "work", id: "86", display_name: "リトルバスターズ！", latin: "Little Busters!", localized: { "zh-Hans": { value: "小小克星！" }, en: { value: "Little Busters!" } }, cover: { url: "https://lain.bgm.tv/gal-fixture.jpg" }, is_nsfw: false, release_date: "2007-07-27" };
const resource = { object: "galgame_resource", id: "64056", work: { id: "86" }, resource_type: "game", resource_languages: ["zh-cn"], resource_platforms: ["win"], resource_runtimes: ["native-win"], title: "社区中文版本", size: "4.8 GB", provider_names: ["夸克网盘"], state: "valid" };

test("a Galgame alias reaches the correct source work; external pages have useful labels and never enter batch downloads", async ({ page, mockNetwork }) => {
  await page.addInitScript(() => {
    const opened: string[] = [];
    Object.assign(window, { galOpened: opened });
    window.open = ((url: string | URL | undefined) => { opened.push(String(url)); return null; }) as typeof window.open;
  });
  const paths: string[] = [];
  await page.route("https://www.kungal.com/api/v1/**", async (route) => {
    const url = new URL(route.request().url()); paths.push(url.pathname);
    const body = url.pathname.includes("/resources") ? { object: "list", total: 1, items: [resource] }
      : url.pathname === "/api/v1/works/86" ? work : { object: "list", items: [work] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/#/resources?type=visual_novel&provider=kungal&q=Little%20Busters!");
  await page.getByRole("button", { name: /启用此来源并搜索|搜索来源/ }).click();
  await expect(page.getByRole("button", { name: "小小克星！", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await expect(panel.locator(".resource-meta-chips")).toContainText("Windows");
  await expect(panel.locator(".resource-meta-chips")).toContainText("夸克网盘");
  await expect(panel.locator(".resource-meta-chips")).toContainText("简体中文");
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /下载所选/ })).toHaveCount(0);
  await panel.getByRole("searchbox", { name: "筛选资源" }).fill("原生");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await panel.getByRole("button", { name: /打开来源/ }).click();
  expect(await page.evaluate(() => (window as unknown as { galOpened: string[] }).galOpened)).toEqual(["https://www.kungal.com/galgame/resource/64056"]);
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toEqual([]);
  expect(paths.some((path) => path.includes("downloads"))).toBe(false);
  await page.reload();
  await expect(page.getByRole("region", { name: "作品资源", exact: true }).locator(".subject-resource-item")).toHaveCount(1);
});

test("the new official release preset is selectable on an existing profile without changing saved sources", async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("gal.fixture.seeded")) return;
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([{ id: "custom-kun", type: "kungal", name: "我的社区来源", url: "https://www.kungal.com", enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]));
    localStorage.setItem("gal.fixture.seeded", "1");
  });
  const release = { id: "r123", title: "Official trial", alttitle: null, languages: [{ lang: "zh-Hans", title: "官方试玩", main: true }], platforms: ["win"], freeware: true, patch: false, released: "2025-01-01", official: true, vns: [{ id: "v21905", rtype: "trial" }], extlinks: [{ url: "https://store.steampowered.com/app/1263470/", label: "Steam", name: "steam" }] };
  await page.route("https://api.vndb.org/kana/**", async (route) => {
    const body = route.request().url().endsWith("/release") ? { results: [release,
      { ...release, id: "r124", title: "Official complete edition", freeware: false, languages: [{ lang: "ja", title: "日本語完全版", main: true }], vns: [{ id: "v21905", rtype: "complete" }] }], more: false }
      : { results: [{ id: "v21905", title: "Fixture Visual Novel", titles: [{ title: "官方试玩作品", lang: "zh-Hans" }], aliases: [], image: null }], more: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/#/resources?type=visual_novel&provider=vndb_release&q=Fixture%20Visual%20Novel");
  await expect(page.locator(".resource-source select")).toHaveValue("builtin:vndb-releases");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await page.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(panel.getByRole("button", { name: /前往试玩页面/ })).toBeVisible();
  await expect(panel.locator(".subject-resource-item")).toHaveCount(2);
  await expect(panel).toContainText("不是完整游戏");
  await panel.getByRole("searchbox", { name: "筛选资源" }).fill("中文");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  const sources = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") ?? "[]") as { id: string; name: string; enabled: boolean }[]);
  expect(sources.find((source) => source.id === "custom-kun")).toMatchObject({ name: "我的社区来源", enabled: false });
  expect(sources.find((source) => source.id === "builtin:vndb-releases")).toMatchObject({ enabled: true });
});

test("the curated official file queues with its real URL and recognizable filename", async ({ page, mockNetwork }) => {
  await page.addInitScript(() => localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming" })));
  await page.goto("/#/?type=visual_novel");
  const guide = page.getByRole("region", { name: "Galgame 资源入口", exact: true });
  await guide.locator("summary").filter({ hasText: "官方发行、试玩与免费原版参考" }).click();
  await expect(guide.getByRole("link", { name: /ATRI -My Dear Moments-/ })).toHaveAttribute("href", "https://store.steampowered.com/app/1263470/");
  await guide.getByRole("button", { name: /下载日文原版/ }).click();
  await expect(guide.getByRole("status")).toContainText("已加入下载中心");
  const queued = mockNetwork.calls.filter((call) => call.method === "aria2.addUri");
  expect(queued).toHaveLength(1);
  expect(queued[0].params).toEqual(expect.arrayContaining([["https://stage-nana.sakura.ne.jp/download/naru2.lzh"], expect.objectContaining({ out: "水仙2（Narcissu Side 2nd）- 日文原版.lzh" })]));
});
