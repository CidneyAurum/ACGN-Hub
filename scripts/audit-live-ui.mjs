import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("tauri.localhost"));
  const errors = [];
  const failed = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.evaluate(() => { location.hash = "/search"; });
  await page.locator('.search-form input').waitFor();
  await page.locator('.search-form input').fill("葬送的芙莉莲");
  await page.locator('.search-form button[type="submit"]').click();
  await page.locator('.media-card').first().waitFor({ timeout: 45_000 });
  await page.waitForTimeout(2500);
  const cards = await page.locator('.media-card').evaluateAll((cards) => cards.slice(0, 5).map((card) => ({ text: card.innerText.slice(0, 180), image: [...card.querySelectorAll('img')].map((img) => ({ src: img.currentSrc, loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth })), clickableCover: Boolean(card.querySelector('.media-cover a, a.media-cover')) })));
  await mkdir('.work/v03-evidence', { recursive: true });
  await page.screenshot({ path: '.work/v03-evidence/before-search.png', fullPage: true });
  await page.locator('.media-card').first().getByRole('link', { name: '查看详情' }).click();
  await page.waitForTimeout(2500);
  const details = { url: page.url(), text: (await page.locator('.workspace-content').innerText()).slice(0, 2600), image: await page.locator('.workspace-content img').evaluateAll((images) => images.map((img) => ({ src: img.currentSrc, loaded: img.complete && img.naturalWidth > 0 }))) };
  await page.screenshot({ path: '.work/v03-evidence/before-detail.png', fullPage: true });
  const result = { cards, details, errors, failed };
  await writeFile('.work/v03-evidence/baseline-ui.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
