import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

type Sort = "rating" | "recent";
const wall = (page: Page) => page.getByRole("region", { name: "Galgame 推荐封面墙", exact: true });
const title = (sort: Sort, index = 1) => `Galgame${sort === "recent" ? "新作" : "佳作"} ${String(index).padStart(2, "0")}`;
async function installGalgame(page: Page) {
  const calls: Array<{ sort: Sort; page: number; filters: unknown[] }> = [];
  const failures = new Set<Sort>();
  const gates = new Map<Sort, Promise<void>>();
  const subjects = new Map<string, Record<string, unknown>>();
  await page.route("https://api.vndb.org/kana/vn", async (route) => {
    const input = route.request().postDataJSON() as { filters: unknown[]; sort: string; reverse: boolean; results: number; page: number; fields: string };
    if (input.filters[0] === "id") {
      const subject = subjects.get(String(input.filters[2]));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: subject ? [{ ...subject, tags: [], developers: [], staff: [] }] : [], more: false }) });
    }
    const sort: Sort = input.sort === "released" ? "recent" : "rating";
    calls.push({ sort, page: input.page, filters: input.filters });
    expect(input.filters[0]).toBe("and"); expect(input.reverse).toBe(true); expect(input.results).toBe(24);
    expect(input.fields).toContain("sexual,violence");
    expect(input.filters).toContainEqual(["or", ["lang", "=", "zh-Hans"], ["lang", "=", "zh-Hant"]]);
    const gate = gates.get(sort); if (gate) await gate;
    if (failures.has(sort)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "固定 Galgame 目录不可用" }) });
    const total = 49;
    const offset = (input.page - 1) * input.results;
    const data = Array.from({ length: Math.max(0, Math.min(input.results, total - offset)) }, (_, index) => {
      const position = offset + index + 1;
      const id = `v${70000 + (sort === "recent" ? 100 : 0) + position}`;
      const subject = { id, title: `Original ${sort} ${position}`, alttitle: `原作 ${position}`, titles: [{ title: title(sort, position), lang: "zh-Hans", official: false, main: false }],
        aliases: [], olang: "ja", released: "2026-07-01", languages: ["ja", "zh-Hans"], platforms: ["win"],
        image: { url: `https://s.vndb.org/e2e-gal/${sort}/${position}.jpg`, sexual: position === 2 ? 1 : 0, violence: 0 },
        description: "选择属于自己的故事路线。固定作品介绍与封面，用于验证发现到详情的实际操作。", rating: 88, votecount: 1000 };
      subjects.set(id, subject); return subject;
    });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: data, more: offset + input.results < total }) });
  });
  return { calls, failures, gates };
}

test.use({ timezoneId: "Asia/Shanghai" });

