import { test, expect } from "./fixtures";

const archivePath = "0/win/CLANNAD（官中）.7z";
const file = { file_path: archivePath, file_size: 2962220920, upload_timestamp: 1760000000000 };
const sourceId = "shinnku:https://www.shinnku.com";
const sourceItemId = `file:${encodeURIComponent(archivePath)}`;
const resourceId = `${sourceId}:file:${encodeURIComponent(archivePath)}`;
const mediaId = `source:builtin:shinnku:${sourceItemId}`;
const targetUrl = "https://zd.shinnku.top/file/shinnku/" + archivePath.split("/").map(encodeURIComponent).join("/");
const rsc = (value: unknown) => `<html><body><script>self.__next_f.push(${JSON.stringify([1, "0:" + JSON.stringify(value) + "\n"])})</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route("https://www.shinnku.com/**", async (route) => {
    const search = new URL(route.request().url()).pathname === "/search";
    await route.fulfill({ status: 200, contentType: "text/html", body: rsc(search ? { answer: [{ info: file }] } : { info: file }) });
  });
});

test("a new direct-file source works on an old profile, preserves its archive filename and survives reload", async ({ page, mockNetwork }) => {
  await page.addInitScript(() => {
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.source-configs.v1", "[]");
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming" }));
  });
  await page.goto("/#/resources?type=visual_novel&provider=shinnku&q=CLANNAD");
  await expect(page.locator(".resource-source select")).toHaveValue("builtin:shinnku");
  await page.getByRole("button", { name: "启用此来源并搜索", exact: true }).click();
  await expect(page.getByRole("button", { name: "CLANNAD（官中）", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "CLANNAD（官中）", exact: true }).click();
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await expect(panel).toContainText("Windows");
  await expect(panel).toContainText("原站文件直链");
  await panel.getByRole("button", { name: "中文", exact: true }).click();
  await panel.getByRole("button", { name: "Windows", exact: true }).click();
  await panel.getByRole("button", { name: "游戏本体", exact: true }).click();
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await panel.locator(".subject-resource-item").getByRole("button", { name: /直接下载/ }).click();
  await expect.poll(() => mockNetwork.calls.filter((call) => call.method === "aria2.addUri").length).toBe(1);
  const queued = mockNetwork.calls.find((call) => call.method === "aria2.addUri")!;
  expect(queued.params).toEqual(expect.arrayContaining([[targetUrl], expect.objectContaining({ out: "CLANNAD（官中）.7z" })]));
  const option = queued.params.find((value) => typeof value === "object" && !Array.isArray(value)) as { dir: string };
  expect(option.dir).toMatch(/^D:\\ACGN-E2E\\Incoming\\Galgame\\/);
  expect(option.dir).not.toBe("D:\\ACGN-E2E\\Incoming");
  await page.reload();
  await expect(page.getByRole("region", { name: "作品资源", exact: true }).locator(".subject-resource-item")).toHaveCount(1);
});

test("rejecting the same file from another work never overwrites its original saved association", async ({ page, mockNetwork }) => {
  await page.addInitScript(({ sourceItemId, sourceId, resourceId, mediaId, targetUrl }) => {
    const stamp = "2026-10-31T00:00:00Z";
    localStorage.setItem("acgn-hub.resource-source-migration.v18", "1");
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming" }));
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([{ id: "builtin:shinnku", type: "shinnku", name: "真红小站", url: "https://www.shinnku.com", enabled: true, createdAt: stamp, updatedAt: stamp }]));
    localStorage.setItem("acgn-hub.media-library.v1", JSON.stringify([{ id: mediaId, type: "visual_novel", title: "CLANNAD（官中）", aliases: ["CLANNAD"], externalIds: [], metadata: { sourceConfigId: "builtin:shinnku", sourceItemId, sourceType: "shinnku" } }]));
    localStorage.setItem("acgn-hub.resources.v1", JSON.stringify([{ id: resourceId, sourceId, sourceItemId, mediaId: "vndb:v4", title: "CLANNAD（官中）.7z", protocol: "http", targetUrl, metadata: { downloadMode: "direct_file" }, createdAt: stamp }]));
    localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify([{ id: "owned-file", engineId: "aria2", sourceUrl: targetUrl, protocol: "http", directory: "D:\\ACGN-E2E\\Incoming", filename: "CLANNAD（官中）.7z", mediaId: "vndb:v4", resourceId, state: "completed", totalBytes: 100, completedBytes: 100, speedBytesPerSecond: 0, files: ["D:\\ACGN-E2E\\Incoming\\CLANNAD（官中）.7z"], dedupeKey: targetUrl, createdAt: stamp, updatedAt: stamp }]));
  }, { sourceItemId, sourceId, resourceId, mediaId, targetUrl });
  await page.goto("/#/media/" + encodeURIComponent(mediaId));
  const panel = page.getByRole("region", { name: "作品资源", exact: true });
  await expect(panel.locator(".subject-resource-item")).toHaveCount(1);
  await panel.locator(".subject-resource-item").getByRole("button", { name: /直接下载/ }).click();
  await expect(panel.getByRole("alert")).toContainText(/相同链接|重复/);
  const persisted = await page.evaluate((id) => JSON.parse(localStorage.getItem("acgn-hub.resources.v1") ?? "[]").find((item: { id: string }) => item.id === id), resourceId);
  expect(persisted.mediaId).toBe("vndb:v4");
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.addUri")).toHaveLength(0);
});
