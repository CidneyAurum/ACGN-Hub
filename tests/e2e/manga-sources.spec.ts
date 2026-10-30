import { mkdir } from "node:fs/promises";
import { test, expect, mangaSourceFixtures } from "./fixtures";

test.beforeAll(async () => { await mkdir(".work/e2e", { recursive: true }); });

test("fresh source management offers MangaBZ with accurate fields and excludes removed source types after reload", async ({ page }) => {
  await page.goto("/#/sources");
  const typeSelect = page.getByRole("combobox", { name: "来源类型", exact: true });
  await expect(typeSelect.locator('option[value="weebcentral"], option[value="kuaikan"]')).toHaveCount(0);
  await expect(page.locator("article.source-row").filter({ hasText: /WeebCentral|快看/ })).toHaveCount(0);
  await typeSelect.selectOption("mangabz");
  await expect(page.getByLabel("MangaBZ 网站地址", { exact: true })).toHaveValue("https://mangabz.com");
  await expect(page.getByLabel("MangaBZ 网站地址", { exact: true })).toHaveAttribute("placeholder", "https://mangabz.com");
  const row = page.locator("article.source-row").filter({ has: page.getByRole("heading", { name: mangaSourceFixtures.mangabz.sourceName, exact: true }) });
  await expect(row).toContainText("已停用");
  await row.getByRole("button", { name: "启用", exact: true }).click();
  await expect(row).toContainText("已启用");
  await page.reload();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") || "[]"));
  expect(stored.find((source: { id: string }) => source.id === "builtin:mangabz")).toMatchObject({ type: "mangabz", enabled: true });
  expect(stored.some((source: { type: string }) => ["weebcentral", "kuaikan"].includes(source.type))).toBe(false);
  await expect(row.getByRole("button", { name: "停用", exact: true })).toBeVisible();
  await expect(typeSelect.locator('option[value="weebcentral"], option[value="kuaikan"]')).toHaveCount(0);
  await page.goto("/#/resources?type=manga");
  await expect(page.getByRole("combobox")).toHaveValue("builtin:mangabz");
  expect((await page.getByRole("combobox").locator("option").allTextContents()).join(" ")).not.toMatch(/WeebCentral|快看/i);
  await expect(page.getByRole("combobox").locator('option[value="builtin:weebcentral"], option[value="builtin:kuaikan"]')).toHaveCount(0);
  await page.screenshot({ path: ".work/e2e/mangabz-source-options.png", fullPage: true, animations: "disabled" });
});

test("upgrading a previous source profile retires removed types without changing the user's MangaBZ settings", async ({ page, mockNetwork }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("e2e.previous-manga-profile") === "1") return;
    const stamp = "2026-10-29T10:00:00.000Z";
    const source = (id: string, type: string, name: string, url: string) => ({ id, type, name, url, enabled: true, createdAt: stamp, updatedAt: stamp });
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([
      source("my:mangabz", "mangabz", "我的中文漫画", "https://mangabz.com"),
      source("builtin:weebcentral", "weebcentral", "WeebCentral · 英文漫画", "https://weebcentral.com"),
      source("my:weebcentral", "weebcentral", "我的英文源", "https://weebcentral.com"),
      source("builtin:kuaikan", "kuaikan", "快看 · 官方免费章节", "https://www.kuaikanmanhua.com"),
    ]));
    localStorage.setItem("acgn-hub.resource-source-migration.v17", "1");
    localStorage.setItem("e2e.previous-manga-profile", "1");
  });
  await page.goto("/#/sources");
  const keptRow = page.locator("article.source-row").filter({ has: page.getByRole("heading", { name: "我的中文漫画", exact: true }) });
  await expect(keptRow.getByRole("button", { name: "停用", exact: true })).toBeVisible();
  await expect(page.locator("article.source-row").filter({ hasText: /WeebCentral|快看|我的英文源/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "来源类型", exact: true }).locator('option[value="weebcentral"], option[value="kuaikan"]')).toHaveCount(0);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") || "[]").find((source: { id: string }) => source.id === "my:mangabz"));
  expect(kept).toMatchObject({ type: "mangabz", name: "我的中文漫画", url: "https://mangabz.com", enabled: true,
    createdAt: "2026-10-29T10:00:00.000Z", updatedAt: "2026-10-29T10:00:00.000Z" });
  await page.goto("/#/resources?type=manga");
  await expect(page.getByRole("combobox")).toHaveValue("my:mangabz");
  expect((await page.getByRole("combobox").locator("option").allTextContents()).join(" ")).not.toMatch(/WeebCentral|快看|我的英文源/i);
  await page.reload();
  await expect(page.getByRole("combobox")).toHaveValue("my:mangabz");
  await expect(page.getByRole("combobox").locator('option[value="builtin:weebcentral"], option[value="my:weebcentral"], option[value="builtin:kuaikan"]')).toHaveCount(0);
  expect(mockNetwork.sourceCalls).toEqual([]);
  await page.screenshot({ path: ".work/e2e/mangabz-upgraded-source-options.png", fullPage: true, animations: "disabled" });
});

