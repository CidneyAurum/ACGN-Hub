import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const iruma = { id: 6207, name: "入間人間", short_summary: "轻小说作者", images: { large: "https://lain.bgm.tv/e2e-author/6207.jpg" },
  infobox: [{ key: "简体中文名", value: "入间人间" }] };
const secondAuthor = { id: 6208, name: "另一位作者", short_summary: "固定作者资料", images: null, infobox: [] };

const subjects = new Map<number, Record<string, unknown>>([
  [930001, { id: 930001, type: 1, name: "Adachi to Shimamura", name_cn: "安达与岛村", platform: "小说", summary: "两位高中生的日常故事。", date: "2013-03-10", nsfw: false,
    images: { large: "https://lain.bgm.tv/e2e-author/novel.jpg" }, tags: [{ name: "轻小说", count: 20 }], rating: { score: 8.4, total: 500 }, infobox: [] }],
  [930002, { id: 930002, type: 1, name: "Adachi to Shimamura Comic", name_cn: "安达与岛村 漫画版", platform: "漫画", summary: "漫画改编。", date: "2019-05-25", nsfw: false,
    images: { large: "https://lain.bgm.tv/e2e-author/manga.jpg" }, tags: [{ name: "漫画", count: 20 }], rating: { score: 8.2, total: 300 }, infobox: [] }],
  [930003, { id: 930003, type: 2, name: "Adachi and Shimamura Animation", name_cn: "安达与岛村 动画版", platform: "TV", summary: "动画改编。", images: { large: "https://lain.bgm.tv/e2e-author/anime.jpg" }, tags: [], infobox: [] }],
  [930004, { id: 930004, type: 1, name: "Another Story", name_cn: "来自另一作者的故事", platform: "小说", summary: "另一个故事。", date: "2021-01-01", nsfw: false,
    images: { large: "https://lain.bgm.tv/e2e-author/second.jpg" }, tags: [{ name: "轻小说", count: 20 }], infobox: [] }],
]);

const relations = new Map<number, Array<Record<string, unknown>>>([
  [6207, [
    { id: 930001, type: 1, name: "Adachi to Shimamura", name_cn: "安达与岛村", staff: "作者", image: "https://lain.bgm.tv/e2e-author/novel.jpg" },
    { id: 930001, type: 1, name: "Adachi to Shimamura", name_cn: "安达与岛村", staff: "原作", image: "https://lain.bgm.tv/e2e-author/novel.jpg" },
    { id: 930002, type: 1, name: "Adachi to Shimamura Comic", name_cn: "安达与岛村 漫画版", staff: "原作", image: "https://lain.bgm.tv/e2e-author/manga.jpg" },
    { id: 930003, type: 2, name: "Adachi and Shimamura Animation", name_cn: "安达与岛村 动画版", staff: "原作", image: "https://lain.bgm.tv/e2e-author/anime.jpg" },
  ]],
  [6208, [{ id: 930004, type: 1, name: "Another Story", name_cn: "来自另一作者的故事", staff: "作者", image: "https://lain.bgm.tv/e2e-author/second.jpg" }]],
]);

async function authorFixtures(page: Page) {
  const calls = { searches: [] as string[], people: [] as number[], works: [] as number[], details: [] as number[], titleSearches: [] as string[] };
  const gates = new Map<number, Promise<void>>();
  const emptyPeople = new Set<string>();
  const emptyWorks = new Set<number>();
  // Override only official person/relation/detail contracts. Parallel title
  // searches return no rows, proving author works came from the relations.
  await page.route("https://api.bgm.tv/v0/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/v0/search/persons") {
      expect(request.method()).toBe("POST");
      expect(url.searchParams.get("limit")).toBe("20");
      expect(url.searchParams.get("offset")).toBe("0");
      const body = request.postDataJSON() as { keyword: string };
      calls.searches.push(body.keyword);
      const noise = { id: 9999, name: "刘德华", infobox: [], images: null, short_summary: "与当前检索词无关的人物" };
      const data = emptyPeople.has(body.keyword) ? [] : body.keyword === secondAuthor.name ? [secondAuthor] : body.keyword === "入间人间" ? [iruma] : [noise];
      return json({ total: data.length, limit: 20, offset: 0, data });
    }
    const work = url.pathname.match(/^\/v0\/persons\/(\d+)\/subjects$/);
    if (work) {
      const id = Number(work[1]); calls.works.push(id);
      const gate = gates.get(id); if (gate) await gate;
      return json(emptyWorks.has(id) ? [] : relations.get(id) ?? []);
    }
    const person = url.pathname.match(/^\/v0\/persons\/(\d+)$/);
    if (person) { const id = Number(person[1]); calls.people.push(id); return json(id === iruma.id ? iruma : secondAuthor); }
    const detail = url.pathname.match(/^\/v0\/subjects\/(\d+)$/);
    if (detail && subjects.has(Number(detail[1]))) { const id = Number(detail[1]); calls.details.push(id); return json(subjects.get(id)); }
    if (/^\/v0\/subjects\/93000[1-4]\/(?:characters|persons)$/.test(url.pathname)) return json([]);
    if (url.pathname === "/v0/search/subjects") { calls.titleSearches.push(request.postData() ?? ""); return json({ total: 0, limit: 20, offset: 0, data: [] }); }
    return route.fallback();
  });
  return { calls, gates, emptyPeople, emptyWorks };
}

