import { chromium } from "@playwright/test";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
try {
  let page;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("tauri.localhost"));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(page, 'The native page did not become ready');
  const db = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_database_url"));
  assert.ok(db.toLowerCase().includes(resolve('.work/v03-profile').toLowerCase()));
  const keyword = process.env.ACGN_CHAPTER_TITLE || "脑洞学生会";
  await page.evaluate((keyword) => { location.hash = "/resources?type=manga&q=" + encodeURIComponent(keyword); }, keyword);
  await page.locator('.resource-search-panel select').waitFor();
  await page.locator('.resource-search-panel select').selectOption('builtin:copymanga');
  await page.locator('.resource-search-panel form button[type="submit"]').click();
  await page.locator('.resource-work-card').first().waitFor({ timeout: 45000 });
  console.log("Matched work:", await page.locator('.resource-work-card').first().locator('h3').innerText());
  await page.locator('.resource-work-card').first().getByRole('button', { name: '选择作品并查看资源', exact: true }).click();
  await page.locator('.subject-find-button').waitFor();
  await page.locator('.subject-find-button').click();
  await page.locator('.subject-resource-item').first().waitFor({ timeout: 45000 });
  console.log("Downloading one public chapter through the actual UI");
  const oldTaskIds = await page.evaluate(() => JSON.parse(localStorage.getItem('acgn-hub.local-download-tasks.v1') || '[]').map((task) => task.id));
  await page.locator('.subject-resource-item').first().getByRole('button').click();
  let task;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    task = await page.evaluate((old) => JSON.parse(localStorage.getItem('acgn-hub.local-download-tasks.v1') || '[]').find((task) => !old.includes(task.id)), oldTaskIds);
    if (task && ['failed', 'completed', 'cancelled'].includes(task.stage)) break;
    if (attempt % 5 === 0) console.log(JSON.stringify({ stage: task?.stage, completed: task?.completedUnits, total: task?.totalUnits }));
    await page.waitForTimeout(2000);
  }
  await writeFile('.work/v03-evidence/real-manga-download.json', JSON.stringify(task ?? {}, null, 2));
  assert.equal(task?.stage, 'completed', task?.error || 'Real chapter did not complete');
  const file = await readFile(task.outputPath);
  assert.equal(file.readUInt32LE(0), 0x04034b50);
  const info = await stat(task.outputPath);
  console.log(JSON.stringify({ passed: true, title: task.title, outputPath: task.outputPath, bytes: info.size, totalPages: task.totalUnits }));
  await page.evaluate(() => { location.hash = "/downloads"; });
  await page.locator('.local-downloads .task-row').first().waitFor();
  await page.screenshot({ path: '.work/v03-evidence/real-download-completed.png', fullPage: false });
} finally { await browser.close().catch(() => undefined); }
