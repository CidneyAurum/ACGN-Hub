import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

// Attach to an explicitly started, isolated desktop profile. No user library is touched.
const profile = resolve(process.env.ACGN_HUB_DATA_DIR || ".work/desktop-profile");
assert.ok(profile.startsWith(resolve(".work") + "\\"), "Desktop smoke requires a profile inside the workspace .work directory");
const results = [];
const runId = Date.now().toString(36);
const payload = Buffer.from("ACGN Hub native download verification\n".repeat(4096));
const server = createServer((request, response) => {
  if (request.url !== "/sample.bin") { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": payload.length });
  response.end(payload);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
let browser;
try {
  browser = await chromium.connectOverCDP(process.env.ACGN_CDP_URL || "http://127.0.0.1:9223");
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /tauri\.localhost|localhost:1420/.test(candidate.url()));
  assert.ok(page, "No ACGN desktop WebView found");
  const issues = [];
  page.on("pageerror", (error) => issues.push(error.message));
  await page.waitForSelector(".workspace-content");
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const defaults = await invoke("get_runtime_defaults");
  for (const key of ["incomingDirectory", "libraryDirectory", "backupDirectory"]) assert.ok(defaults[key].startsWith(profile + "\\"), "Profile isolation failed: " + key);
  results.push("Isolated native runtime defaults");
  const incoming = join(defaults.incomingDirectory, "Smoke-" + runId);
  if (process.env.ACGN_SMOKE_PUBLIC_APIS === "1") {
    const bangumi = await invoke("metadata_json_request", { url: "https://api.bgm.tv/v0/search/subjects?limit=1", method: "POST", body: { keyword: "葬送的芙莉莲", filter: { type: [2] }, sort: "match" }, headers: { Accept: "application/json" }, timeoutMs: 10000 });
    assert.equal(bangumi.status, 200); assert.ok(Array.isArray(bangumi.body.data) && bangumi.body.data.length > 0);
    const vndb = await invoke("metadata_json_request", { url: "https://api.vndb.org/kana/vn", method: "POST", body: { filters: ["search", "=", "Steins;Gate"], fields: "id,title", results: 1 }, headers: { Accept: "application/json" }, timeoutMs: 10000 });
    assert.equal(vndb.status, 200); assert.ok(Array.isArray(vndb.body.results) && vndb.body.results.length > 0);
    results.push("Optional read-only Bangumi and VNDB requests through the native metadata proxy");
  }
  const db = await invoke("get_database_url");
  assert.ok(db.toLowerCase().includes(profile.toLowerCase()), "Refusing to use a database outside the isolated profile");
  await invoke("plugin:sql|load", { db });
  await invoke("plugin:sql|execute", { db, query: "CREATE TABLE IF NOT EXISTS source_configs (source_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)", values: [] });
  const record = "native-" + Date.now();
  const query = "INSERT INTO source_configs (source_id, enabled, config_json, updated_at) VALUES (?, ?, ?, ?)";
  await invoke("database_transaction", { statements: [{ sql: query, values: [record, 0, "saved", new Date().toISOString()] }] });
  await assert.rejects(invoke("database_transaction", { statements: [{ sql: query, values: [record + "-rollback", 0, "temporary", new Date().toISOString()] }, { sql: query, values: [record, 0, "duplicate", new Date().toISOString()] }] }));
  const rows = await invoke("plugin:sql|select", { db, query: "SELECT source_id AS id, config_json AS value FROM source_configs WHERE source_id LIKE ?", values: [record + "%"] });
  assert.deepEqual(rows, [{ id: record, value: "saved" }]);
  results.push("Real SQLite execute permission, transaction and rollback");

  await page.evaluate(() => { window.location.hash = "/downloads"; });
  await page.locator(".download-form").waitFor();
  await page.locator(".download-form input").nth(0).fill("http://127.0.0.1:" + port + "/sample.bin");
  await page.locator(".download-form input").nth(1).fill(incoming);
  await page.locator(".download-form button[type=submit]").click();
  const activeRow = page.locator('.task-row').filter({ has: page.locator('strong[title="http://127.0.0.1:' + port + '/sample.bin"]') });
  await activeRow.locator('.state-pill[data-state="completed"]').waitFor({ timeout: 35_000 });
  const downloaded = join(incoming, "sample.bin");
  assert.deepEqual(await readFile(downloaded), payload);
  const jobs = await invoke("plugin:sql|select", { db, query: "SELECT state, engine_id, engine_task_id, engine_endpoint FROM download_tasks WHERE source_url = ?", values: ["http://127.0.0.1:" + port + "/sample.bin"] });
  assert.equal(jobs.length, 1); assert.equal(jobs[0].state, "completed"); assert.equal(jobs[0].engine_id, "aria2"); assert.ok(jobs[0].engine_task_id);
  await mkdir(resolve(".work/desktop-smoke"), { recursive: true });
  await page.screenshot({ path: ".work/desktop-smoke/download-completed.png", fullPage: true });
  results.push("Desktop UI → download manager → native aria2 → file verification → SQLite completed task");

  const textPath = join(defaults.libraryDirectory, "Books", "native-check-" + runId + ".txt");
  await invoke("write_text_file", { outputRoot: defaults.libraryDirectory, outputPath: textPath, content: "原生电子书写入验证\n" });
  await assert.rejects(invoke("write_text_file", { outputRoot: defaults.libraryDirectory, outputPath: textPath, content: "must not overwrite" }));
  assert.equal(await readFile(textPath, "utf8"), "原生电子书写入验证\n");
  results.push("Native TXT atomic write and existing-file protection");

  const mangaTemp = join(defaults.incomingDirectory, "SmokeManga-" + runId);
  await mkdir(mangaTemp, { recursive: true });
  await writeFile(join(mangaTemp, ".acgn-manga-temp"), "ACGN Hub owned manga temporary directory\n");
  const image = join(mangaTemp, "001.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQmcAAAAASUVORK5CYII=", "base64"));
  const cbzPath = join(defaults.libraryDirectory, "Books", "native-check-" + runId + ".cbz");
  await invoke("create_cbz", { imagePaths: [image], sourceRoot: mangaTemp, incomingRoot: defaults.incomingDirectory, outputRoot: defaults.libraryDirectory, outputPath: cbzPath });
  const zip = await readFile(cbzPath); assert.equal(zip.readUInt32LE(0), 0x04034b50);
  await assert.rejects(stat(mangaTemp));
  results.push("Native CBZ generation and cleanup of an owned temporary directory");

  await assert.rejects(invoke("cleanup_manga_temp", { tempDirectory: defaults.incomingDirectory, incomingRoot: defaults.incomingDirectory }));
  assert.ok((await stat(defaults.incomingDirectory)).isDirectory());
  results.push("Incoming root cannot be recursively cleaned");

  const destination = join(defaults.libraryDirectory, "Smoke-" + runId, "sample.bin");
  const organized = await invoke("organize_file", { taskId: jobs[0].engine_task_id, sourcePath: downloaded, destinationPath: destination, incomingRoot: defaults.incomingDirectory, libraryRoot: defaults.libraryDirectory });
  assert.equal(organized.status, "moved"); assert.deepEqual(await readFile(destination), payload);
  const index = await invoke("scan_library_files", { libraryRoot: defaults.libraryDirectory, withHash: true });
  assert.ok(index.some((file) => file.path.toLowerCase().endsWith("sample.bin") && /^[a-f0-9]{64}$/i.test(file.sha256)));
  results.push("Native file organization, library scan and SHA-256");

  await page.reload();
  await page.locator(".download-form").waitFor();
  await activeRow.locator('.state-pill[data-state="completed"]').waitFor();
  assert.deepEqual(issues, []);
  results.push("WebView reload restores the completed task without page errors");
  await writeFile(".work/desktop-smoke/results.json", JSON.stringify({ profile, results, passed: results.length, pageErrors: issues }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} catch (cause) {
  await mkdir(resolve(".work/desktop-smoke"), { recursive: true });
  await writeFile(".work/desktop-smoke/results.json", JSON.stringify({ profile, results, passed: results.length, error: cause instanceof Error ? cause.message : String(cause) }, null, 2));
  throw cause;
} finally {
  server.close();
  if (browser) await browser.close().catch(() => undefined);
}
