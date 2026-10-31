import { test, expect } from "./fixtures";

const title = "文学少女";
const author = "野村美月";
const baseUrl = "https://lnovel.animes.garden";
const providerId = `lnovel:${baseUrl}`;
const stamp = "2026-10-31T00:00:00Z";
const volumes = [
  { nid: 88, vid: 12411, title: "文学少女 1 渴望死亡的小丑" },
  { nid: 88, vid: 12421, title: "文学少女 2 渴求真爱的幽灵" },
  { nid: 88, vid: 12433, title: "文学少女 3 沉陷过往的愚者" },
];
const authorCredits = [{ name: author, position: "author" }];

test("LNovel opens distinct volumes of the selected work and restores them after reload", async ({ page }) => {
  const searchKeyword = author;
  const calls: string[] = [];
  await page.route(`${baseUrl}/api/bili/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    const data = path === "/api/bili/novels"
      ? [{ nid: 88, name: title, authors: authorCredits, description: "固定的日轻作品资料" }]
      : path === "/api/bili/novel/88"
      ? { nid: 88, name: title, authors: authorCredits, volumes }
      : undefined;
    expect(data, "Selecting or restoring a work must not fetch chapter bodies").toBeDefined();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });

  await page.goto("/#/resources?type=novel&provider=lnovel");
  await expect(page.locator(".resource-source select")).toHaveValue("builtin:lnovel");
  await page.getByRole("searchbox").fill(searchKeyword);
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  const choice = page.locator(".resource-work-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(choice).toBeVisible();
  await expect(choice).toContainText(`作者：${author}`);
  expect(calls).toEqual(["/api/bili/novels"]);
  await choice.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  const detailUrl = page.url();
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(panel).toHaveAttribute("data-total", "3");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(3);
  await expect(panel.locator(".subject-resource-item strong")).toHaveText(volumes.map((volume) => `${title} · ${volume.title}`));
  await expect(panel.getByRole("button", { name: /下载本卷/ })).toHaveCount(3);
  await expect(panel.locator(".subject-resource-item").first()).toContainText("中文纯文本，不含插图");
  expect(calls).toEqual(["/api/bili/novels", "/api/bili/novel/88"]);

  await page.reload();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
  await expect(panel).toHaveAttribute("data-total", "3");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(3);
  const restoredSource = panel.getByRole("combobox", { name: "资源来源", exact: true });
  await expect(restoredSource).toHaveValue(providerId);
  await expect(restoredSource).toBeDisabled();
  await expect(restoredSource.locator("option:checked")).toContainText("LNovel");
  await expect(panel.locator(".subject-resource-item strong")).toHaveText(volumes.map((volume) => `${title} · ${volume.title}`));
  const stored = await page.evaluate(() => ({
    sources: JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") ?? "[]") as Array<{ id: string; enabled: boolean; type: string }>,
    works: JSON.parse(localStorage.getItem("acgn-hub.media-library.v1") ?? "[]") as Array<{ title: string; metadata: Record<string, unknown> }>,
  }));
  expect(stored.sources.find((source) => source.id === "builtin:lnovel")).toMatchObject({ type: "lnovel", enabled: true });
  expect(stored.works).toEqual(expect.arrayContaining([expect.objectContaining({ title, metadata: expect.objectContaining({ sourceType: "lnovel", sourceItemId: "88", sourceConfigId: "builtin:lnovel", sourceQuery: searchKeyword }) })]));
  expect(calls.filter((path) => path === "/api/bili/novels")).toHaveLength(1);
  expect(calls.filter((path) => path === "/api/bili/novel/88")).toHaveLength(2);
  expect(calls.some((path) => /\/vol\/|\/chapter\//.test(path))).toBe(false);

  await page.getByRole("link", { name: "← 返回资源搜索", exact: true }).click();
  await expect(page).toHaveURL(/#\/resources\?/);
  const returnedQuery = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
  expect(Object.fromEntries(returnedQuery)).toMatchObject({ type: "novel", q: searchKeyword, sourceId: "builtin:lnovel", provider: "lnovel" });
  await expect(page.getByRole("button", { name: "小说", exact: true })).toHaveClass(/active/);
  await expect(page.locator(".resource-source select")).toHaveValue("builtin:lnovel");
  await expect(page.getByRole("searchbox")).toHaveValue(searchKeyword);
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  await choice.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(detailUrl);
  await expect(panel).toHaveAttribute("data-total", "3");
  await expect(panel.locator(".subject-resource-item strong")).toHaveText(volumes.map((volume) => `${title} · ${volume.title}`));
  await expect(panel.getByRole("combobox", { name: "资源来源", exact: true })).toHaveValue(providerId);
});

test("separate LNovel APIs return independently and stopped searches discard late results", async ({ page }) => {
  const slowBaseUrl = "https://slow-novel.example.test";
  const slowTitle = "审稿男孩和投稿女孩";
  await page.addInitScript(({ stamp, baseUrl, slowBaseUrl }) => {
    const source = (id: string, name: string, url: string) => ({ id, type: "lnovel", name, url, enabled: true, createdAt: stamp, updatedAt: stamp });
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([
      source("fast-novel", "快速日轻索引", baseUrl),
      source("slow-novel", "稍慢日轻索引", slowBaseUrl),
    ]));
  }, { stamp, baseUrl, slowBaseUrl });
  let releaseSlow: () => void = () => undefined;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let fastRequests = 0;
  let slowRequests = 0;
  await page.route(`${baseUrl}/api/bili/novels`, async (route) => {
    fastRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [{ nid: 88, name: title, authors: authorCredits }] }) });
  });
  await page.route(`${slowBaseUrl}/api/bili/novels`, async (route) => {
    slowRequests += 1;
    await slowGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [{ nid: 1325, name: slowTitle, authors: authorCredits }] }) });
  });
  try {
    await page.goto(`/#/resources?type=novel&q=${encodeURIComponent(author)}&sourceId=all`);
    await expect(page.locator(".resource-source select")).toHaveValue("all");
    await page.getByRole("button", { name: "搜索来源", exact: true }).click();
    await expect.poll(() => slowRequests).toBe(1);
    await expect(page.locator(".resource-work-card")).toHaveCount(1);
    await expect(page.locator(".resource-work-source")).toHaveText("快速日轻索引");
    await expect(page.locator(".resource-work-card").getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.locator(".resource-search-sources")).toContainText("已返回 1 / 2");
    await expect(page.getByRole("button", { name: "选择作品并查看资源", exact: true })).toBeEnabled();
    const stop = page.getByRole("button", { name: "停止等待", exact: true });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(page.locator(".resource-search-sources")).toContainText("已停止等待，保留已返回结果");
    await expect(stop).toHaveCount(0);
    const slowResponse = page.waitForResponse(`${slowBaseUrl}/api/bili/novels`);
    releaseSlow();
    await (await slowResponse).finished();
    // Flush the fulfilled transport and Promise.all continuations before checking stale results.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".resource-work-card")).toHaveCount(1);
    await expect(page.locator(".resource-work-source")).toHaveText("快速日轻索引");
    await expect(page.getByRole("heading", { name: slowTitle, exact: true })).toHaveCount(0);
    await expect(page.locator(".resource-search-sources")).toContainText("已停止等待，保留已返回结果");
    await expect(page.getByRole("button", { name: "搜索来源", exact: true })).toBeEnabled();

    // A fresh search may use each API's cache, but the two catalogs must remain separate.
    await page.getByRole("button", { name: "搜索来源", exact: true }).click();
    await expect(page.locator(".resource-work-card")).toHaveCount(2);
    const fastChoice = page.locator(".resource-work-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    const slowChoice = page.locator(".resource-work-card").filter({ has: page.getByRole("heading", { name: slowTitle, exact: true }) });
    await expect(fastChoice.locator(".resource-work-source")).toHaveText("快速日轻索引");
    await expect(slowChoice.locator(".resource-work-source")).toHaveText("稍慢日轻索引");
    expect(fastRequests).toBe(1);
    expect(slowRequests).toBe(1);
  } finally {
    releaseSlow();
  }
});
