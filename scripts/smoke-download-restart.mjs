import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const profile = resolve(".work/desktop-profile");
const executable = resolve("src-tauri/target/release/acgn-hub.exe");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const payload = Buffer.alloc(16 * 1024 * 1024);
for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 17 + (index >>> 8)) & 255;
let resumedRequests = 0;
const server = createServer((request, response) => {
  const start = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
  if (start) resumedRequests += 1;
  response.writeHead(start ? 206 : 200, { "Content-Type": "application/octet-stream", "Content-Length": payload.length - start, "Accept-Ranges": "bytes", ...(start ? { "Content-Range": "bytes " + start + "-" + (payload.length - 1) + "/" + payload.length } : {}) });
  let offset = start;
  const timer = setInterval(() => { const end = Math.min(offset + 65536, payload.length); response.write(payload.subarray(offset, end)); offset = end; if (offset === payload.length) { clearInterval(timer); response.end(); } }, 100);
  response.on("close", () => clearInterval(timer));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = "http://127.0.0.1:" + server.address().port + "/restart.bin";
let browser;
let child;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  let page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /tauri\.localhost/.test(candidate.url()));
  assert.ok(page);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const db = await invoke("get_database_url");
  assert.ok(db.toLowerCase().includes(profile.toLowerCase()), "Refusing to restart a user profile");
  const defaults = await invoke("get_runtime_defaults");
  const directory = join(defaults.incomingDirectory, "Restart-" + Date.now());
  await page.evaluate(() => { location.hash = "/downloads"; });
  await page.locator(".download-form").waitFor();
  await page.locator(".download-form input").nth(0).fill(url);
  await page.locator(".download-form input").nth(1).fill(directory);
  await page.locator(".download-form button[type=submit]").click();
  let partial;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    partial = (await invoke("plugin:sql|select", { db, query: "SELECT id, state, completed_bytes, engine_task_id FROM download_tasks WHERE source_url = ?", values: [url] }))[0];
    if (partial?.state === "downloading" && partial.completed_bytes >= 1024 * 1024) break;
    await pause(200);
  }
  assert.ok(partial?.state === "downloading" && partial.completed_bytes >= 1024 * 1024, "A partial active task was not persisted");
  await pause(1100); // Allow the engine's one-second checkpoint to include a completed piece.
  const pid = Number((await readFile(".work/desktop-smoke/app.pid", "utf8")).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const stopCommand = "$p=Get-Process -Id " + pid + " -ErrorAction Stop; if($p.Path -ne '" + executable.replaceAll("'", "''") + "'){throw 'Unexpected process path'}; if(-not $p.CloseMainWindow()){throw 'No test window to close'}; if(-not $p.WaitForExit(10000)){throw 'Test app did not exit normally'}";
  execFileSync("powershell.exe", ["-NoProfile", "-Command", stopCommand], { windowsHide: true, stdio: "pipe" });
  await browser.close().catch(() => undefined);
  browser = undefined;
  child = spawn(executable, [], { cwd: resolve("."), env: { ...process.env, ACGN_HUB_DATA_DIR: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223" }, windowsHide: true, stdio: "ignore" });
  child.unref();
  await writeFile(".work/desktop-smoke/app.pid", String(child.pid));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 1500 }); break; } catch { await pause(250); }
  }
  assert.ok(browser, "Restarted WebView did not become ready");
  page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /tauri\.localhost/.test(candidate.url()));
  assert.ok(page);
  await page.locator(".workspace-content").waitFor();
  await page.evaluate(() => { location.hash = "/downloads"; });
  const row = page.locator(".task-row").filter({ has: page.locator('strong[title="' + url + '"]') });
  await row.locator('.state-pill[data-state="completed"]').waitFor({ timeout: 35_000 });
  assert.deepEqual(await readFile(join(directory, "restart.bin")), payload);
  const saved = (await invoke("plugin:sql|select", { db, query: "SELECT state, completed_bytes, engine_task_id FROM download_tasks WHERE id = ?", values: [partial.id] }))[0];
  assert.equal(saved.state, "completed");
  assert.equal(saved.completed_bytes, payload.length);
  assert.ok(resumedRequests > 0, "The server did not receive an HTTP Range resume");
  await page.screenshot({ path: ".work/desktop-smoke/restart-completed.png", fullPage: true });
  const result = { passed: true, activeTaskRestored: true, rangeRequests: resumedRequests, totalBytes: payload.length, completedBytesBeforeRestart: partial.completed_bytes, profile };
  await writeFile(".work/desktop-smoke/restart-results.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  server.close();
  if (browser) await browser.close().catch(() => undefined);
}