test("Galgame has real paginated recommendations, usable details and collection, and hides flagged cover images", async ({ page }) => {
  const network = await installGalgame(page);
  await page.clock.setFixedTime(new Date("2026-10-31T04:00:00Z"));
  await page.goto("/#/?type=visual_novel");
  const catalog = wall(page);
  await expect(catalog.locator(".subject-name")).toHaveCount(24);
  await expect(catalog.locator(".subject-score").first()).toHaveText("★ 8.8");
  await expect(catalog.locator(".subject-card").nth(1).locator("img")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Galgame 精选", exact: true })).toBeVisible();
  await expect(catalog).toContainText("中文可用包含官方与民间翻译");
  await page.getByRole("button", { name: "加载更多 Galgame", exact: true }).click();
  await expect(catalog.locator(".subject-name")).toHaveCount(48);
  await page.getByRole("button", { name: "加载更多 Galgame", exact: true }).click();
  await expect(catalog.locator(".subject-name")).toHaveCount(49);
  await expect(page.getByRole("button", { name: "加载更多 Galgame", exact: true })).toHaveCount(0);
  expect(network.calls.map((call) => call.page)).toEqual([1, 2, 3]);
  await catalog.getByRole("button", { name: "收藏" + title("rating"), exact: true }).click();
  await expect(catalog.getByRole("button", { name: "取消收藏" + title("rating"), exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Galgame 精选", exact: true }).getByRole("link", { name: "探索这部作品", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/vndb/);
  await expect(page.getByRole("heading", { name: title("rating"), exact: true })).toBeVisible();
  await page.goBack();
  await expect(catalog.getByRole("link", { name: title("rating"), exact: true })).toBeVisible();
  await page.screenshot({ path: ".work/e2e/galgame-discovery.png", fullPage: true, animations: "disabled" });
});

test("Galgame sort and history restore correctly and abandoned requests cannot overwrite the active wall", async ({ page }) => {
  const network = await installGalgame(page);
  await page.goto("/#/?type=visual_novel");
  await expect(wall(page).locator(".subject-name")).toHaveCount(24);
  let release!: () => void;
  network.gates.set("recent", new Promise<void>((resolve) => { release = resolve; }));
  const selector = page.getByRole("combobox", { name: "Galgame 推荐排序", exact: true });
  await selector.selectOption("recent");
  await expect.poll(() => network.calls.some((call) => call.sort === "recent")).toBe(true);
  await selector.selectOption("rating");
  await expect(wall(page).getByRole("link", { name: title("rating"), exact: true })).toBeVisible();
  release(); network.gates.delete("recent");
  await expect(wall(page).getByText(title("recent"), { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(selector).toHaveValue("recent");
  await expect(wall(page).getByRole("link", { name: title("recent"), exact: true })).toBeVisible();
  await expect(page).toHaveURL(/galSort=recent/);
  await page.reload();
  await expect(selector).toHaveValue("recent");
  await expect(wall(page).getByRole("link", { name: title("recent"), exact: true })).toBeVisible();
  await page.setViewportSize({ width: 760, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("region", { name: "Galgame 精选", exact: true }).getByRole("link", { name: "探索这部作品", exact: true })).toBeVisible();
});

test("Galgame errors have a working retry and failed refresh retains only the matching list", async ({ page }) => {
  const network = await installGalgame(page);
  network.failures.add("rating");
  await page.goto("/#/?type=visual_novel");
  await expect(page.getByRole("heading", { name: "Galgame 推荐暂时未能加载", exact: true })).toBeVisible();
  await expect(wall(page).locator(".subject-name")).toHaveCount(0);
  network.failures.clear();
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(wall(page).locator(".subject-name")).toHaveCount(24);
  network.failures.add("rating");
  await page.getByRole("button", { name: "刷新 Galgame 推荐", exact: true }).click();
  await expect(wall(page).getByRole("status")).toContainText("保留上次加载的目录");
  await expect(wall(page).getByRole("link", { name: title("rating"), exact: true })).toBeVisible();
  network.failures.add("recent");
  await page.getByRole("combobox", { name: "Galgame 推荐排序", exact: true }).selectOption("recent");
  await expect(page.getByRole("heading", { name: "Galgame 推荐暂时未能加载", exact: true })).toBeVisible();
  await expect(wall(page).getByRole("status")).toHaveCount(0);
  await expect(wall(page).locator(".subject-name")).toHaveCount(0);
  network.failures.clear();
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(wall(page).getByRole("link", { name: title("recent"), exact: true })).toBeVisible();
});

test("Galgame recommendations refresh on focus after expiry, recover online, and advance the original-release date window", async ({ page }) => {
  const network = await installGalgame(page);
  await page.clock.setFixedTime(new Date("2026-10-31T04:00:00Z"));
  await page.goto("/#/?type=visual_novel&galSort=recent");
  await expect(wall(page).locator(".subject-name")).toHaveCount(24);
  expect(network.calls[0].filters).toContainEqual(["released", ">=", "2024-10-31"]);
  await page.clock.setFixedTime(new Date("2026-10-31T04:31:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => network.calls.length).toBe(2);
  await expect(wall(page).locator("time")).toHaveAttribute("datetime", "2026-10-31T04:31:00.000Z");
  network.failures.add("recent");
  await page.clock.setFixedTime(new Date("2026-10-31T05:02:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(wall(page).getByRole("status")).toContainText("保留上次加载的目录");
  network.failures.clear();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(wall(page).getByRole("status")).toHaveCount(0);
  await expect(wall(page).locator("time")).toHaveAttribute("datetime", "2026-10-31T05:02:00.000Z");
  await page.clock.setFixedTime(new Date("2026-11-01T05:03:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => network.calls.at(-1)?.filters).toContainEqual(["released", ">=", "2024-11-01"]);
  await expect(wall(page).locator("time")).toHaveAttribute("datetime", "2026-11-01T05:03:00.000Z");
});
