import { test, expect } from "./fixtures";

function savedTask(index: number, filename: string, protocol = "magnet") {
  const gid = String(index).padStart(16, "0");
  return { id: "diagnostic-" + index, engineId: "aria2", engineEndpoint: "http://127.0.0.1:16800/jsonrpc", engineTaskId: gid,
    sourceName: "固定蜜柑资源", filename, protocol,
    sourceUrl: protocol === "magnet" ? "magnet:?xt=urn:btih:" + String(index).padStart(40, "0") : `https://fixture.example.test/${index}.${protocol === "torrent" ? "torrent" : "mkv"}`,
    directory: "D:\\ACGN-E2E\\Incoming", state: "downloading", totalBytes: 1000, completedBytes: 200, speedBytesPerSecond: 0,
    files: [], dedupeKey: "diagnostic-" + index, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z" };
}
const payloadStatus = (name: string, extra: Record<string, unknown> = {}) => ({ status: "active", totalLength: "1000", completedLength: "200", downloadSpeed: "0",
  connections: "0", numSeeders: "0", bittorrent: { info: { name } }, files: [{ path: "D:\\ACGN-E2E\\Incoming\\" + name + ".mkv" }], ...extra });

test("download rows distinguish torrent, metadata, engine slots, zero peers, transfer, checking and engine errors", async ({ page, mockNetwork }) => {
  const tasks = [savedTask(1, "种子描述样本", "torrent"), savedTask(2, "磁力信息样本"), savedTask(3, "零连接样本"), savedTask(4, "引擎排队样本"),
    savedTask(5, "校验样本"), savedTask(6, "网络故障样本"), savedTask(7, "鉴权故障样本"), savedTask(8, "传输样本"), savedTask(11, "原始错误码样本")];
  await page.addInitScript((records) => localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify(records)), tasks);
  mockNetwork.aria2Statuses.set(tasks[0].engineTaskId, { status: "active", totalLength: "500", completedLength: "100", downloadSpeed: "0", files: [{ path: "D:\\ACGN-E2E\\Incoming\\种子描述样本.torrent" }] });
  mockNetwork.aria2Statuses.set(tasks[1].engineTaskId, { status: "active", totalLength: "0", completedLength: "0", downloadSpeed: "0", connections: "0", numSeeders: "0", files: [] });
  mockNetwork.aria2Statuses.set(tasks[2].engineTaskId, payloadStatus("零连接样本", { completedLength: "0" }));
  mockNetwork.aria2Statuses.set(tasks[3].engineTaskId, { status: "waiting", totalLength: "0", completedLength: "0", downloadSpeed: "0", files: [] });
  mockNetwork.aria2Statuses.set(tasks[4].engineTaskId, payloadStatus("校验样本", { completedLength: "1000", verifiedLength: "250", verifyIntegrityPending: "true" }));
  mockNetwork.aria2StatusErrors.set(tasks[5].engineTaskId, "连接 aria2 失败：connection refused（固定样本）");
  mockNetwork.aria2StatusErrors.set(tasks[6].engineTaskId, "Unauthorized: 固定原始鉴权错误");
  mockNetwork.aria2Statuses.set(tasks[7].engineTaskId, payloadStatus("传输样本", { completedLength: "500", downloadSpeed: "50", connections: "3", numSeeders: "1" }));
  mockNetwork.aria2Statuses.set(tasks[8].engineTaskId, { status: "error", totalLength: "1000", completedLength: "0", downloadSpeed: "0", errorCode: "7", errorMessage: "", files: [] });
  await page.goto("/#/downloads");
  const row = (name: string) => page.locator("article.task-row").filter({ hasText: name });
  await expect(row("种子描述样本")).toContainText("获取种子文件");
  await expect(row("磁力信息样本")).toContainText("获取磁力元数据");
  await expect(row("磁力信息样本")).toContainText("大小待确认");
  await expect(row("零连接样本")).toContainText("正在寻找节点");
  await expect(row("零连接样本")).toContainText("连接节点：0");
  await expect(row("零连接样本")).toContainText("做种节点：0");
  await expect(row("零连接样本")).toContainText("0 B/s");
  await expect(row("零连接样本")).not.toContainText("资源无种");
  await expect(row("引擎排队样本")).toContainText("等待引擎空位");
  await expect(row("校验样本")).toContainText("校验下载内容");
  await expect(row("校验样本")).toContainText("已校验 250 B / 1000 B");
  await expect(row("校验样本").locator(".progress-track > span")).toHaveAttribute("style", /width:\s*25%/);
  await expect(row("校验样本").locator('[data-state="completed"]')).toHaveCount(0);
  await expect(row("网络故障样本")).toContainText("引擎连接失败");
  await expect(row("网络故障样本")).toContainText("connection refused（固定样本）");
  await expect(row("网络故障样本")).toContainText("200 B / 1000 B");
  await expect(row("网络故障样本")).toContainText("速度待刷新");
  await expect(row("鉴权故障样本")).toContainText("状态待刷新");
  await expect(row("鉴权故障样本")).toContainText("Unauthorized: 固定原始鉴权错误");
  await expect(row("鉴权故障样本").getByRole("button", { name: "刷新状态", exact: true })).toBeVisible();
  await expect(row("传输样本")).toContainText("正在传输");
  await expect(row("传输样本")).toContainText("连接节点：3");
  await expect(row("传输样本")).toContainText("做种节点：1");
  await expect(row("原始错误码样本").locator('[data-state="failed"]')).toBeVisible();
  await expect(row("原始错误码样本")).toContainText("错误码：7");
  expect(mockNetwork.calls.some((call) => call.method === "aria2.addUri")).toBe(false);
  await page.screenshot({ path: ".work/e2e/download-phase-diagnostics.png", fullPage: true, animations: "disabled" });
});

