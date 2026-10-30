import { chromium } from "@playwright/test";
import { resolve, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const profile = resolve(process.env.ACGN_HUB_DATA_DIR || ".work/desktop-profile");
assert.ok(profile.startsWith(resolve(".work") + "\\"), "Legacy smoke requires an isolated .work profile");
const browser = await chromium.connectOverCDP(process.env.ACGN_CDP_URL || "http://127.0.0.1:9223");
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /tauri\.localhost/.test(candidate.url()));
  assert.ok(page, "ACGN desktop page was not found");
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const db = await invoke("get_database_url");
  assert.ok(db.toLowerCase().includes(profile.toLowerCase()), "Refusing to seed legacy records in a user profile");
  const now = new Date().toISOString();
  const suffix = Date.now().toString(36);
  const id = "legacy-native-" + suffix;
  const incoming = join(profile, "Files", "Incoming");
  const library = join(profile, "Files", "Library");
  const target = "https://example.com/" + id + ".zip";
  const records = {
    "acgn-hub.media-library.v1": [{ id, type: "anime", title: "旧版导入原生验证", aliases: ["Legacy test"], externalIds: [{ provider: "bangumi", value: String(Date.now()) }], metadata: {}, description: "完整字段迁移", releaseYear: 2026 }],
    "acgn-hub.source-configs.v1": [{ id, type: "rss", name: "旧版来源原生验证", url: "https://example.com/feed.xml", enabled: false, createdAt: now, updatedAt: now }],
    "acgn-hub.resources.v1": [{ id, sourceId: id, sourceItemId: id, mediaId: id, title: "旧版资源原生验证", protocol: "http", targetUrl: target, metadata: {}, createdAt: now }],
    "acgn-hub.download-tasks.v1": [{ id, engineId: "aria2", engineTaskId: "0123456789abcdef", mediaId: id, resourceId: id, sourceUrl: target, protocol: "http", directory: incoming, state: "downloading", totalBytes: 100, completedBytes: 30, speedBytesPerSecond: 5, files: [], dedupeKey: target, createdAt: now, updatedAt: now }],
    "acgn-hub.local-files.v1": [{ id, mediaId: id, path: join(library, id + ".bin"), sizeBytes: 100, status: "missing", scannedAt: now }],
    "acgn-hub.game-installs.v1": [{ id, path: join(library, id), title: "旧版游戏原生验证", engine: "unknown", detectedFiles: [], createdAt: now, updatedAt: now }],
    "acgn-hub.organization-history.v1": [{ id, taskId: id, mediaId: id, sourcePath: join(incoming, id + ".bin"), destinationPath: join(library, id + ".bin"), status: "moved", createdAt: now }],
    "acgn-hub.source-diagnostics.v1": [{ id, sourceId: id, sourceName: "旧版来源", stage: "health", message: "fixture", checkedAt: now, snapshot: {} }],
    "acgn-hub.plugins.v1": [{ manifest: { apiVersion: 1, id, name: "旧版插件原生验证", version: "1.0.0", kind: "source", entry: "index.js", permissions: { domains: ["example.com"] }, config: {} }, enabled: false, updatedAt: now }],
  };
  const snapshot = Object.fromEntries(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]));
  await page.evaluate((snapshot) => { for (const [key, value] of Object.entries(snapshot)) localStorage.setItem(key, value); }, snapshot);
  await page.reload();
  const notice = page.getByRole("complementary", { name: "旧版记录导入" });
  await notice.waitFor();
  await notice.getByRole("button", { name: "查看导入预览" }).click();
  await notice.getByRole("button", { name: "确认导入 9 条", exact: true }).waitFor();
  await notice.getByRole("button", { name: "确认导入 9 条", exact: true }).click();
  await notice.getByText("本次导入 9 条记录。", { exact: false }).waitFor();
  const currentRaw = await page.evaluate((keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), Object.keys(snapshot));
  assert.deepEqual(currentRaw, snapshot, "Original localStorage must be unchanged");
  for (const [table, column] of [["media", "id"], ["source_configs", "source_id"], ["resources", "id"], ["download_tasks", "id"], ["local_files", "id"], ["game_installs", "id"], ["organization_history", "id"], ["source_diagnostics", "id"], ["plugin_manifests", "plugin_id"]]) {
    const rows = await invoke("plugin:sql|select", { db, query: "SELECT COUNT(*) AS count FROM " + table + " WHERE " + column + " = ?", values: [id] });
    assert.equal(rows[0].count, 1, table + " was not imported");
  }
  const tasks = await invoke("plugin:sql|select", { db, query: "SELECT state, engine_task_id, completed_bytes FROM download_tasks WHERE id = ?", values: [id] });
  assert.deepEqual(tasks, [{ state: "paused", engine_task_id: null, completed_bytes: 30 }]);
  await mkdir(".work/desktop-smoke", { recursive: true });
  await page.screenshot({ path: ".work/desktop-smoke/legacy-import.png", fullPage: true });
  await notice.getByRole("button", { name: "重新加载记录", exact: true }).click();
  await page.waitForSelector(".workspace-content");
  const state = await invoke("plugin:sql|select", { db, query: "SELECT state FROM download_tasks WHERE id = ?", values: [id] });
  assert.equal(state[0].state, "paused");
  const result = { passed: true, categories: 9, originalLocalStoragePreserved: true, activeTaskPaused: true, taskProgressPreserved: true, profile };
  await writeFile(".work/desktop-smoke/legacy-results.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close().catch(() => undefined); }
