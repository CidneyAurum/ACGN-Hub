import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const gamePage = "https://npckc.itch.io/one-night-hot-springs";
const itemId = "npckc/one-night-hot-springs";
const uploadId = "2436127";
const resourceId = `itch_freeware:${itemId}:${uploadId}`;
const sourceId = "itch_freeware:https://itch.io";
const stableUrl = `${gamePage}?acgn_upload=${uploadId}`;
const title = "one night, hot springs";
const filename = "one night, hot springs - 简繁中文 - Windows-Linux - v1.55.zip";
const stamp = "2026-11-02T00:00:00.000Z";
const csrf = "fixed-public-anonymous-form";

function mainPage(): string {
  return `<html><body><div class="formatted_description">A complete free visual novel.</div>
    <div class="game_info_panel_widget"><table><tr><td>Languages</td><td>
    <a href="https://itch.io/games/lang-en">English</a><a href="https://itch.io/games/lang-zh_Hans">简体中文</a><a href="https://itch.io/games/lang-zh_Hant">繁體中文</a>
    </td></tr></table></div><script>init_ViewGame('#game', ${JSON.stringify({ generate_download_url: gamePage + "/download_url", game: {
      id: 226937, slug: "one-night-hot-springs", min_price: 0, actual_price: 0,
    } })});</script></body></html>`;
}

function upload(id: string, name: string, platforms: string[]): string {
  return `<div class="upload"><a class="button download_btn" data-upload_id="${id}" href="javascript:void(0)">Download</a>
    <div class="info_column"><div class="upload_name"><strong class="name" title="${name}">${name}</strong>
    <span class="file_size"><span>72</span> MB</span>${platforms.map((platform) => `<span class="icon icon-${platform}"></span>`).join("")}</div><div>Version 1.55</div></div></div>`;
}

/** Only HTTP responses are fixed. The product provider, source repositories,
 * resource association and task manager all execute their production code. */
async function officialFreewareNetwork(page: Page) {
  const requests: Array<{ path: string; method: string }> = [];
  const signed: string[] = [];
  const queueSnapshots: Array<{ resource?: Record<string, unknown>; tasks: Array<Record<string, unknown>> }> = [];
  let generated = 0;
  let firstSignatureGate: Promise<void> | undefined;
  await page.route("https://npckc.itch.io/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method() });
    expect(request.headers()["cookie"]).toBeUndefined();
    expect(request.headers()["authorization"]).toBeUndefined();
    const text = (body: string) => route.fulfill({ status: 200, contentType: "text/html", body });
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/one-night-hot-springs") return text(mainPage());
    if (path === "/one-night-hot-springs/purchase") return text(`<html><head><meta name="csrf_token" value="${csrf}"></head><body><a class="direct_download_btn">No thanks, just take me to the downloads</a></body></html>`);
    if (path === "/one-night-hot-springs/download_url") {
      expect(request.method()).toBe("POST");
      expect(request.postData()).toBe(new URLSearchParams({ csrf_token: csrf }).toString());
      return json({ url: `${gamePage}/download/fixed-issued-${++generated}` });
    }
    if (/^\/one-night-hot-springs\/download\/fixed-issued-\d+$/.test(path)) return text(`<html><head><meta name="csrf_token" value="${csrf}"></head><body>${[
      upload(uploadId, "one-night-hot-springs-win-linux.zip", ["windows8", "tux"]),
      upload("1868851", "one-night-hot-springs-osx.zip", ["apple"]),
      upload("13264421", "com.npckc.onsen-1.55-1770985503-release.apk", ["android"]),
    ].join("")}</body></html>`);
    if (path === `/one-night-hot-springs/file/${uploadId}`) {
      expect(request.method()).toBe("POST");
      expect(request.postData()).toBe(new URLSearchParams({ csrf_token: csrf }).toString());
      queueSnapshots.push(await page.evaluate((id) => ({
        resource: JSON.parse(localStorage.getItem("acgn-hub.resources.v1") ?? "[]").find((resource: { id: string }) => resource.id === id),
        tasks: JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") ?? "[]"),
      }), resourceId));
      const url = `https://itchio-mirror.fixed123.r2.cloudflarestorage.com/one-night-hot-springs.zip?X-Amz-Signature=fixed-signature-${signed.length + 1}`;
      signed.push(url);
      if (signed.length === 1 && firstSignatureGate) await firstSignatureGate;
      return json({ url, external: false });
    }
    throw new Error("Unexpected official freeware request: " + request.method() + " " + path);
  });
  return { requests, signed, queueSnapshots, delayFirstSignature(gate: Promise<void>) { firstSignatureGate = gate; } };
}