test("an outstanding task action disables repeated writes and submits pause only once", async ({ page, mockNetwork }) => {
  const task = savedTask(9, "操作等待样本", "http");
  await page.addInitScript((record) => localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify([record])), task);
  mockNetwork.aria2Statuses.set(task.engineTaskId, { status: "active", totalLength: "1000", completedLength: "200", downloadSpeed: "50", files: [] });
  mockNetwork.taskStates.set(task.engineTaskId, "active");
  let release!: () => void;
  mockNetwork.aria2ActionGates.set("aria2.pause:" + task.engineTaskId, new Promise<void>((resolve) => { release = resolve; }));
  await page.goto("/#/downloads");
  const row = page.locator("article.task-row").filter({ hasText: "操作等待样本" });
  const pause = row.getByRole("button", { name: "暂停", exact: true });
  try {
    await pause.click();
    await expect(row.getByRole("status")).toHaveText("正在处理任务操作…");
    await expect(pause).toBeDisabled();
    await expect(row.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await pause.dispatchEvent("click");
    expect(mockNetwork.calls.filter((call) => call.method === "aria2.pause")).toHaveLength(1);
  } finally { release(); }
  await expect(row.locator('[data-state="paused"]')).toBeVisible();
  await expect(row.getByRole("button", { name: "继续", exact: true })).toBeEnabled();
  expect(mockNetwork.calls.filter((call) => call.method === "aria2.pause")).toHaveLength(1);
});

test("changing the default BT engine explains its scope and keeps an existing task on its original engine", async ({ page, mockNetwork }) => {
  const task = savedTask(10, "原引擎任务样本");
  await page.addInitScript((record) => {
    localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify([record]));
    localStorage.setItem("acgn-hub.settings.v1", JSON.stringify({ incomingDirectory: "D:\\ACGN-E2E\\Incoming", libraryDirectory: "D:\\ACGN-E2E\\Library", obsidianEbookDirectory: "D:\\ACGN-E2E\\Books", backupDirectory: "D:\\ACGN-E2E\\Backups" }));
  }, task);
  mockNetwork.aria2Statuses.set(task.engineTaskId, payloadStatus("原引擎任务样本"));
  await page.goto("/#/settings");
  await expect(page.getByText(/切换引擎仅用于之后新建/)).toBeVisible();
  await page.getByRole("combobox", { name: "BitTorrent 下载引擎" }).selectOption("qbittorrent");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "设置已保存" })).toBeVisible();
  await page.goto("/#/downloads");
  const row = page.locator("article.task-row").filter({ hasText: "原引擎任务样本" });
  await expect(row).toContainText("引擎：aria2");
  const owner = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.download-tasks.v1") || "[]")[0]);
  expect(owner).toMatchObject({ engineId: "aria2", engineTaskId: task.engineTaskId, engineEndpoint: "http://127.0.0.1:16800/jsonrpc" });
  expect(mockNetwork.calls.some((call) => call.method === "aria2.addUri")).toBe(false);
});
