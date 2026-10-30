import type { DownloadTask } from "../../src/domain/download";
import { test, expect } from "./fixtures";

const root = "D:\\ACGN-E2E\\Incoming\\";
const sourceName = "[Kitauji] Seitokai ni mo Ana wa Aru! [01][CHS][HEVC].mp4";
const title = "学生会也有洞！";
function completedTask(id: string, overrides: Partial<DownloadTask> = {}): DownloadTask {
  return { id, engineId: "aria2", engineEndpoint: "http://127.0.0.1:16800/jsonrpc", sourceUrl: `https://fixture.example.test/${id}.torrent`, protocol: "torrent",
    directory: root, filename: sourceName, state: "completed", totalBytes: 436_467_104, completedBytes: 436_467_104, speedBytesPerSecond: 0,
    files: [root + sourceName], mediaId: "bangumi:554779", sourceName: "固定蜜柑样本", dedupeKey: id, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z", ...overrides };
}

test("automatic naming is enabled by default and its explicit setting survives reload", async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("e2e.naming-settings") === "1") return;
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming", libraryDirectory: "D:\\ACGN-E2E\\Library", obsidianEbookDirectory: "D:\\ACGN-E2E\\Books", backupDirectory: "D:\\ACGN-E2E\\Backups" }));
    localStorage.setItem("e2e.naming-settings", "1");
  });
  await page.goto("/#/settings");
  const option = page.getByRole("checkbox", { name: "下载完成后自动命名", exact: true });
  await expect(option).toBeChecked();
  await expect(page.getByText(/aria2 单文件完成后/)).toContainText("重名不覆盖");
  await option.uncheck();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "设置已保存" })).toBeVisible();
  await page.reload();
  await expect(option).not.toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.settings.v1") || "{}").autoRenameDownloads)).toBe(false);
});

test("completed names can be previewed and edited without changing extensions or renaming browser files", async ({ page, mockNetwork }) => {
  const single = completedTask("name-single");
  const unknown = completedTask("name-unknown", { filename: "Unlinked EP02.mkv", mediaId: undefined, files: [root + "Unlinked EP02.mkv"] });
  const multi = completedTask("name-multi", { filename: "多文件样本", files: [root + "Episode 01.mp4", root + "Episode 02.mp4"] });
  const qbit = completedTask("name-qbit", { engineId: "qbittorrent", filename: "做种样本", files: [root + "Seeding EP03.mp4"] });
  await page.addInitScript((records) => {
    localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify(records));
    localStorage.setItem("acgn-hub.media-library.v1", JSON.stringify([{ id: "bangumi:554779", type: "anime", title: "学生会也有洞！", aliases: [], externalIds: [], metadata: {} }]));
  }, [single, unknown, multi, qbit]);
  await page.goto("/#/downloads");
  const row = (name: string) => page.locator("article.task-row").filter({ has: page.locator(".task-title-line strong", { hasText: name }) });
  const first = row(sourceName);
  await first.getByRole("button", { name: "自动命名", exact: true }).click();
  const editor = first.getByRole("form", { name: "成品名称预览", exact: true });
  await expect(editor.getByRole("textbox", { name: "成品文件名", exact: true })).toHaveValue(`${title} - 第01话 [简中] [HEVC].mp4`);
  await expect(editor).toContainText("当前文件：" + sourceName);
  await expect(editor).toContainText("仅在当前目录改名，重名不会覆盖");
  await expect(editor.getByRole("button", { name: "确认改名", exact: true })).toBeDisabled();
  await editor.getByRole("textbox", { name: "成品文件名", exact: true }).fill("我的手动名称.mkv");
  await expect(editor.getByRole("alert")).toContainText("保留原扩展名 .mp4");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveCount(0);

  const missing = row("Unlinked EP02.mkv");
  await missing.getByRole("button", { name: "自动命名", exact: true }).click();
  await expect(missing.getByRole("form")).toContainText("缺少可靠的作品名称");
  await expect(missing.getByRole("textbox", { name: "成品文件名", exact: true })).toHaveValue("Unlinked EP02.mkv");
  await missing.getByRole("textbox", { name: "成品文件名", exact: true }).fill("人工确认的作品 - 第02话.mkv");
  await expect(missing.getByRole("button", { name: "确认改名", exact: true })).toBeDisabled();

  const multiple = row("多文件样本");
  await multiple.getByRole("button", { name: "自动命名", exact: true }).click();
  await expect(multiple.getByRole("form")).toContainText("多文件任务逐项确认");
  await expect(multiple.getByRole("textbox", { name: "成品文件名", exact: true })).toHaveCount(0);
  await multiple.getByRole("combobox", { name: "选择成品文件", exact: true }).selectOption(multi.files[1]);
  await expect(multiple.getByRole("textbox", { name: "成品文件名", exact: true })).toHaveValue(`${title} - 第02话.mp4`);
  await expect(row("做种样本")).toContainText("请在 qBittorrent 中修改名称");
  await expect(row("做种样本").getByRole("button", { name: /自动命名|修改名称/ })).toHaveCount(0);
  expect(mockNetwork.calls.filter((call) => /addUri|tellStatus/.test(call.method))).toEqual([]);
  const unchanged = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") || "[]"));
  expect(unchanged.map((task: DownloadTask) => task.files)).toEqual([single, unknown, multi, qbit].map((task) => task.files));
  await page.screenshot({ path: ".work/e2e/completed-naming-preview.png", fullPage: true, animations: "disabled" });
});

test("renamed originals remain searchable and naming failures stay separate from completed downloads", async ({ page }) => {
  const renamed = completedTask("name-renamed", { filename: `${title} - 第01话.mp4`, files: [root + `${title} - 第01话.mp4`], naming: { status: "renamed", originalFileName: sourceName, originalPath: root + sourceName, currentFileName: `${title} - 第01话.mp4`, renamedAt: "2026-10-30T12:00:00Z" } });
  const failed = completedTask("name-failed", { filename: "命名冲突样本.mp4", files: [root + "命名冲突样本.mp4"], naming: { status: "failed", message: "目标名称已存在，原文件保持不变。" } });
  await page.addInitScript((records) => localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify(records)), [renamed, failed]);
  await page.goto("/#/downloads");
  await page.getByRole("searchbox", { name: "搜索任务", exact: true }).fill("Kitauji");
  await expect(page.locator("article.task-row")).toHaveCount(1);
  const row = page.locator("article.task-row");
  await expect(row.getByRole("button", { name: "修改名称", exact: true })).toBeVisible();
  await row.getByText("查看原名记录", { exact: true }).click();
  await expect(row).toContainText("原名：" + sourceName);
  await page.getByRole("searchbox", { name: "搜索任务", exact: true }).fill("命名冲突");
  await expect(row.locator('[data-state="completed"]')).toBeVisible();
  await expect(row).toContainText("成品命名未完成：目标名称已存在");
  await expect(row.locator('[data-state="failed"]')).toHaveCount(0);
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(row).toHaveCount(1);
});
