import { test, expect, openHome, animeTitle } from "./fixtures";
import type { Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 914, height: 411 }, { width: 320, height: 640 }]) {
  test(`phone navigation keeps all tools reachable at ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openHome(page);
    const navigation = page.getByRole("navigation", { name: "手机主导航", exact: true });
    await expect(navigation).toBeVisible();
    await expect(page.locator(".anime-sidebar")).toBeHidden();
    await expectNoHorizontalOverflow(page);
    const more = navigation.getByRole("button", { name: "更多", exact: true });
    await more.click();
    const tools = page.getByRole("dialog", { name: "我的工具", exact: true });
    await expect(tools).toBeVisible();
    await expect(tools.getByRole("link")).toHaveCount(6);
    await page.keyboard.press("Escape");
    await expect(tools).toBeHidden();
    await expect(more).toBeFocused();
    await more.click();
    await tools.getByRole("link", { name: "来源管理", exact: true }).click();
    await expect(page).toHaveURL(/#\/sources$/);
    await expect(tools).toBeHidden();
    await expectNoHorizontalOverflow(page);
    await navigation.getByRole("link", { name: "找资源", exact: true }).click();
    await expect(page.getByRole("heading", { name: "找资源，先选对作品。", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await navigation.getByRole("link", { name: "下载", exact: true }).click();
    await expect(page.getByRole("heading", { name: "下载中心", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await more.click();
    await tools.getByRole("link", { name: "设置与数据迁移", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "保存设置", exact: true }).scrollIntoViewIfNeeded();
    const savebar = await page.locator(".settings-savebar").boundingBox();
    const navbox = await navigation.boundingBox();
    expect(savebar).not.toBeNull(); expect(navbox).not.toBeNull();
    expect(savebar!.y + savebar!.height).toBeLessThanOrEqual(navbox!.y);
  });
}

test("phone global search and real result links stay usable without losing the desktop layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page);
  await page.getByRole("textbox", { name: "全局搜索作品", exact: true }).fill(animeTitle);
  await page.getByRole("textbox", { name: "全局搜索作品", exact: true }).press("Enter");
  await expect(page.locator(".poster-results-grid .subject-name")).toHaveText(animeTitle);
  await expectNoHorizontalOverflow(page);
  await page.locator(".poster-results-grid .subject-name").click();
  await expect(page.getByRole("heading", { name: animeTitle, exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole("navigation", { name: "手机主导航", exact: true })).toBeHidden();
  await expect(page.locator(".anime-sidebar")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