test("official freeware separates platforms and queues fresh file signatures while retaining one stable task through retry", async ({ page, mockNetwork }) => {
  const network = await officialFreewareNetwork(page);
  await page.addInitScript(() => localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming" })));
  await page.goto("/#/resources?type=visual_novel&provider=itch_freeware&q=one%20night%20hot%20springs");
  await expect(page.locator(".resource-source select")).toHaveValue("builtin:itch-freeware");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  const choice = page.locator(".resource-work-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(choice).toContainText("作者：npckc");
  await choice.getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  const rows = panel.locator(".subject-resource-item");
  await expect(rows).toHaveCount(3);
  const workUrl = page.url();
  const windows = rows.filter({ hasText: "Windows / Linux" });
  const android = rows.filter({ hasText: "Android" });
  await expect(windows).toHaveCount(1);
  await expect(android).toHaveCount(1);
  await expect(windows).toContainText("ZIP");
  await expect(android).toContainText("APK");
  await expect(windows).toContainText("简体中文");
  await expect(windows).toContainText("作者官方免费发行");
  await panel.getByRole("button", { name: "Windows", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(android).toHaveCount(0);
  await panel.getByRole("button", { name: "Windows", exact: true }).click();
  await expect(rows).toHaveCount(3);

  let release!: () => void;
  network.delayFirstSignature(new Promise<void>((resolve) => { release = resolve; }));
  const download = windows.getByRole("button");
  try {
    await download.click();
    await expect.poll(() => network.signed.length).toBe(1);
    await expect(download).toBeDisabled();
    await download.dispatchEvent("click");
    expect(network.signed).toHaveLength(1);
    expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(0);
    const snapshot = network.queueSnapshots[0];
    expect(snapshot.resource).toMatchObject({ id: resourceId, targetUrl: stableUrl, mediaId: expect.stringContaining("source:builtin:itch-freeware:") });
    expect(snapshot.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ sourceUrl: stableUrl, resourceId, state: "queued", mediaId: snapshot.resource!.mediaId })]));
  } finally { release(); }
  await expect.poll(() => mockNetwork.calls.filter((call) => call.method === "aria2.addUri").length).toBe(1);
  const first = mockNetwork.calls.find((call) => call.method === "aria2.addUri")!;
  expect(first.params).toEqual(expect.arrayContaining([[network.signed[0]], expect.objectContaining({ out: filename })]));
  const persisted = await page.evaluate((id) => ({
    resource: JSON.parse(localStorage.getItem("acgn-hub.resources.v1") ?? "[]").find((resource: { id: string }) => resource.id === id),
    task: JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") ?? "[]")[0],
  }), resourceId);
  expect(persisted.task).toMatchObject({ resourceId, sourceUrl: stableUrl, filename, state: "downloading" });
  expect(JSON.stringify(persisted)).not.toContain("X-Amz-Signature");

  // A repeated request is rejected before the beforeCreate association write.
  await expect(download).toBeEnabled();
  await download.click();
  await expect(panel.getByRole("alert")).toContainText("相同链接");
  expect(network.signed).toHaveLength(1);
  expect(await page.evaluate((id) => JSON.parse(localStorage.getItem("acgn-hub.resources.v1") ?? "[]").find((resource: { id: string }) => resource.id === id), resourceId)).toEqual(persisted.resource);

  const gid = [...mockNetwork.taskStates.keys()][0];
  mockNetwork.taskStates.delete(gid);
  mockNetwork.aria2Statuses.set(gid, { status: "error", errorCode: "22", errorMessage: "固定样本：文件签名过期", totalLength: "1000", completedLength: "0", downloadSpeed: "0", files: [] });
  await page.goto("/#/downloads");
  const taskRow = page.locator("article.task-row").filter({ hasText: filename });
  await expect(taskRow.locator('[data-state="failed"]')).toBeVisible();
  await expect(taskRow).toContainText("固定样本：文件签名过期");
  await taskRow.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => mockNetwork.calls.filter((call) => call.method === "aria2.addUri").length).toBe(2);
  expect(network.signed).toHaveLength(2);
  expect(network.signed[0]).not.toBe(network.signed[1]);
  const retried = mockNetwork.calls.filter((call) => call.method === "aria2.addUri")[1];
  expect(retried.params).toEqual(expect.arrayContaining([[network.signed[1]], expect.objectContaining({ out: filename })]));
  await expect(taskRow.locator('[data-state="downloading"]')).toBeVisible();
  const tasks = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") ?? "[]"));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ id: persisted.task.id, resourceId, sourceUrl: stableUrl, filename, state: "downloading" });
  expect(JSON.stringify(tasks)).not.toContain("X-Amz-Signature");
  await page.goto(workUrl);
  await expect(rows).toHaveCount(3);
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(2);
});

