import type { DownloadTask } from "../../src/domain/download";
import type { LocalDownloadTask } from "../../src/domain/local-download";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const directory = "D:\\ACGN-E2E\\Incoming";
interface OpenRequest { path: string; allowedRoot: string; preferSystem?: boolean }
function task(id: string, files: string[], overrides: Partial<DownloadTask> = {}): DownloadTask {
  return { id, filename: id, engineId: "aria2", engineEndpoint: "http://127.0.0.1:16800/jsonrpc", sourceUrl: `https://fixture.example.test/${id}.torrent`, protocol: "torrent", directory,
    state: "completed", files, totalBytes: 1000, completedBytes: 1000, speedBytesPerSecond: 0, dedupeKey: id, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", ...overrides };
}

/** Simulate only this page's native-open boundary. Stores keep browser persistence;
 * no Tauri runtime, external player or filesystem operation is invoked. */
async function simulateOpen(page: Page, callback: (request: OpenRequest) => Promise<void>): Promise<void> {
  await page.exposeFunction("__e2eOpenCompletedOutput", callback);
  await page.route(/\/src\/pages\/DownloadsPage\.vue(?:\?.*)?$/, async (route) => {
    // Vite requests this same .vue URL for its style subresource as well.
    if (new URL(route.request().url()).searchParams.has("vue")) return route.continue();
    const response = await route.fetch();
    const source = await response.text();
    const invokeImport = /import\s*\{\s*invoke\s*\}\s*from\s*["'][^"']+["'];?/;
    const runtimeImport = /import\s*\{\s*isTauriRuntime\s*\}\s*from\s*["'][^"']+["'];?/;
    if (!invokeImport.test(source) || !runtimeImport.test(source)) throw new Error("DownloadsPage native boundary import changed");
    await route.fulfill({ response, body: source.replace(invokeImport, `const invoke = (command, args) => {
      if (command !== "open_downloaded_media") throw new Error("Unexpected native command: " + command);
      return window.__e2eOpenCompletedOutput(args);
    };`).replace(runtimeImport, "const isTauriRuntime = () => true;") });
  });
}

test("completed MP4 and MKV tasks open their registered file in the system player", async ({ page }) => {
  const calls: OpenRequest[] = [];
  const mp4 = task("MP4成品", [directory + "\\学生会也有洞！ - 第01话.mp4"]);
  const mkv = task("MKV成品", [directory + "\\春季新番 - 第02话.mkv"], { engineId: "qbittorrent" });
  const unsafe = task("脚本文件", [directory + "\\install.exe"]);
  const external = task("目录之外", ["D:\\ACGN-E2E\\Incoming-other\\episode.mp4"]);
  const active = task("未完成视频", [directory + "\\unfinished.mp4"], { state: "paused", completedBytes: 500 });
  await simulateOpen(page, async (request) => { calls.push(request); });
  await page.addInitScript((records) => localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify(records)), [mp4, mkv, unsafe, external, active]);
  await page.goto("/#/downloads");
  for (const saved of [mp4, mkv]) {
    const row = page.locator("article.task-row").filter({ has: page.locator(".task-title-line strong", { hasText: saved.filename }) });
    await row.getByRole("button", { name: "打开文件", exact: true }).click();
  }
  expect(calls).toEqual([mp4, mkv].map((saved) => ({ path: saved.files[0], allowedRoot: directory, preferSystem: true })));
  for (const saved of [unsafe, external, active]) {
    const row = page.locator("article.task-row").filter({ has: page.locator(".task-title-line strong", { hasText: saved.filename }) });
    await expect(row.getByRole("button", { name: "打开文件", exact: true })).toHaveCount(0);
  }
  const unchanged = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") || "[]"));
  expect(unchanged.map((saved: DownloadTask) => saved.files)).toEqual([mp4, mkv, unsafe, external, active].map((saved) => saved.files));
});

test("multi-file tasks require an explicit safe selection and keep completion when the opener fails", async ({ page }) => {
  const files = [directory + "\\Batch\\EP01.mkv", directory + "\\Batch\\EP02.mp4", directory + "\\Batch\\install.bat"];
  const saved = task("多文件番剧", files);
  const calls: OpenRequest[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await simulateOpen(page, async (request) => { calls.push(request); await pending; throw new Error("固定样本：尚未配置默认播放器"); });
  await page.addInitScript((record) => localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify([record])), saved);
  await page.goto("/#/downloads");
  const row = page.locator("article.task-row").filter({ hasText: "多文件番剧" });
  const choose = row.getByRole("combobox", { name: "选择打开文件", exact: true });
  const open = row.getByRole("button", { name: "打开文件", exact: true });
  await expect(open).toBeDisabled();
  await expect(choose.getByRole("option")).toHaveText(["先选择一个文件", "EP01.mkv", "EP02.mp4"]);
  await choose.selectOption(files[1]);
  await open.click();
  try {
    await expect(open).toBeDisabled();
    await expect(choose).toBeDisabled();
    await expect(row.getByRole("button", { name: "自动命名", exact: true })).toBeDisabled();
    await open.dispatchEvent("click");
    expect(calls).toEqual([{ path: files[1], allowedRoot: directory, preferSystem: true }]);
  } finally { release(); }
  await expect(page.getByText("固定样本：尚未配置默认播放器", { exact: true })).toBeVisible();
  await expect(row.locator('[data-state="completed"]')).toBeVisible();
  await expect(open).toBeEnabled();
});

test("local completed history cannot open a same-path output now owned by a newer task", async ({ page }) => {
  const outputPath = directory + "\\共同成品.mp4";
  const old: LocalDownloadTask = { id: "old-local", kind: "video", title: "旧成品记录", sourceName: "固定公开视频", directory, outputPath,
    stage: "completed", completedUnits: 1, totalUnits: 1, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" };
  const current: LocalDownloadTask = { ...old, id: "new-local", title: "当前成品记录", cleanupPaths: [{ path: outputPath, allowedRoot: directory }], createdAt: "2026-10-31T00:00:00Z" };
  const calls: OpenRequest[] = [];
  await simulateOpen(page, async (request) => { calls.push(request); });
  await page.addInitScript((records) => localStorage.setItem("acgn-hub.local-download-tasks.v1", JSON.stringify(records)), [old, current]);
  await page.goto("/#/downloads");
  const previous = page.locator("article.task-row").filter({ hasText: "旧成品记录" });
  const latest = page.locator("article.task-row").filter({ hasText: "当前成品记录" });
  const oldOpen = previous.getByRole("button", { name: "打开文件", exact: true });
  await expect(oldOpen).toBeDisabled();
  await expect(previous).toContainText("请核对输出目录");
  // A stale/programmatic click must be guarded by current store ownership too.
  await oldOpen.dispatchEvent("click");
  await expect(page.getByText("此记录已不再拥有该成品，或路径正由其它任务使用。请核对输出目录，并从当前任务打开文件。", { exact: true })).toBeVisible();
  expect(calls).toEqual([]);
  await latest.getByRole("button", { name: "打开文件", exact: true }).click();
  expect(calls).toEqual([{ path: outputPath, allowedRoot: directory }]);
  await expect(previous.locator('[data-state="completed"]')).toBeVisible();
  await expect(latest.locator('[data-state="completed"]')).toBeVisible();
});