const works = (page: Page) => page.getByRole("region", { name: "作品搜索结果", exact: true });
const query = (page: Page) => new URLSearchParams(new URL(page.url()).hash.split("?")[1]);

test("typing an author directly lists actual works and preserves role, classification and history", async ({ page }) => {
  const network = await authorFixtures(page);
  await page.goto("/#/search?q=入间人间&type=novel");
  await expect(page.getByRole("searchbox", { name: "小说名称", exact: true })).toHaveValue("入间人间");
  await expect(works(page).getByRole("link", { name: "查看安达与岛村", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看入間人間的作品", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "作者", exact: true })).toHaveCount(0);
  await expect(works(page).locator("article.subject-card")).toHaveCount(1);
  await expect(works(page).locator(".subject-caption")).toContainText("原作");
  await expect(works(page).locator(".subject-caption")).toContainText("入間人間");
  await expect(works(page).locator(".subject-type")).toHaveText("轻小说");
  expect(query(page).get("mode")).toBeNull();
  await works(page).getByRole("link", { name: "查看安达与岛村", exact: true }).click();
  await expect(page.getByRole("heading", { name: "安达与岛村", exact: true })).toBeVisible();
  await page.goBack();
  await expect(works(page).getByRole("link", { name: "查看安达与岛村", exact: true })).toBeVisible();
  expect(Object.fromEntries(query(page))).toMatchObject({ q: "入间人间", type: "novel" });
  expect(query(page).get("mode")).toBeNull();
  await page.locator(".search-type-tabs").getByRole("button", { name: "漫画", exact: true }).click();
  await expect(works(page).getByRole("link", { name: "查看安达与岛村 漫画版", exact: true })).toBeVisible();
  await expect(works(page).getByRole("link", { name: "查看安达与岛村", exact: true })).toHaveCount(0);
  await expect(works(page).locator(".subject-type")).toHaveText("漫画");
  await expect(works(page).locator(".subject-caption")).toContainText("原作");
  expect(Object.fromEntries(query(page))).toMatchObject({ q: "入间人间", type: "manga" });
  expect(query(page).get("mode")).toBeNull();
  expect(network.calls.works).toContain(6207);
  expect(network.calls.titleSearches.length).toBeGreaterThan(0);
});

test("switching authors while a relation request is slow discards its delayed response", async ({ page }) => {
  const network = await authorFixtures(page);
  let release!: () => void;
  network.gates.set(6207, new Promise<void>((resolve) => { release = resolve; }));
  await page.goto("/#/search?q=入间人间&type=novel");
  await expect.poll(() => network.calls.works).toContain(6207);
  await page.getByRole("searchbox", { name: "小说名称", exact: true }).fill(secondAuthor.name);
  await page.getByRole("searchbox", { name: "小说名称", exact: true }).press("Enter");
  await expect(works(page).getByRole("link", { name: "查看来自另一作者的故事", exact: true })).toBeVisible();
  release(); network.gates.delete(6207);
  await expect(page.getByRole("heading", { name: /^另一位作者的作品/ })).toBeVisible();
  await expect(works(page).getByRole("link", { name: "查看安达与岛村", exact: true })).toHaveCount(0);
  expect(query(page).get("q")).toBe(secondAuthor.name);
  expect(query(page).get("mode")).toBeNull();
});

test("unrelated people never load their works and an exact author with no works in this category stays empty", async ({ page }) => {
  const network = await authorFixtures(page);
  await page.goto("/#/search?q=某部普通作品&type=novel");
  await expect(page.getByRole("heading", { name: "这次没有找到", exact: true })).toBeVisible();
  await expect(works(page)).toHaveCount(0);
  expect(network.calls.works).toEqual([]);
  expect(network.calls.searches).toContain("某部普通作品");
  await page.getByRole("searchbox", { name: "小说名称", exact: true }).fill(secondAuthor.name);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(works(page).getByRole("link", { name: "查看来自另一作者的故事", exact: true })).toBeVisible();
  await page.locator(".search-type-tabs").getByRole("button", { name: "漫画", exact: true }).click();
  await expect(page.getByText(/没有.*此分类.*关联作品/)).toBeVisible();
  await expect(page.locator("article.subject-card")).toHaveCount(0);
  expect(network.calls.works.every((id) => id === 6208)).toBe(true);
  expect(network.calls.titleSearches.length).toBeGreaterThan(0);
});
