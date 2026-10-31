import { mkdir } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

type Kind = "manga" | "novel";
type Sort = "heat" | "score" | "recent";
const names = { manga: "漫画", novel: "轻小说" };
const sorts = { heat: "热门", score: "高分", recent: "近一年" };
const title = (kind: Kind, sort: Sort, index = 1) => `${names[kind]}${sorts[sort]}作品 ${String(index).padStart(2, "0")}`;
const wall = (page: Page, kind: Kind) => page.getByRole("region", { name: names[kind] + "推荐封面墙", exact: true });

async function installBooks(page: Page) {
  const calls: Array<{ kind: Kind; sort: Sort; offset: number; limit: number; dates?: string[] }> = [];
  const gates = new Map<string, Promise<void>>();
  const failures = new Set<string>();
  const subjects = new Map<number, Record<string, unknown>>();
  await page.route("https://api.bgm.tv/v0/search/subjects?*", async (route) => {
    const input = route.request().postDataJSON() as { sort: string; keyword: string; filter: { type?: number[]; tag?: string[]; air_date?: string[]; rating_count?: string[]; nsfw?: boolean } };
    if (input.filter?.type?.[0] !== 1) return route.fallback();
    const kind: Kind = input.filter.tag?.[0] === "轻小说" ? "novel" : "manga";
    const sort: Sort = input.sort === "score" ? "score" : input.filter.air_date ? "recent" : "heat";
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    calls.push({ kind, sort, offset, limit, ...(input.filter.air_date ? { dates: input.filter.air_date } : {}) });
    expect(input.keyword).toBe(""); expect(input.filter.nsfw).toBe(false);
    if (sort === "score") expect(input.filter.rating_count).toEqual([">=50"]);
    const key = `${kind}:${sort}`;
    const batchKey = `${key}:offset${offset}`;
    const gate = gates.get(batchKey) ?? gates.get(key); if (gate) await gate;
    if (failures.has(key) || failures.has(batchKey)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "固定书籍目录暂不可用" }) });
    const total = 49;
    const base = (kind === "manga" ? 810000 : 820000) + (["heat", "score", "recent"].indexOf(sort) * 1000);
    const data = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => {
      const position = offset + index + 1;
      const subject = { id: base + position, type: 1, name: `Original ${kind} ${sort} ${position}`, name_cn: title(kind, sort, position), date: "2026-07-01", platform: names[kind], nsfw: false,
        summary: `${names[kind]}的固定故事介绍。封面、详情和作品分类应始终对应当前书架，切换后不会混入其它列表。`,
        images: { large: `https://lain.bgm.tv/e2e-book/${kind}/${sort}/${position}.jpg` },
        rating: { score: 8.7, total: 1000 }, tags: [{ name: names[kind], count: 200 }, { name: "奇幻", count: 80 }], collection: { doing: 700 } };
      subjects.set(subject.id, subject); return subject;
    });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total, limit, offset, data }) });
  });
  await page.route(/https:\/\/api\.bgm\.tv\/v0\/subjects\/8\d+$/, async (route) => {
    const subject = subjects.get(Number(new URL(route.request().url()).pathname.split("/").at(-1)));
    if (!subject) return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(subject) });
  });
  return { calls, gates, failures };
}

test.use({ timezoneId: "Asia/Shanghai" });
test.beforeAll(async () => { await mkdir(".work/e2e", { recursive: true }); });

