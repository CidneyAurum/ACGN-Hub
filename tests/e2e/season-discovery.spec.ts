import { mkdir } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, seasonAnimeTitle } from "./fixtures";

test.use({ timezoneId: "Asia/Shanghai" });
test.beforeAll(async () => { await mkdir(".work/e2e", { recursive: true }); });

const seasonWall = (page: Page) =>
  page.getByRole("region", { name: /^季度新番(?:封面墙)?$/ });

test("season discovery defaults to the current quarter, paginates, and changes its wall when the user selects a past quarter", async ({ page, mockNetwork }) => {
  mockNetwork.seasonNamesByQuarter = true;
  await page.clock.setFixedTime(new Date("2026-10-30T04:00:00Z"));
  await page.goto("/");
  const selector = page.getByRole("combobox", { name: "番剧季度", exact: true });
  const wall = seasonWall(page);
  await expect(selector).toHaveValue("2026-Q4");
  await expect(wall.locator(".subject-name")).toHaveCount(24);
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 4), exact: true })).toBeVisible();
  expect(mockNetwork.seasonCalls[0]).toEqual({ key: "2026-Q4", startDate: "2026-10-01", endDate: "2027-01-01", limit: 20, offset: 0 });
  await page.getByRole("button", { name: "加载更多新番", exact: true }).click();
  await expect(wall.locator(".subject-name")).toHaveCount(48);
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 4, 48), exact: true })).toBeVisible();
  expect(mockNetwork.seasonCalls.filter((request) => request.key === "2026-Q4").map(({ limit, offset }) => ({ limit, offset }))).toEqual([
    { limit: 20, offset: 0 }, { limit: 4, offset: 20 }, { limit: 20, offset: 24 }, { limit: 4, offset: 44 },
  ]);
  await page.getByRole("button", { name: "加载更多新番", exact: true }).click();
  await expect(wall.locator(".subject-name")).toHaveCount(49);
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 4, 49), exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "加载更多新番", exact: true })).toHaveCount(0);
  expect(mockNetwork.seasonCalls.filter((request) => request.key === "2026-Q4").at(-1)).toMatchObject({ limit: 20, offset: 48 });
  await selector.selectOption("2026-Q3");
  await expect(wall.locator(".subject-name")).toHaveCount(24);
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 3), exact: true })).toBeVisible();
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 4), exact: true })).toHaveCount(0);
  expect(mockNetwork.seasonCalls.find((request) => request.key === "2026-Q3")).toMatchObject({ startDate: "2026-07-01", endDate: "2026-10-01", offset: 0 });
  await expect(page).toHaveURL(/season=2026-Q3/);
  await wall.getByRole("link", { name: "查看" + seasonAnimeTitle(2026, 3), exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/bangumi/);
  await page.goBack();
  await expect(selector).toHaveValue("2026-Q3");
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 3), exact: true })).toBeVisible();

  // Looking at an older quarter is deliberate; a clock change must preserve it.
  await page.clock.setFixedTime(new Date("2027-01-01T00:01:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(selector).toHaveValue("2026-Q3");
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 3), exact: true })).toBeVisible();
  await page.getByRole("button", { name: "回到本季", exact: true }).click();
  await expect(selector).toHaveValue("2027-Q1");
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2027, 1), exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).not.toContain("season=");
  await page.screenshot({ path: ".work/e2e/season-selected-and-returned.png", fullPage: true, animations: "disabled" });
});

test("following the current quarter updates to the new year on focus without reloading the app", async ({ page, mockNetwork }) => {
  mockNetwork.seasonNamesByQuarter = true;
  await page.clock.setFixedTime(new Date("2026-12-31T15:59:40Z"));
  await page.goto("/");
  const selector = page.getByRole("combobox", { name: "番剧季度", exact: true });
  const wall = seasonWall(page);
  await expect(selector).toHaveValue("2026-Q4");
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 4), exact: true })).toBeVisible();
  await page.clock.setFixedTime(new Date("2026-12-31T16:00:05Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(selector).toHaveValue("2027-Q1");
  await expect(wall.locator(".subject-name")).toHaveCount(24);
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2027, 1), exact: true })).toBeVisible();
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 4), exact: true })).toHaveCount(0);
  expect(mockNetwork.seasonCalls.find((request) => request.key === "2027-Q1")).toMatchObject({ startDate: "2027-01-01", endDate: "2027-04-01", offset: 0 });
  await expect(page.getByRole("button", { name: "回到本季", exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".work/e2e/season-new-year-auto-follow.png", fullPage: true, animations: "disabled" });
});

test("refresh failure reuses only the selected quarter cache and never presents another quarter as a fallback", async ({ page, mockNetwork }) => {
  mockNetwork.seasonNamesByQuarter = true;
  await page.clock.setFixedTime(new Date("2026-10-30T04:00:00Z"));
  await page.goto("/");
  const selector = page.getByRole("combobox", { name: "番剧季度", exact: true });
  const wall = seasonWall(page);
  await expect(wall.locator(".subject-name")).toHaveCount(24);
  mockNetwork.seasonFailures.add("2026-Q4");
  await page.getByRole("button", { name: "刷新季度", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "网络暂不可用" })).toContainText("2026年10月·秋季");
  await expect(page.getByRole("status").filter({ hasText: "网络暂不可用" })).toContainText("已保存目录");
  await expect(wall.getByRole("link", { name: seasonAnimeTitle(2026, 4), exact: true })).toBeVisible();
  mockNetwork.seasonFailures.add("2026-Q3");
  await selector.selectOption("2026-Q3");
  await expect(page.getByRole("heading", { name: "季度新番暂时未能加载", exact: true })).toBeVisible();
  await expect(wall.locator(".subject-name")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "热门番剧", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "已保存目录" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "每周放送", exact: true })).toBeVisible();
  expect(mockNetwork.seasonCalls.filter((request) => request.key === "2026-Q4")).toHaveLength(3);
  expect(mockNetwork.seasonCalls.filter((request) => request.key === "2026-Q3")).toHaveLength(1);
  await page.screenshot({ path: ".work/e2e/season-cache-quarter-boundary.png", fullPage: true, animations: "disabled" });
});
