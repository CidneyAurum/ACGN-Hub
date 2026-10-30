import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { SourceConfig } from "../../src/domain/source";

function source(id: string, type: SourceConfig["type"], name: string, url: string, extra: Partial<SourceConfig> = {}): SourceConfig {
  return { id, type, name, url, enabled: true, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z", ...extra };
}

async function seedSources(page: Page, sources: SourceConfig[]): Promise<void> {
  await page.addInitScript((items) => {
    if (localStorage.getItem("e2e.source-management-seeded")) return;
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify(items));
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("e2e.source-management-seeded", "1");
  }, sources);
}

async function readSources(page: Page): Promise<SourceConfig[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") || "[]") as SourceConfig[]);
}

test("source category filters preserve custom URLs, credentials and enabled states", async ({ page }) => {
  const sources = [
    source("my:mikan", "rss", "我的动画订阅", "https://mikanani.me/RSS/Classic", { enabled: false }),
    source("my:copy", "copymanga", "我的中文漫画", "https://mapi.hotmangasg.com", { token: "e2e-synthetic-token" }),
    source("my:lnovel", "lnovel", "我的轻小说", "https://lnovel.animes.garden"),
    source("my:kungal", "kungal", "我的游戏索引", "https://www.kungal.com", { enabled: false }),
    source("my:custom", "rss", "我的自定义订阅", "https://custom.fixture.example.test/my-feed.xml", { enabled: false }),
  ];
  await seedSources(page, sources);
  await page.goto("/#/sources");
  const rows = page.locator("article.source-row");
  await expect(rows).toHaveCount(5);
  const filters = page.getByRole("group", { name: "来源作品类型", exact: true });
  for (const [label, expectedNames] of [
    ["动画", ["我的动画订阅", "我的自定义订阅"]],
    ["漫画", ["我的中文漫画", "我的自定义订阅"]],
    ["轻小说", ["我的轻小说", "我的自定义订阅"]],
    ["Galgame", ["我的游戏索引", "我的自定义订阅"]],
  ] as const) {
    await filters.getByRole("button", { name: label, exact: true }).click();
    await expect(rows).toHaveCount(expectedNames.length);
    expect((await rows.getByRole("heading").allTextContents()).sort()).toEqual([...expectedNames].sort());
    expect(await readSources(page)).toEqual(sources);
  }
  const index = rows.filter({ has: page.getByRole("heading", { name: "我的游戏索引", exact: true }) });
  await expect(index).toContainText("站外资源索引");
  await expect(index).toContainText("原站登录");
  await expect(index).toContainText("未检测");
  await expect(index).not.toContainText("下载已可用");
  await page.screenshot({ path: ".work/e2e/source-management-galgame-filter.png", fullPage: true, animations: "disabled" });
  await filters.getByRole("button", { name: "全部", exact: true }).click();
  await expect(rows).toHaveCount(5);
  await page.reload();
  await expect(rows).toHaveCount(5);
  expect(await readSources(page)).toEqual(sources);
});

test("a slow connection check preserves a concurrent disable and cannot overwrite a later address edit", async ({ page }) => {
  const oldUrl = "https://slow.fixture.example.test/rss.xml";
  await seedSources(page, [source("my:slow", "rss", "慢连接订阅", oldUrl)]);
  const releases: Array<() => void> = [];
  await page.route(oldUrl, async (route) => {
    await new Promise<void>((resolve) => releases.push(resolve));
    await route.fulfill({ contentType: "application/rss+xml", body: '<?xml version="1.0"?><rss version="2.0"><channel><title>Fixed Feed</title><item><title>Fixed episode</title><enclosure url="https://fixture.example.test/episode.mkv" type="video/x-matroska" length="1000"/></item></channel></rss>' });
  });
  await page.goto("/#/sources");
  const row = page.locator("article.source-row");
  await row.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect.poll(() => releases.length).toBe(1);
  await row.getByRole("button", { name: "停用", exact: true }).click();
  await expect(row.getByRole("button", { name: "启用", exact: true })).toBeVisible();
  releases[0]();
  await expect(row.getByRole("button", { name: "检查连接", exact: true })).toBeEnabled();
  await expect(row).toContainText("上次通过");
  expect((await readSources(page))[0]).toMatchObject({ id: "my:slow", enabled: false, url: oldUrl, lastHealth: { ok: true } });

  await row.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect.poll(() => releases.length).toBe(2);
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await row.getByRole("textbox", { name: "名称", exact: true }).fill("改名后的订阅");
  const newUrl = "https://new.fixture.example.test/rss.xml";
  await row.getByRole("textbox", { name: "来源地址", exact: true }).fill(newUrl);
  await row.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(row.getByRole("heading", { name: "改名后的订阅", exact: true })).toBeVisible();
  releases[1]();
  await expect(row.getByRole("button", { name: "检查连接", exact: true })).toBeEnabled();
  await expect(row).toContainText("未检测");
  const stored = (await readSources(page))[0];
  expect(stored).toMatchObject({ id: "my:slow", name: "改名后的订阅", enabled: false, url: newUrl });
  expect(stored.lastHealth).toBeUndefined();
});
