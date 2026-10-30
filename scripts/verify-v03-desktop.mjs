import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const profile = resolve(".work/v03-profile");
const results = [];
const errors = [];
const payload = Buffer.from("Embedded BitTorrent works without qBittorrent.\n".repeat(100));
function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(value.length + ":"), value]);
  if (typeof value === "string") return bencode(Buffer.from(value));
  if (typeof value === "number") return Buffer.from("i" + value + "e");
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  return Buffer.concat([Buffer.from("d"), ...Object.keys(value).sort().flatMap((key) => [bencode(key), bencode(value[key])]), Buffer.from("e")]);
}
let torrent;
const server = createServer((request, response) => {
  if (request.url?.startsWith("/native-bt.torrent")) { response.writeHead(200, { "Content-Type": "application/x-bittorrent", "Content-Length": torrent.length }); response.end(torrent); return; }
  if (request.url?.includes("native-bt.txt") || request.url?.includes("sample.bin")) {
    const match = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const start = Number(match?.[1] ?? 0); const end = match?.[2] ? Number(match[2]) : payload.length - 1;
    const bytes = payload.subarray(start, end + 1);
    response.writeHead(match ? 206 : 200, { "Content-Length": bytes.length, "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", ...(match ? { "Content-Range": "bytes " + start + "-" + end + "/" + payload.length } : {}) }); response.end(bytes); return;
  }
  response.writeHead(404); response.end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const endpoint = "http://127.0.0.1:" + server.address().port;
torrent = bencode({ "url-list": endpoint + "/native-bt.txt", info: { length: payload.length, name: "native-bt.txt", "piece length": 16384, pieces: createHash("sha1").update(payload).digest() } });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("tauri.localhost"));
  assert.ok(page);
  page.on("pageerror", (error) => errors.push(error.message));
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const defaults = await invoke("get_runtime_defaults");
  assert.ok(defaults.incomingDirectory.startsWith(profile + "\\"));
  await mkdir(".work/v03-evidence", { recursive: true });
  await page.evaluate(() => { location.hash = "/"; });
  await page.locator('.poster-wall .media-card').first().waitFor({ timeout: 45000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.poster-wall img')].filter((img) => img.complete && img.naturalWidth > 0).length >= 6, { timeout: 45000 });
  assert.ok(await page.locator('img[src^="http://acgn-image.localhost/"]').count() >= 6);
  await page.screenshot({ path: ".work/v03-evidence/home.png", fullPage: true });
  results.push("真实放送表与至少六张封面在原生缓存协议中成功解码");

  await page.locator('.anime-global-search input').fill("葬送的芙莉莲");
  await page.locator('.anime-global-search input').press("Enter");
  const card = page.locator('.poster-results-grid .media-card').filter({ has: page.locator('.subject-name', { hasText: /^葬送的芙莉莲$/ }) }).first();
  await card.waitFor({ timeout: 45000 });
  await page.screenshot({ path: ".work/v03-evidence/search.png", fullPage: true });
  await card.locator('.subject-cover-link').click();
  await page.getByRole('heading', { name: '葬送的芙莉莲', exact: true }).waitFor();
  assert.ok(page.url().includes("bangumi%3A400602"));
  await page.getByLabel('追番状态', { exact: true }).selectOption('watching');
  const previousProgress = Number((await page.locator('.subject-tracking>span').innerText()).match(/\d+/)?.[0] ?? 0);
  await page.locator('.subject-tracking button').click();
  await page.waitForFunction((previous) => Number(document.querySelector('.subject-tracking>span')?.textContent.match(/\d+/)?.[0] ?? 0) > previous, previousProgress);
  await page.screenshot({ path: ".work/v03-evidence/detail.png", fullPage: true });
  await page.reload();
  await page.getByRole('heading', { name: '葬送的芙莉莲', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="追番状态"]')?.value === 'watching');
  results.push("真实作品搜索→点击封面→详情→在看与集数→重载保持");

  await page.evaluate(() => { location.hash = "/resources?type=manga&q=" + encodeURIComponent("葬送的芙莉莲"); });
  await page.locator('.resource-search-panel select').waitFor();
  await page.locator('.resource-search-panel select').selectOption('builtin:copymanga');
  await page.locator('.resource-search-panel form button[type="submit"]').click();
  const sourceCard = page.locator('.resource-work-card').first();
  await sourceCard.waitFor({ timeout: 45000 });
  assert.match(await sourceCard.locator('h3').innerText(), /^葬送的芙莉[莲蓮]$/);
  await page.screenshot({ path: ".work/v03-evidence/source-search.png", fullPage: true });
  await sourceCard.locator('.resource-work-content button').click();
  await page.locator('.subject-find-button').click();
  await page.locator('.subject-resource-item').first().waitFor({ timeout: 45000 });
  const chapters = Number(await page.locator('#subject-resources').getAttribute('data-total')) || await page.locator('.subject-resource-item').count();
  assert.ok(chapters > 50, "Expected the original series chapter list rather than a five-page fan anthology");
  await page.screenshot({ path: ".work/v03-evidence/source-chapters.png", fullPage: true });
  results.push("真实拷贝漫画查询→确认原作→精确读取 " + chapters + " 个章节");

  const run = Date.now().toString(36);
  for (const [path, filename] of [["/sample.bin", "sample.bin"], ["/native-bt.torrent", "native-bt.txt"]]) {
    const directory = join(defaults.incomingDirectory, run + (filename.endsWith('txt') ? '-bt' : '-http'));
    await page.evaluate(() => { location.hash = "/downloads"; });
    await page.locator('.download-form input').first().fill(endpoint + path);
    await page.locator('.download-form input').nth(1).fill(directory);
    await page.locator('.download-form button[type="submit"]').click();
    const row = page.locator('.task-row').filter({ has: page.locator('strong[title="' + endpoint + path + '"]') });
    await row.locator('.state-pill[data-state="completed"]').waitFor({ timeout: 35000 });
    assert.deepEqual(await readFile(join(directory, filename)), payload);
    results.push(path.endsWith('torrent') ? "真实界面Torrent URL→内置BT父子GID→本地WebSeed完整下载，无qBittorrent" : "真实界面HTTP→内置aria2→文件字节核验");
  }
  await page.screenshot({ path: ".work/v03-evidence/downloads.png", fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile('.work/v03-evidence/results.json', JSON.stringify({ results, errors, passed: results.length }, null, 2));
  console.log(JSON.stringify({ results, passed: results.length }, null, 2));
} catch (cause) {
  await writeFile('.work/v03-evidence/results.json', JSON.stringify({ results, errors, passed: results.length, failure: cause instanceof Error ? cause.message : String(cause) }, null, 2));
  throw cause;
} finally { server.close(); await browser.close().catch(() => undefined); }
