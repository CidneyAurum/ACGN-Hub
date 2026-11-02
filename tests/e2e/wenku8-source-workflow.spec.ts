import { test, expect } from "./fixtures";

const baseUrl = "https://raw.githubusercontent.com/mojimoon/wenku8/main";
const catalogUrl = baseUrl + "/out/epub_index.json";
const providerId = "wenku8_epub:" + baseUrl;
const title = "文学少女";
const author = "野村美月";
const volume = (index: number) => ({ index, title: `第${index}卷`, file: `v${String(index).padStart(2, "0")}.epub`, size: 2_856_332, chapters: 10, images: 14 });
const book = (aid: number, name: string, writer: string) => ({ title: name, author: writer, repo: "mojimoon/wenku8-epub", tag: `book-${aid}`, volumes: [volume(1), volume(2), volume(3)] });

test("a disabled EPUB preset finds an author's works, selects original illustrations and restores its exact volumes", async ({ page, mockNetwork }) => {
  const calls: string[] = [];
  const catalog = {
    "1": { ...book(1, title, author), variants: { orig: {
      repo: "mojimoon/wenku8-epub", tag: "book-1", volumes: [{ ...volume(1), file: "orig-v01.epub", size: 4_218_271 }],
    } } },
    "2": book(2, "固定另一部小说", author),
    "3": book(3, "无关作品", "其他作者"),
  };
  await page.route(catalogUrl, async (route) => {
    calls.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(catalog) });
  });
  await page.addInitScript(() => {
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming", obsidianEbookDirectory: "D:\\ACGN-E2E\\Books" }));
  });
  await page.goto("/#/resources?type=novel&provider=wenku8_epub");
  await expect(page.locator(".resource-source select")).toHaveValue("builtin:wenku8-epub");
  await page.getByRole("searchbox").fill(author);
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.locator(".resource-work-card")).toHaveCount(2);
  const choice = page.locator(".resource-work-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(choice).toContainText(`作者：${author}`);
  await choice.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  const detailUrl = page.url();
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(panel.locator(".subject-resource-item")).toHaveCount(3);
  await expect(panel.locator(".subject-resource-item strong")).toHaveText([`${title} · 第1卷`, `${title} · 第2卷`, `${title} · 第3卷`]);
  await expect(panel.getByRole("button", { name: /下载 EPUB/ })).toHaveCount(3);
  const first = panel.locator(".subject-resource-item").first();
  await expect(first).toContainText("插图原图版");
  await expect(first).toContainText("10 章正文");
  await expect(first).toContainText("14 张插图");
  await first.getByRole("button", { name: /下载 EPUB/ }).click();
  await expect.poll(() => mockNetwork.calls.filter((call) => call.method === "aria2.addUri").length).toBe(1);
  const added = mockNetwork.calls.find((call) => call.method === "aria2.addUri")!;
  expect(added.params).toEqual(expect.arrayContaining([
    ["https://github.com/mojimoon/wenku8-epub/releases/download/book-1/1-orig-v01.epub"],
    expect.objectContaining({ out: "文学少女 - 第1卷 - 原图版.epub", dir: "D:\\ACGN-E2E\\Books" }),
  ]));
  await page.reload();
  await expect(page).toHaveURL(detailUrl);
  await expect(panel.locator(".subject-resource-item")).toHaveCount(3);
  await expect(panel.getByRole("combobox", { name: "资源来源", exact: true })).toHaveValue(providerId);
  await expect(panel.locator(".subject-resource-item").first()).toContainText("插图原图版");
  const stored = await page.evaluate(() => ({
    configs: JSON.parse(localStorage.getItem("acgn-hub.source-configs.v1") ?? "[]"),
    resources: JSON.parse(localStorage.getItem("acgn-hub.resources.v1") ?? "[]"),
    tasks: JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") ?? "[]"),
  }));
  expect(stored.configs).toEqual(expect.arrayContaining([expect.objectContaining({ id: "builtin:wenku8-epub", type: "wenku8_epub", enabled: true })]));
  expect(stored.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: providerId + ":1:1:orig", metadata: expect.objectContaining({ seriesTitle: title, volumeOrder: 1, imageQuality: "orig" }) })]));
  expect(stored.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ resourceId: providerId + ":1:1:orig", filename: "文学少女 - 第1卷 - 原图版.epub" })]));
  expect(calls).toHaveLength(2);
});

