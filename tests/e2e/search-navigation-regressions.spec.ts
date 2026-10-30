import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

interface SearchCall { keyword: string; type: number }
async function searchFixtures(page: Page, gate?: { wait: Promise<void> }): Promise<SearchCall[]> {
  const calls: SearchCall[] = [];
  await page.route("https://api.bgm.tv/v0/search/subjects**", async (route) => {
    const input = route.request().postDataJSON() as { keyword: string; filter: { type: number[] } };
    const type = input.filter.type[0];
    calls.push({ keyword: input.keyword, type });
    if (gate && type === 2) await gate.wait;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 1, limit: 30, offset: 0, data: [{
      id: type === 2 ? 12345 : 12346,
      type, name: input.keyword, name_cn: input.keyword, date: "2026-10-01", platform: type === 2 ? "TV" : "漫画", summary: "固定导航测试资料",
      tags: type === 2 ? [] : [{ name: "漫画", count: 10 }], images: { large: "https://lain.bgm.tv/search-navigation.jpg" }, rating: { score: "8.7" },
    }] }) });
  });
  return calls;
}

function result(page: Page, title: string) {
  return page.locator(".poster-results-grid").getByRole("link", { name: "查看" + title, exact: true });
}

test("manual classification and trimmed search survive detail return and history navigation", async ({ page }) => {
  const calls = await searchFixtures(page);
  await page.goto("/#/search?q=旧作品&type=anime");
  await expect(result(page, "旧作品")).toBeVisible();
  await page.locator(".search-type-tabs").getByRole("button", { name: "漫画", exact: true }).click();
  await expect(page).toHaveURL(/type=manga/);
  await expect(page.locator(".poster-results-grid .subject-type")).toHaveText("漫画");
  await page.getByRole("searchbox", { name: "漫画名称", exact: true }).fill("  新漫画  ");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(result(page, "新漫画")).toBeVisible();
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("q")).toBe("新漫画");
  await expect(page).toHaveURL(/type=manga/);
  expect(calls.filter((call) => call.keyword === "新漫画")).toHaveLength(1);
  await result(page, "新漫画").click();
  await expect(page).toHaveURL(/#\/media\//);
  await expect(page.getByRole("heading", { name: "新漫画", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "漫画名称", exact: true })).toHaveValue("新漫画");
  await expect(result(page, "新漫画")).toBeVisible();
  expect(calls.filter((call) => call.keyword === "新漫画")).toHaveLength(1);
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "漫画名称", exact: true })).toHaveValue("旧作品");
  await expect(result(page, "旧作品")).toBeVisible();
  await expect(result(page, "新漫画")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("searchbox", { name: "漫画名称", exact: true })).toHaveValue("新漫画");
  await expect(result(page, "新漫画")).toBeVisible();
  await expect(result(page, "旧作品")).toHaveCount(0);
});

test("switching classification while a request is slow ignores its late results", async ({ page }) => {
  let release = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const calls = await searchFixtures(page, { wait });
  await page.goto("/#/search?q=慢作品&type=anime");
  await expect.poll(() => calls.length).toBe(1);
  await page.locator(".search-type-tabs").getByRole("button", { name: "漫画", exact: true }).click();
  await expect(result(page, "慢作品")).toBeVisible();
  await expect(page.locator(".poster-results-grid .subject-type")).toHaveText("漫画");
  release();
  await expect(page.getByRole("button", { name: "搜索", exact: true })).toBeEnabled();
  await page.waitForTimeout(150);
  await expect(page.locator(".poster-results-grid .subject-type")).toHaveText("漫画");
  await expect(page.getByRole("searchbox", { name: "漫画名称", exact: true })).toHaveValue("慢作品");
  expect(calls).toEqual([{ keyword: "慢作品", type: 2 }, { keyword: "慢作品", type: 1 }]);
});

test("prototype names and other unknown classifications safely use anime", async ({ page }) => {
  const calls = await searchFixtures(page);
  for (const invalid of ["__proto__", "toString", "not-a-category"]) {
    await page.goto(`/#/search?q=安全作品&type=${invalid}`);
    await expect(page.getByRole("searchbox", { name: "动画名称", exact: true })).toHaveValue("安全作品");
    await expect(result(page, "安全作品")).toBeVisible();
    await expect(page).toHaveURL(/type=anime/);
  }
  // All invalid names resolve to the same canonical query; reuse its valid cache.
  expect(calls).toEqual([{ keyword: "安全作品", type: 2 }]);
});