test("a duplicate official file cannot replace the previous work's saved resource association", async ({ page, mockNetwork }) => {
  const network = await officialFreewareNetwork(page);
  const mediaId = `source:builtin:itch-freeware:${itemId}`;
  const previousOwner = "vndb:v22619";
  await page.addInitScript(({ stamp, sourceId, itemId, resourceId, stableUrl, mediaId, previousOwner, title, filename }) => {
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming" }));
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([{ id: "builtin:itch-freeware", type: "itch_freeware", name: "itch.io · 官方免费精选", url: "https://itch.io", enabled: true, createdAt: stamp, updatedAt: stamp }]));
    localStorage.setItem("acgn-hub.media-library.v1", JSON.stringify([{ id: mediaId, type: "visual_novel", title, aliases: [], externalIds: [], metadata: { sourceConfigId: "builtin:itch-freeware", sourceItemId: itemId, sourceType: "itch_freeware" } }]));
    localStorage.setItem("acgn-hub.resources.v1", JSON.stringify([{ id: resourceId, sourceId, sourceItemId: itemId, mediaId: previousOwner, title: "原先作品的官方文件", protocol: "http", targetUrl: stableUrl, format: "ZIP", metadata: { downloadMode: "direct_file", needsFreshDownloadTarget: true, downloadFileName: filename }, createdAt: stamp }]));
    localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify([{ id: "original-owned-official-file", engineId: "aria2", sourceUrl: stableUrl, protocol: "http", directory: "D:\\ACGN-E2E\\Incoming", filename, mediaId: previousOwner, resourceId, state: "completed", totalBytes: 100, completedBytes: 100, speedBytesPerSecond: 0, files: [], dedupeKey: stableUrl, createdAt: stamp, updatedAt: stamp }]));
  }, { stamp, sourceId, itemId, resourceId, stableUrl, mediaId, previousOwner, title, filename });
  await page.goto("/#/media/" + encodeURIComponent(mediaId));
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  const windows = panel.locator(".subject-resource-item").filter({ hasText: "Windows / Linux" });
  await expect(windows).toHaveCount(1);
  await windows.getByRole("button", { name: /直接下载/ }).click();
  await expect(panel.getByRole("alert")).toContainText("相同链接");
  const records = await page.evaluate((id) => ({
    resource: JSON.parse(localStorage.getItem("acgn-hub.resources.v1") ?? "[]").find((resource: { id: string }) => resource.id === id),
    tasks: JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") ?? "[]"),
  }), resourceId);
  expect(records.resource).toMatchObject({ mediaId: previousOwner, title: "原先作品的官方文件", targetUrl: stableUrl, createdAt: stamp });
  expect(records.tasks).toHaveLength(1);
  expect(records.tasks[0]).toMatchObject({ id: "original-owned-official-file", mediaId: previousOwner, sourceUrl: stableUrl });
  expect(network.signed).toHaveLength(0);
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(0);
});
