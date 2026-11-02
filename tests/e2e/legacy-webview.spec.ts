import { test, expect, animeTitle, openHome } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "structuredClone", { configurable: true, value: undefined });
    Object.defineProperty(Object, "hasOwn", { configurable: true, value: undefined });
    Object.defineProperty(Array.prototype, "at", { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal.prototype, "throwIfAborted", { configurable: true, value: undefined });
  });
});

test("legacy WebView without modern clone and array helpers can load discovery, metadata and source resources", async ({ page }) => {
  await openHome(page);
  await expect.poll(() => page.locator(".spotlight-poster img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.locator(".spotlight-poster").click();
  await expect(page.getByRole("heading", { name: animeTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登场角色", exact: true })).toBeVisible();
  await page.goto("/#/resources?type=manga");
  await page.getByRole("searchbox").fill("测试漫画");
  await page.getByRole("combobox").selectOption("builtin:copymanga");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: "测试漫画", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page.locator(".subject-resource-item")).toHaveCount(1);
  await expect(page.locator(".subject-resource-item")).toContainText("第 1 话 · 固定章节");
});

test("legacy WebView can find an LNovel work by author and reopen its cached volumes", async ({ page }) => {
  const calls: string[] = [];
  await page.route("https://lnovel.animes.garden/api/bili/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    const novel = { nid: 88, name: "文学少女", authors: [{ name: "野村美月", position: "author" }] };
    const data = path === "/api/bili/novels" ? [novel] : path === "/api/bili/novel/88"
      ? { ...novel, volumes: [{ nid: 88, vid: 12411, title: "文学少女 1 渴望死亡的小丑" }, { nid: 88, vid: 12421, title: "文学少女 2 渴求真爱的幽灵" }] } : undefined;
    expect(data).toBeDefined();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });
  await page.goto("/#/resources?type=novel&provider=lnovel");
  await page.getByRole("searchbox").fill("野村美月");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  const choice = page.locator(".resource-work-card").filter({ has: page.getByRole("heading", { name: "文学少女", exact: true }) });
  await expect(choice).toContainText("野村美月");
  await choice.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page.locator(".subject-resource-item")).toHaveCount(2);
  await page.getByRole("link", { name: "← 返回资源搜索", exact: true }).click();
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  await choice.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page.locator(".subject-resource-item")).toHaveCount(2);
  expect(calls.filter((path) => path === "/api/bili/novels")).toHaveLength(1);
  expect(calls.filter((path) => path === "/api/bili/novel/88")).toHaveLength(1);
});