test("MangaBZ exact source selection opens all 45 ordered chapters and restores the chosen work and source after reload", async ({ page, mockNetwork }) => {
  const fixture = mangaSourceFixtures.mangabz;
  await page.goto("/#/resources?type=manga&provider=mangabz");
  await expect(page.getByRole("combobox")).toHaveValue(fixture.presetId);
  await page.getByRole("searchbox").fill(fixture.title);
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  const candidate = page.locator("article.resource-work-card").filter({ has: page.getByRole("heading", { name: fixture.title, exact: true }) });
  await expect(candidate).toBeVisible();
  await expect(candidate.locator("img")).toBeVisible();
  await expect.poll(() => candidate.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(mockNetwork.sourceCalls).toEqual(["/search"]);
  // Cover selection exercises the user-visible action that previously failed.
  await candidate.getByRole("button", { name: `选择 ${fixture.title} 并查看资源`, exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  const detailUrl = page.url();
  await expect(page.getByRole("heading", { name: fixture.title, exact: true }).first()).toBeVisible();
  await expect(page.locator("#subject-resources")).toHaveAttribute("data-total", "45");
  await expect(page.locator(".subject-resource-item")).toHaveCount(40);
  await expect(page.locator(".subject-resource-item strong").first()).toHaveText(`${fixture.title} · 第1話`);
  await expect(page.locator(".subject-resource-item strong").last()).toHaveText(`${fixture.title} · 第40話`);
  await expect(page.locator(".subject-resource-item").first()).toContainText("中文");
  await expect(page.locator(".subject-resource-item").first()).toContainText("CBZ");
  await expect(page.locator(".subject-resource-item").first()).toContainText("39 页");
  await expect(page.locator(".subject-resource-item").first().getByRole("button", { name: /下载章节/ })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".subject-resource-item")).toHaveCount(5);
  await expect(page.locator(".subject-resource-item strong").first()).toHaveText(`${fixture.title} · 第41話`);
  await expect(page.locator(".subject-resource-item strong").last()).toHaveText(`${fixture.title} · 第45話`);
  await page.screenshot({ path: ".work/e2e/mangabz-last-chapters.png", fullPage: true, animations: "disabled" });
  await page.reload();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByRole("heading", { name: fixture.title, exact: true }).first()).toBeVisible();
  await expect(page.locator("#subject-resources")).toHaveAttribute("data-total", "45");
  const stored = await page.evaluate(() => ({
    sources: JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") || "[]"),
    works: JSON.parse(localStorage.getItem("acgn-hub.media-library.v1") || "[]"),
  }));
  expect(stored.sources.find((source: { id: string }) => source.id === fixture.presetId)).toMatchObject({ type: "mangabz", enabled: true });
  expect(stored.works).toEqual(expect.arrayContaining([expect.objectContaining({ title: fixture.title, metadata: expect.objectContaining({ sourceType: "mangabz", sourceItemId: "7020" }) })]));
  await expect(page.locator(".subject-resource-item")).toHaveCount(40);
  await expect(page.locator(".subject-resource-item strong").first()).toHaveText(`${fixture.title} · 第1話`);
  await expect(page.locator(".subject-resource-item strong").last()).toHaveText(`${fixture.title} · 第40話`);
  expect(mockNetwork.sourceCalls.filter((path) => path === "/search")).toHaveLength(1);
  await expect.poll(() => mockNetwork.sourceCalls.filter((path) => path === "/7020bz/").length).toBe(2);
  expect(mockNetwork.sourceCalls.some((path) => /chapterimage|^\/m\d+\//.test(path))).toBe(false);
  await page.screenshot({ path: ".work/e2e/mangabz-reloaded.png", fullPage: true, animations: "disabled" });
});