test("a withdrawn original remains distinct from a spin-off and cannot enqueue an EPUB download", async ({ page, mockNetwork }) => {
  const original = "无职转生～到了异世界就拿出真本事～";
  await page.route(catalogUrl, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    "1587": { title: original, blocked: "copyright" },
    "3765": book(3765, "无职转生～蛇足篇～", "理不尽な孙の手"),
  }) }));
  await page.goto("/#/resources?type=novel&provider=wenku8_epub&q=无职转生");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.locator(".resource-work-card")).toHaveCount(2);
  const choice = page.locator(".resource-work-card").filter({ has: page.getByRole("heading", { name: original, exact: true }) });
  await expect(choice).toContainText("版权下架");
  await choice.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(page.getByRole("heading", { name: original, exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("alert")).toContainText("版权下架");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /下载 EPUB/ })).toHaveCount(0);
  expect(mockNetwork.calls.some((call) => call.method === "aria2.addUri")).toBe(false);
  await page.reload();
  await expect(panel.getByRole("alert")).toContainText("版权下架");
  await expect(panel.locator(".subject-resource-item")).toHaveCount(0);
});

test("rejecting an existing EPUB keeps the original work's resource and download association", async ({ page, mockNetwork }) => {
  const resourceId = providerId + ":1:1";
  const targetUrl = "https://github.com/mojimoon/wenku8-epub/releases/download/book-1/1-v01.epub";
  const previousOwner = "bangumi:932001";
  const stamp = "2026-11-02T00:00:00.000Z";
  await page.route(catalogUrl, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ "1": book(1, title, author) }) }));
  await page.addInitScript(({ baseUrl, providerId, resourceId, targetUrl, previousOwner, stamp, title }) => {
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming", obsidianEbookDirectory: "D:\\ACGN-E2E\\Books" }));
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([{ id: "builtin:wenku8-epub", type: "wenku8_epub", name: "Wenku8 · 插图 EPUB", url: baseUrl, enabled: true, createdAt: stamp, updatedAt: stamp }]));
    localStorage.setItem("acgn-hub.resources.v1", JSON.stringify([{ id: resourceId, sourceId: providerId, sourceItemId: "1", mediaId: previousOwner,
      title: "既有作品 · 原本保存的第一卷", protocol: "http", targetUrl, format: "EPUB", volume: 1,
      metadata: { downloadMode: "direct", seriesTitle: "既有作品", volumeTitle: "原本保存的第一卷", volumeOrder: 1 }, createdAt: stamp }]));
    localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify([{ id: "original-epub-task", engineId: "aria2", sourceUrl: targetUrl, protocol: "http",
      directory: "D:\\ACGN-E2E\\Books", filename: `${title} - 第1卷.epub`, mediaId: previousOwner, resourceId, state: "completed", totalBytes: 100,
      completedBytes: 100, speedBytesPerSecond: 0, files: [], dedupeKey: targetUrl, createdAt: stamp, updatedAt: stamp }]));
  }, { baseUrl, providerId, resourceId, targetUrl, previousOwner, stamp, title });

  await page.goto("/#/resources?type=novel&provider=wenku8_epub");
  await page.getByRole("searchbox").fill(author);
  await page.getByRole("button", { name: "搜索来源", exact: true }).click();
  const choice = page.locator(".resource-work-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(choice).toContainText(`作者：${author}`);
  await choice.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  await expect(page).toHaveURL(/#\/media\/source/);
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(panel.locator(".subject-resource-item")).toHaveCount(3);
  await panel.locator(".subject-resource-item").first().getByRole("button", { name: /下载 EPUB/ }).click();
  await expect(panel.getByRole("alert")).toContainText("相同链接");
  const stored = await page.evaluate((id) => ({
    resource: JSON.parse(localStorage.getItem("acgn-hub.resources.v1") ?? "[]").find((resource: { id: string }) => resource.id === id),
    tasks: JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") ?? "[]"),
    works: JSON.parse(localStorage.getItem("acgn-hub.media-library.v1") ?? "[]"),
  }), resourceId);
  expect(stored.works).toEqual(expect.arrayContaining([expect.objectContaining({ id: "source:builtin:wenku8-epub:1", title })]));
  expect(stored.resource).toMatchObject({ id: resourceId, mediaId: previousOwner, title: "既有作品 · 原本保存的第一卷", targetUrl,
    metadata: { seriesTitle: "既有作品", volumeTitle: "原本保存的第一卷", volumeOrder: 1 }, createdAt: stamp });
  expect(stored.tasks).toHaveLength(1);
  expect(stored.tasks[0]).toMatchObject({ id: "original-epub-task", mediaId: previousOwner, resourceId, sourceUrl: targetUrl, state: "completed" });
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(0);
});