test("manga and light novels have genuine recommendation walls, pagination, usable featured details, and restorable URLs", async ({ page }) => {
  const network = await installBooks(page);
  await page.clock.setFixedTime(new Date("2026-10-30T04:00:00Z"));
  await page.goto("/#/?type=manga");
  const manga = wall(page, "manga");
  await expect(page.getByRole("button", { name: "漫画", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "漫画精选", exact: true })).toBeVisible();
  await expect(manga.locator(".subject-name")).toHaveCount(24);
  await expect(manga.locator(".media-poster img").first()).toBeVisible();
  await expect(page.getByText("这里还没有收藏。搜索一部喜欢的作品，从第一本开始。", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".work/e2e/book-discovery-manga.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "加载更多漫画", exact: true }).click();
  await expect(manga.locator(".subject-name")).toHaveCount(48);
  await page.getByRole("button", { name: "加载更多漫画", exact: true }).click();
  await expect(manga.locator(".subject-name")).toHaveCount(49);
  await expect(page.getByRole("button", { name: "加载更多漫画", exact: true })).toHaveCount(0);
  expect(network.calls.filter((call) => call.kind === "manga").map(({ offset, limit }) => ({ offset, limit }))).toEqual([
    { offset: 0, limit: 20 }, { offset: 20, limit: 4 }, { offset: 24, limit: 20 }, { offset: 44, limit: 4 }, { offset: 48, limit: 20 },
  ]);
  await page.getByRole("combobox", { name: "漫画推荐排序", exact: true }).selectOption("score");
  await expect(manga.locator(".subject-name")).toHaveCount(24);
  await expect(manga.getByRole("link", { name: title("manga", "score"), exact: true })).toBeVisible();
  await expect(page).toHaveURL(/type=manga&bookSort=score/);
  await page.getByRole("region", { name: "漫画精选", exact: true }).getByRole("link", { name: "探索这部作品", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/bangumi/);
  await expect(page.getByRole("heading", { name: title("manga", "score"), exact: true })).toBeVisible();
  const remembered = await page.evaluate(() => JSON.parse(sessionStorage.getItem("acgn-hub.search-session.v1") ?? "{}") as Record<string, { media: { title: string } }>);
  expect(Object.values(remembered).some((value) => value.media.title === title("manga", "score"))).toBe(true);
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "漫画推荐排序", exact: true })).toHaveValue("score");
  await expect(manga.getByRole("link", { name: title("manga", "score"), exact: true })).toBeVisible();
  await page.getByRole("button", { name: "轻小说", exact: true }).click();
  await expect(wall(page, "novel").locator(".subject-name")).toHaveCount(24);
  await expect(page.getByRole("region", { name: "轻小说精选", exact: true })).toBeVisible();
  await page.screenshot({ path: ".work/e2e/book-discovery-novel.png", fullPage: true, animations: "disabled" });
  await page.reload();
  await expect(page.getByRole("button", { name: "轻小说", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("combobox", { name: "轻小说推荐排序", exact: true })).toHaveValue("score");
  await expect(wall(page, "novel").getByRole("link", { name: title("novel", "score"), exact: true })).toBeVisible();
});

test("abandoned category and sorting requests cannot leak into the active wall, including browser history", async ({ page }) => {
  const network = await installBooks(page);
  await page.goto("/#/?type=manga");
  await expect(wall(page, "manga").locator(".subject-name")).toHaveCount(24);
  let release!: () => void;
  network.gates.set("manga:score", new Promise<void>((resolve) => { release = resolve; }));
  await page.getByRole("combobox", { name: "漫画推荐排序", exact: true }).selectOption("score");
  await expect.poll(() => network.calls.some((call) => call.kind === "manga" && call.sort === "score")).toBe(true);
  await page.getByRole("button", { name: "轻小说", exact: true }).click();
  const novels = wall(page, "novel");
  await expect(novels.getByRole("link", { name: title("novel", "score"), exact: true })).toBeVisible();
  release(); network.gates.delete("manga:score");
  await expect(novels.locator(".subject-name")).toHaveCount(24);
  await expect(novels.getByText(title("manga", "score"), { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "漫画推荐排序", exact: true })).toHaveValue("score");
  await expect(wall(page, "manga").getByRole("link", { name: title("manga", "score"), exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "漫画推荐排序", exact: true })).toHaveValue("heat");
  await expect(wall(page, "manga").getByRole("link", { name: title("manga", "heat"), exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("combobox", { name: "漫画推荐排序", exact: true })).toHaveValue("score");
  await expect(wall(page, "manga").getByRole("link", { name: title("manga", "score"), exact: true })).toBeVisible();
});

test("failed refresh preserves only the matching book cache and an uncached sort offers a working retry", async ({ page }) => {
  const network = await installBooks(page);
  await page.clock.setFixedTime(new Date("2026-10-30T04:00:00Z"));
  await page.goto("/#/?type=novel");
  const novels = wall(page, "novel");
  await expect(novels.locator(".subject-name")).toHaveCount(24);
  network.failures.add("novel:heat");
  await page.getByRole("button", { name: "刷新轻小说推荐", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("网络暂不可用");
  await expect(novels.getByRole("link", { name: title("novel", "heat"), exact: true })).toBeVisible();
  network.failures.add("novel:recent");
  await page.getByRole("combobox", { name: "轻小说推荐排序", exact: true }).selectOption("recent");
  await expect(page.getByRole("heading", { name: "轻小说推荐暂时未能加载", exact: true })).toBeVisible();
  await expect(novels.locator(".subject-name")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "轻小说精选", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
  network.failures.delete("novel:recent");
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(novels.locator(".subject-name")).toHaveCount(24);
  await expect(novels.getByRole("link", { name: title("novel", "recent"), exact: true })).toBeVisible();
  await expect(novels.getByRole("heading", { name: /近一年热门/ })).toBeVisible();
});

test("first novel books render before the last batch and a partial page can be completed before advancing", async ({ page }) => {
  const network = await installBooks(page);
  let release!: () => void;
  network.gates.set("novel:heat:offset8", new Promise<void>((resolve) => { release = resolve; }));
  await page.goto("/#/?type=novel");
  const novels = wall(page, "novel");
  await expect(novels.locator(".subject-name")).toHaveCount(8);
  await expect(page.getByRole("region", { name: "轻小说精选", exact: true })).toBeVisible();
  await expect(novels.getByRole("status")).toContainText("已显示首批推荐");
  network.failures.add("novel:heat:offset8");
  release(); network.gates.delete("novel:heat:offset8");
  await expect(page.getByRole("button", { name: "补全本页", exact: true })).toBeEnabled();
  await expect(novels.locator(".subject-name")).toHaveCount(8);
  network.failures.delete("novel:heat:offset8");
  await page.getByRole("button", { name: "补全本页", exact: true }).click();
  await expect(novels.locator(".subject-name")).toHaveCount(24);
  await page.getByRole("button", { name: "加载更多轻小说", exact: true }).click();
  await expect(novels.locator(".subject-name")).toHaveCount(48);
  expect(await novels.locator(".subject-name").allTextContents()).toEqual(Array.from({ length: 48 }, (_, index) => title("novel", "heat", index + 1)));
  expect(network.calls.filter((call) => call.kind === "novel").map(({ offset, limit }) => ({ offset, limit }))).toEqual([
    { offset: 0, limit: 8 }, { offset: 8, limit: 16 }, { offset: 0, limit: 8 }, { offset: 8, limit: 16 }, { offset: 24, limit: 20 }, { offset: 44, limit: 4 },
  ]);
});

test("discovery remains usable on a narrow window and past-quarter history follows its URL", async ({ page, mockNetwork }) => {
  await installBooks(page);
  await page.clock.setFixedTime(new Date("2026-10-30T04:00:00Z"));
  mockNetwork.seasonNamesByQuarter = true;
  await page.goto("/#/?season=2026-Q3");
  const season = page.getByRole("combobox", { name: "番剧季度", exact: true });
  await expect(season).toHaveValue("2026-Q3");
  await expect(page.getByRole("region", { name: "季度新番", exact: true }).locator(".subject-name")).toHaveCount(24);
  await season.selectOption("2026-Q2");
  await expect(season).toHaveValue("2026-Q2");
  await page.goBack();
  await expect(season).toHaveValue("2026-Q3");
  await expect(page.getByRole("region", { name: "季度新番", exact: true }).getByText("2026年Q3新番 01", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "漫画", exact: true }).click();
  await expect(wall(page, "manga").locator(".subject-name")).toHaveCount(24);
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.getByRole("combobox", { name: "漫画推荐排序", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "漫画精选", exact: true }).getByRole("link", { name: "探索这部作品", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ".work/e2e/book-discovery-narrow.png", fullPage: true, animations: "disabled" });
});

test("book recommendations refresh after expiry, recover when online, and advance the recent-release date window", async ({ page }) => {
  const network = await installBooks(page);
  await page.clock.setFixedTime(new Date("2026-10-30T04:00:00Z"));
  await page.goto("/#/?type=manga");
  await expect(wall(page, "manga").locator(".subject-name")).toHaveCount(24);
  expect(network.calls).toHaveLength(2);
  await page.clock.setFixedTime(new Date("2026-10-30T04:31:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => network.calls.length).toBe(4);
  await expect(wall(page, "manga").locator("time")).toHaveAttribute("datetime", "2026-10-30T04:31:00.000Z");
  network.failures.add("manga:heat");
  await page.clock.setFixedTime(new Date("2026-10-30T05:02:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(wall(page, "manga").getByRole("status")).toContainText("网络暂不可用");
  await expect(wall(page, "manga").locator("time")).toHaveAttribute("datetime", "2026-10-30T04:31:00.000Z");
  network.failures.delete("manga:heat");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(wall(page, "manga").getByRole("status")).toHaveCount(0);
  await expect(wall(page, "manga").locator("time")).toHaveAttribute("datetime", "2026-10-30T05:02:00.000Z");
  await page.getByRole("combobox", { name: "漫画推荐排序", exact: true }).selectOption("recent");
  await expect(wall(page, "manga").getByRole("link", { name: title("manga", "recent"), exact: true })).toBeVisible();
  expect(network.calls.filter((call) => call.sort === "recent")[0].dates).toEqual([">=2025-10-30", "<2026-10-31"]);
  await page.clock.setFixedTime(new Date("2026-10-31T05:03:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => network.calls.filter((call) => call.sort === "recent").at(-1)?.dates).toEqual([">=2025-10-31", "<2026-11-01"]);
  await expect(wall(page, "manga").locator("time")).toHaveAttribute("datetime", "2026-10-31T05:03:00.000Z");
});
