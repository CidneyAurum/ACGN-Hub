import type { Page } from "@playwright/test";
import type { DownloadTask } from "../../src/domain/download";
import type { LocalDownloadTask } from "../../src/domain/local-download";
import type { LocalViewerSession } from "../../src/domain/local-viewer";
import { test, expect } from "./fixtures";

const directory = "D:\\ACGN-E2E\\Incoming";
const comicSessionId = "0123456789abcdef0123456789abcdef";
const novelSessionId = "123456789abcdef0123456789abcdef0";
const videoSessionId = "23456789abcdef0123456789abcdef01";
const chapterOneSessionId = "3456789abcdef0123456789abcdef012";
const chapterTwoSessionId = "456789abcdef0123456789abcdef0123";
const modifiedAt = "2026-10-31T08:00:00Z";
interface NativeRequest { path: string; allowedRoot: string; preferSystem?: boolean }
interface ViewerSimulation {
  prepared: NativeRequest[];
  closed: string[];
  opened: NativeRequest[];
  images: Array<{ sessionId: string; index: number }>;
  prepare(request: NativeRequest): Promise<LocalViewerSession>;
  brokenImages: Set<string>;
  imageSizes: Array<{ width: number; height: number }>;
}

function localTask(id: string, kind: LocalDownloadTask["kind"], filename: string, overrides: Partial<LocalDownloadTask> = {}): LocalDownloadTask {
  const outputPath = directory + "\\" + filename;
  return { id, kind, title: filename.replace(/\.[^.]+$/, ""), sourceName: "固定本地下载", directory, outputPath,
    cleanupPaths: [{ path: outputPath, allowedRoot: directory }], stage: "completed", completedUnits: 3, totalUnits: 3,
    createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", ...overrides };
}

function engineTask(id: string, files: string[]): DownloadTask {
  return { id, filename: "固定多文件番剧", engineId: "aria2", engineEndpoint: "http://127.0.0.1:16800/jsonrpc",
    sourceUrl: "https://fixture.example.test/batch.torrent", protocol: "torrent", directory, state: "completed", files,
    totalBytes: 1000, completedBytes: 1000, speedBytesPerSecond: 0, dedupeKey: id,
    createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" };
}

function comicSession(id = comicSessionId): LocalViewerSession {
  return { sessionId: id, kind: "comic", title: "固定漫画 - 第01话", pageCount: 3, sizeBytes: 1200, modifiedAt };
}

async function seedTasks(page: Page, local: LocalDownloadTask[] = [], engine: DownloadTask[] = []): Promise<void> {
  await page.addInitScript(({ localRecords, engineRecords }) => {
    localStorage.setItem("acgn-hub.local-download-tasks.v1", JSON.stringify(localRecords));
    localStorage.setItem("acgn-hub.download-tasks.v1", JSON.stringify(engineRecords));
  }, { localRecords: local, engineRecords: engine });
}

/** Replace only native boundaries in the service and this page's desktop check.
 * Production route resolution, service validation, stores and progress persistence
 * remain active; Tauri is never enabled globally and no user file is opened.
 */
async function simulateViewer(page: Page): Promise<ViewerSimulation> {
  const simulation: ViewerSimulation = {
    prepared: [], closed: [], opened: [], images: [], brokenImages: new Set(),
    imageSizes: Array.from({ length: 3 }, () => ({ width: 480, height: 720 })),
    prepare: async () => comicSession(),
  };
  await page.exposeFunction("__e2eLocalViewerCommand", async (command: string, input: NativeRequest & { sessionId?: string }) => {
    if (command === "prepare_local_viewer") { simulation.prepared.push(input); return simulation.prepare(input); }
    if (command === "close_local_viewer") { simulation.closed.push(input.sessionId!); return; }
    if (command === "open_downloaded_media") { simulation.opened.push(input); return; }
    throw new Error("Unexpected viewer native command: " + command);
  });
  await page.route(/\/src\/infrastructure\/media\/local-viewer-service\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const nativeImport = /import\s*\{\s*convertFileSrc\s*,\s*invoke\s*\}\s*from\s*["'][^"']+["'];?/;
    const runtimeImport = /import\s*\{[^}]*\bisTauriRuntime\b[^}]*\}\s*from\s*["'][^"']+["'];?/;
    if (!nativeImport.test(source) || !runtimeImport.test(source)) throw new Error("Local viewer native boundary import changed");
    await route.fulfill({ response, body: source.replace(nativeImport, `
      const invoke = (command, args) => window.__e2eLocalViewerCommand(command, args);
      const convertFileSrc = (path, protocol) => {
        if (protocol !== "acgn-local") throw new Error("Unexpected viewer protocol");
        // Match Tauri's native URL conversion: its entire filePath argument is
        // encoded, so passing protocol routing slashes here must fail the exact
        // fixture path matcher rather than being silently repaired by the mock.
        return new URL("/__e2e-local-viewer/" + encodeURIComponent(path), location.origin).href;
      };`).replace(runtimeImport, "const isTauriRuntime = () => true; const isAndroidRuntime = () => false;") });
  });
  await page.route(/\/src\/pages\/DownloadsPage\.vue(?:\?.*)?$/, async (route) => {
    if (new URL(route.request().url()).searchParams.has("vue")) return route.continue();
    const response = await route.fetch();
    const source = await response.text();
    const runtimeImport = /import\s*\{[^}]*\bisTauriRuntime\b[^}]*\}\s*from\s*["'][^"']+["'];?/;
    if (!runtimeImport.test(source)) throw new Error("DownloadsPage desktop boundary import changed");
    await route.fulfill({ response, body: source.replace(runtimeImport, "const isTauriRuntime = () => true; const isAndroidRuntime = () => false;") });
  });
  await page.route("**/__e2e-local-viewer/**", async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/__e2e-local-viewer\/([a-f0-9]{32})\/page\/(\d+)$/);
    if (match) {
      const index = Number(match[2]);
      simulation.images.push({ sessionId: match[1], index });
      if (simulation.brokenImages.has(match[1] + ":" + index)) {
        // A successful transport containing damaged bytes exercises image decode
        // failure without browser network errors being hidden by the fixture.
        return route.fulfill({ status: 200, contentType: "image/png", body: "damaged-page", headers: { "Cache-Control": "no-store" } });
      }
      const { width, height } = simulation.imageSizes[index];
      return route.fulfill({ status: 200, contentType: "image/svg+xml", headers: { "Cache-Control": "no-store" },
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${["#eee1f4", "#d3e8f0", "#e9e4ce"][index]}"/><text x="60" y="120" font-size="50">Page ${index + 1}</text></svg>` });
    }
    if (/\/[a-f0-9]{32}\/video$/.test(url.pathname)) {
      // A small PCM metadata stream tests the actual media element and fallback
      // controls. It does not stand in for native MP4/HEVC decoding verification.
      const samples = 8_000;
      const wav = Buffer.alloc(44 + samples * 2);
      wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(16_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
      return route.fulfill({ status: 200, contentType: "audio/wav", body: wav, headers: { "Cache-Control": "no-store" } });
    }
    throw new Error("Unexpected local viewer fixture URL: " + url.pathname);
  });
  return simulation;
}

function localRow(page: Page, title: string) {
  return page.locator("article.task-row").filter({ has: page.locator(".task-title-line strong", { hasText: title }) });
}

async function expectComicPage(page: Page, number: number, width = 480): Promise<void> {
  const image = page.getByRole("img", { name: `固定漫画 - 第01话，第 ${number} 页`, exact: true });
  await expect(image).toHaveAttribute("src", `http://127.0.0.1:1420/__e2e-local-viewer/${comicSessionId}/page/${number - 1}`);
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty("complete", true);
  await expect(image).toHaveJSProperty("naturalWidth", width);
  await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue(String(number));
}

async function chooseSinglePageMode(page: Page): Promise<void> {
  const mode = page.getByRole("button", { name: "单页翻页", exact: true });
  await mode.click();
  await expect(mode).toHaveAttribute("aria-pressed", "true");
}

async function waitDownloadReady(page: Page): Promise<void> {
  // Route-leave closes the session before the lazy Downloads module finishes
  // loading. Wait for rendered task rows before teardown disposes responses.
  await expect(page).toHaveURL(/#\/downloads$/);
  await expect(page.getByRole("heading", { name: "下载中心", exact: true })).toBeVisible();
  await expect(page.locator("article.task-row").first()).toBeVisible();
}

test("phone comic swipes distinguish vertical reading and support WebView immersive fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const saved = localTask("phone-comic", "manga", "固定漫画 - 第01话.cbz");
  await simulateViewer(page);
  await seedTasks(page, [saved]);
  await page.goto("/#/viewer/local/phone-comic");
  await chooseSinglePageMode(page);
  await expectComicPage(page, 1);
  await page.evaluate(() => { Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: undefined }); });
  await page.getByRole("button", { name: "全屏观看", exact: true }).click();
  await expect(page.locator(".viewer-surface")).toHaveClass(/is-immersive/);
  await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一页 →", exact: true })).toBeInViewport();
  const stage = page.locator('[aria-label="漫画阅读区域"]');
  const swipe = async (x: number, y: number) => stage.evaluate((element, delta) => {
    const rect = element.getBoundingClientRect();
    const origin = { identifier: 1, target: element, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
    const start = new Touch(origin);
    element.dispatchEvent(new TouchEvent("touchstart", { touches: [start], changedTouches: [start], bubbles: true }));
    const end = new Touch({ ...origin, clientX: origin.clientX + delta.x, clientY: origin.clientY + delta.y });
    element.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [end], bubbles: true }));
  }, { x, y });
  await swipe(-15, -100);
  await expectComicPage(page, 1);
  await swipe(-100, 10);
  await expectComicPage(page, 2);
  await swipe(100, -5);
  await expectComicPage(page, 1);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "下一页 →", exact: true })).toBeInViewport();
  const stageBounds = await stage.boundingBox();
  expect(stageBounds!.height).toBeGreaterThan(80);
  await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  await expect(page.locator(".viewer-surface")).not.toHaveClass(/is-immersive/);
  await expect(page.getByRole("navigation", { name: "手机主导航", exact: true })).toBeVisible();
});

test("completed CBZ opens inside the app, turns pages and restores the last successfully read page", async ({ page }) => {
  const saved = localTask("comic-completed", "manga", "固定漫画 - 第01话.cbz");
  const simulation = await simulateViewer(page);
  await seedTasks(page, [saved]);
  await page.goto("/#/downloads");
  await localRow(page, saved.title).getByRole("button", { name: "阅读漫画", exact: true }).click();
  await expect(page).toHaveURL(/#\/viewer\/local\/comic-completed$/);
  await chooseSinglePageMode(page);
  await expectComicPage(page, 1);
  await expect(page.getByRole("button", { name: "← 上一页", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "下一页 →", exact: true }).click();
  await expectComicPage(page, 2);
  await page.getByRole("spinbutton", { name: "跳转页码" }).fill("3");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await expectComicPage(page, 3);
  await expect(page.getByRole("button", { name: "下一页 →", exact: true })).toBeDisabled();
  await page.locator('[aria-label="漫画阅读区域"]').focus();
  await page.keyboard.press("Home");
  await expectComicPage(page, 1);
  await page.keyboard.press("ArrowRight");
  await expectComicPage(page, 2);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toEqual([comicSessionId]);
  await localRow(page, saved.title).getByRole("button", { name: "阅读漫画", exact: true }).click();
  await chooseSinglePageMode(page);
  await expectComicPage(page, 2);
  expect(simulation.prepared).toEqual([{ path: saved.outputPath, allowedRoot: directory }, { path: saved.outputPath, allowedRoot: directory }]);
  expect(simulation.opened).toEqual([]);
});

test("completed TXT is rendered as plain text and preserves an internal reading experience", async ({ page }) => {
  const saved = localTask("novel-completed", "novel", "固定轻小说 - 第一卷.txt");
  const text = "第一章\n<script>window.__viewerInjected = true</script>\n<img src=x onerror=window.__viewerInjected=true>\n这是下载完成的正文。";
  const simulation = await simulateViewer(page);
  simulation.prepare = async () => ({ sessionId: novelSessionId, kind: "text", title: saved.title, sizeBytes: 320, modifiedAt, text });
  await seedTasks(page, [saved]);
  await page.goto("/#/downloads");
  await localRow(page, saved.title).getByRole("button", { name: "阅读小说", exact: true }).click();
  const body = page.getByRole("article", { name: "小说正文", exact: true });
  await expect(body).toContainText("第一章");
  await expect(body).toContainText("<script>window.__viewerInjected = true</script>");
  await expect(body).toContainText("<img src=x onerror=window.__viewerInjected=true>");
  await expect(body.locator("script,img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __viewerInjected?: boolean }).__viewerInjected)).toBeUndefined();
  await page.getByRole("button", { name: "放大字号", exact: true }).click();
  await expect(body).toHaveCSS("font-size", "20px");
  await page.locator("summary", { hasText: "阅读设置" }).click();
  await page.getByRole("combobox", { name: "小说纸色", exact: true }).selectOption("sage");
  await expect(page.locator(".viewer-surface")).toHaveClass(/paper-sage/);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toEqual([novelSessionId]);
});

test("multi-file engine viewing requires a registered safe file and offers system fallback", async ({ page }) => {
  const files = [directory + "\\Batch\\EP01.mkv", directory + "\\Batch\\EP02.mp4", directory + "\\Batch\\install.bat"];
  const saved = engineTask("engine-batch", files);
  const simulation = await simulateViewer(page);
  simulation.prepare = async () => ({ sessionId: videoSessionId, kind: "video", title: "EP02.mp4", sizeBytes: 16044, modifiedAt });
  await seedTasks(page, [], [saved]);
  await page.goto("/#/downloads");
  const row = localRow(page, saved.filename!);
  const view = row.getByRole("button", { name: "应用内播放", exact: true });
  await expect(view).toBeDisabled();
  const choose = row.getByRole("combobox", { name: "选择打开文件", exact: true });
  await expect(choose.getByRole("option")).toHaveText(["先选择一个文件", "EP01.mkv", "EP02.mp4"]);
  await choose.selectOption(files[1]);
  await view.click();
  await expect(page).toHaveURL(/#\/viewer\/engine\/engine-batch\?file=/);
  await expect(page.locator('[aria-label="本地视频区域"] video')).toHaveAttribute("controls", "");
  await expect(page.locator("video")).toHaveAttribute("src", `http://127.0.0.1:1420/__e2e-local-viewer/${videoSessionId}/video`);
  await page.locator("video").evaluate((element) => element.dispatchEvent(new Event("error")));
  await expect(page.getByRole("alert")).toContainText("无法读取或解码此文件");
  await page.getByRole("button", { name: "使用系统播放器", exact: true }).click();
  expect(simulation.opened).toEqual([{ path: files[1], allowedRoot: directory, preferSystem: true }]);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toEqual([videoSessionId]);
  for (const invalid of ["D:\\Secrets\\private.mp4", files[2], directory + "\\Batch\\not-registered.mp4"]) {
    await page.evaluate((file) => { location.hash = "/viewer/engine/engine-batch?file=" + encodeURIComponent(file); }, invalid);
    await expect(page.getByRole("heading", { name: "暂时无法打开", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("选择一个已完成的文件");
    await expect(page.locator("video")).toHaveCount(0);
  }
  expect(simulation.prepared).toEqual([{ path: files[1], allowedRoot: directory }]);
});

test("old same-path completed history cannot enter the reader or prepare a native session", async ({ page }) => {
  const previous = localTask("comic-old", "manga", "固定漫画 - 第01话.cbz", { title: "旧漫画成品", cleanupPaths: undefined });
  const current = { ...previous, id: "comic-current", title: "当前漫画成品", cleanupPaths: [{ path: previous.outputPath, allowedRoot: directory }], createdAt: "2026-10-31T01:00:00Z" };
  const simulation = await simulateViewer(page);
  await seedTasks(page, [previous, current]);
  await page.goto("/#/downloads");
  await expect(localRow(page, previous.title).getByRole("button", { name: "阅读漫画", exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = "/viewer/local/comic-old"; });
  await expect(page.getByRole("alert")).toContainText("此任务已不再拥有该成品");
  expect(simulation.prepared).toEqual([]);
  await page.getByRole("link", { name: "回到下载中心", exact: true }).click();
  await waitDownloadReady(page);
  await localRow(page, current.title).getByRole("button", { name: "阅读漫画", exact: true }).click();
  await chooseSinglePageMode(page);
  await expectComicPage(page, 1);
  expect(simulation.prepared).toEqual([{ path: current.outputPath, allowedRoot: directory }]);
});

test("a native preparation failure is visible and retry opens the same registered output", async ({ page }) => {
  const saved = localTask("prepare-retry", "manga", "固定漫画 - 第01话.cbz");
  const simulation = await simulateViewer(page);
  let attempts = 0;
  simulation.prepare = async () => {
    if (++attempts === 1) throw new Error("固定样本：压缩包暂时被其它程序占用");
    return comicSession();
  };
  await seedTasks(page, [saved]);
  await page.goto("/#/viewer/local/prepare-retry");
  await expect(page.getByRole("alert")).toContainText("固定样本：压缩包暂时被其它程序占用");
  await page.getByRole("button", { name: "重新尝试", exact: true }).click();
  await chooseSinglePageMode(page);
  await expectComicPage(page, 1);
  expect(simulation.prepared).toEqual([{ path: saved.outputPath, allowedRoot: directory }, { path: saved.outputPath, allowedRoot: directory }]);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toEqual([comicSessionId]);
});

test("a damaged page can be retried without advancing saved reading progress", async ({ page }) => {
  const saved = localTask("page-retry", "manga", "固定漫画 - 第01话.cbz");
  const simulation = await simulateViewer(page);
  simulation.brokenImages.add(comicSessionId + ":1");
  await seedTasks(page, [saved]);
  await page.goto("/#/viewer/local/page-retry");
  await chooseSinglePageMode(page);
  await expectComicPage(page, 1);
  await page.getByRole("button", { name: "下一页 →", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("第 2 页读取失败");
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("acgn-hub.viewer-progress.v1:")).map((key) => localStorage.getItem(key)));
  expect(stored).toEqual(["0"]);
  simulation.brokenImages.clear();
  await page.getByRole("button", { name: "重试这一页", exact: true }).click();
  await expectComicPage(page, 2);
  expect(simulation.prepared).toHaveLength(1);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toEqual([comicSessionId]);
});

test("a late preparation result is closed after rapid route changes and never replaces the current reader", async ({ page }) => {
  const slow = localTask("slow-comic", "manga", "固定漫画 - 第01话.cbz");
  const novel = localTask("current-novel", "novel", "当前轻小说.txt");
  const simulation = await simulateViewer(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  simulation.prepare = async (request) => {
    if (request.path === slow.outputPath) { await pending; return comicSession(); }
    return { sessionId: novelSessionId, kind: "text", title: novel.title, sizeBytes: 12, modifiedAt, text: "当前轻小说正文" };
  };
  await seedTasks(page, [slow, novel]);
  await page.goto("/#/viewer/local/slow-comic");
  await expect.poll(() => simulation.prepared.length).toBe(1);
  try {
    await page.evaluate(() => { location.hash = "/viewer/local/current-novel"; });
    await expect(page.getByRole("article", { name: "小说正文", exact: true })).toHaveText("当前轻小说正文");
  } finally { release(); }
  await expect.poll(() => simulation.closed).toContain(comicSessionId);
  await expect(page.getByRole("heading", { name: novel.title, exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /固定漫画/ })).toHaveCount(0);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect(localRow(page, novel.title).getByRole("button", { name: "阅读小说", exact: true })).toBeEnabled();
  await expect.poll(() => [...simulation.closed].sort()).toEqual([comicSessionId, novelSessionId].sort());
});

test("fullscreen keeps mouse page controls, page jumps and exit inside the active reader", async ({ page }) => {
  const saved = localTask("fullscreen-comic", "manga", "固定漫画 - 第01话.cbz");
  await simulateViewer(page);
  await seedTasks(page, [saved]);
  await page.goto("/#/viewer/local/fullscreen-comic");
  await chooseSinglePageMode(page);
  await expectComicPage(page, 1);
  await page.getByRole("button", { name: "全屏观看", exact: true }).click();
  const fullscreen = page.locator(".viewer-surface:fullscreen");
  await expect(fullscreen).toBeVisible();
  await expect(fullscreen.getByRole("button", { name: "退出全屏", exact: true })).toBeInViewport();
  await expect(fullscreen.getByRole("button", { name: "← 上一页", exact: true })).toBeInViewport();
  await expect(fullscreen.getByRole("button", { name: "下一页 →", exact: true })).toBeInViewport();
  await expect(fullscreen.getByRole("spinbutton", { name: "跳转页码", exact: true })).toBeInViewport();
  await fullscreen.getByRole("button", { name: "全屏下一页", exact: true }).click();
  await expectComicPage(page, 2);
  await fullscreen.getByRole("spinbutton", { name: "跳转页码", exact: true }).fill("3");
  await fullscreen.getByRole("button", { name: "跳转", exact: true }).click();
  await expectComicPage(page, 3);
  await fullscreen.getByRole("button", { name: "← 上一页", exact: true }).click();
  await expectComicPage(page, 2);
  await fullscreen.getByRole("button", { name: "退出全屏", exact: true }).click();
  await expect(page.locator(":fullscreen")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "全屏观看", exact: true })).toBeVisible();
});

for (const mode of ["native", "webview-fallback"] as const) {
  test(`fullscreen survives loading the next novel volume and exits cleanly (${mode})`, async ({ page }) => {
    if (mode === "webview-fallback") await page.setViewportSize({ width: 390, height: 844 });
    const first = localTask("fullscreen-novel-1", "novel", "星海物语 - 第1卷.txt", {
      reading: { mediaId: "fullscreen-novel", seriesTitle: "星海物语", unitTitle: "第1卷", unitNumber: 1 },
    });
    const second = localTask("fullscreen-novel-2", "novel", "星海物语 - 第2卷.txt", {
      reading: { mediaId: "fullscreen-novel", seriesTitle: "星海物语", unitTitle: "第2卷", unitNumber: 2 },
    });
    let finishPreparation!: () => void;
    const preparing = new Promise<void>((resolve) => { finishPreparation = resolve; });
    const simulation = await simulateViewer(page);
    simulation.prepare = async (request) => {
      const next = request.path === second.outputPath;
      if (next) await preparing;
      return { sessionId: next ? chapterTwoSessionId : chapterOneSessionId, kind: "text", title: next ? second.title : first.title,
        sizeBytes: 1000, modifiedAt, text: `第一章\n${next ? "第二卷正文" : "第一卷正文"}\n${"这是小说正文。".repeat(120)}` };
    };
    await seedTasks(page, [first, second]);
    await page.goto("/#/viewer/local/fullscreen-novel-1");
    await expect(page.getByRole("article", { name: "小说正文", exact: true })).toContainText("第一卷正文");
    if (mode === "webview-fallback") await page.evaluate(() => {
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: undefined });
    });
    await page.getByRole("button", { name: "全屏观看", exact: true }).click();
    const reader = page.locator(".viewer-surface");
    const fullscreen = page.locator(mode === "native" ? ".viewer-surface:fullscreen" : ".viewer-surface.is-immersive");
    await expect(fullscreen).toBeVisible();
    const originalSurface = await reader.elementHandle();
    await reader.getByRole("button", { name: "下一话 / 卷", exact: true }).click();
    await expect(page).toHaveURL(/#\/viewer\/local\/fullscreen-novel-2$/);
    await expect(reader).toHaveAttribute("aria-busy", "true");
    await expect(reader.getByRole("status")).toContainText("正在打开你的本地文件");
    await expect(fullscreen).toBeVisible();
    await expect(reader.getByRole("button", { name: "退出全屏", exact: true })).toBeInViewport();
    finishPreparation();
    await expect(reader.getByRole("article", { name: "小说正文", exact: true })).toContainText("第二卷正文");
    await expect(reader).toHaveAttribute("aria-busy", "false");
    expect(await originalSurface!.evaluate((element) => element.isConnected && element === document.querySelector(".viewer-surface"))).toBe(true);
    await expect(fullscreen).toBeVisible();
    await reader.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(fullscreen).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "全屏观看", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/viewer-immersive/);
    // OS/browser exit and the fallback Escape path must update the label too.
    await reader.getByRole("button", { name: "全屏观看", exact: true }).click();
    await expect(fullscreen).toBeVisible();
    if (mode === "native") await page.evaluate(() => document.exitFullscreen());
    else await page.keyboard.press("Escape");
    await expect(fullscreen).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "全屏观看", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/viewer-immersive/);
    await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
    await waitDownloadReady(page);
    await expect.poll(() => [...simulation.closed].sort()).toEqual([chapterOneSessionId, chapterTwoSessionId].sort());
  });
}

test("continuous reading loads nearby pages on scroll, restores progress and switches back to single pages", async ({ page }) => {
  const saved = localTask("continuous-comic", "manga", "固定漫画 - 第01话.cbz");
  const simulation = await simulateViewer(page);
  simulation.imageSizes = [{ width: 600, height: 900 }, { width: 600, height: 1600 }, { width: 900, height: 600 }];
  await seedTasks(page, [saved]);
  await page.goto("/#/downloads");
  await localRow(page, saved.title).getByRole("button", { name: "阅读漫画", exact: true }).click();
  await expect(page.getByRole("button", { name: "连续滚动", exact: true })).toHaveAttribute("aria-pressed", "true");
  const stage = page.locator('[aria-label="漫画阅读区域"]');
  const placeholders = stage.locator("[data-page-index]");
  await expect(placeholders).toHaveCount(3);
  await expectComicPage(page, 1, 600);
  await expect(placeholders.nth(1).locator("img")).toHaveJSProperty("naturalWidth", 600);
  await expect(placeholders.nth(1).locator("img")).toHaveJSProperty("naturalHeight", 1600);
  // Loading an adjacent portrait page may resize its placeholder; it must not
  // change the current successfully displayed reading position.
  await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("1");
  await expect(placeholders.nth(2).locator("img")).toHaveCount(0);
  expect(simulation.images.every((request) => request.index <= 1)).toBe(true);
  const positions = await placeholders.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
  expect(positions[0]).toBeLessThan(positions[1]);
  expect(positions[1]).toBeLessThan(positions[2]);
  await stage.hover();
  await page.mouse.wheel(0, 1_000);
  await expectComicPage(page, 2, 600);
  await expect.poll(() => simulation.images.some((request) => request.index === 2)).toBe(true);
  await expect(placeholders.nth(2).locator("img")).toHaveJSProperty("naturalHeight", 600);
  await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("2");
  await page.mouse.wheel(0, 2_000);
  await expectComicPage(page, 3, 900);
  await expect(placeholders.nth(0).locator("img")).toHaveCount(0);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toEqual([comicSessionId]);
  await localRow(page, saved.title).getByRole("button", { name: "阅读漫画", exact: true }).click();
  await expect(page.getByRole("button", { name: "连续滚动", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectComicPage(page, 3, 900);
  await expect.poll(() => stage.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await chooseSinglePageMode(page);
  await expect(stage.locator("[data-page-index]")).toHaveCount(0);
  await expectComicPage(page, 3, 900);
  await page.getByRole("button", { name: "← 上一页", exact: true }).click();
  await expectComicPage(page, 2, 600);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toEqual([comicSessionId, comicSessionId]);
});

test("completed chapters auto-continue only within the same work and leave unrelated works out of the queue", async ({ page }) => {
  const first = localTask("series-chapter-1", "manga", "星海物语 - 第1话.cbz", {
    reading: { mediaId: "media-series-a", seriesTitle: "星海物语", unitTitle: "第1话", unitNumber: 1 },
  });
  const second = localTask("series-chapter-2", "manga", "星海物语 - 第2话.cbz", {
    reading: { mediaId: "media-series-a", seriesTitle: "星海物语", unitTitle: "第2话", unitNumber: 2 },
  });
  const unrelated = localTask("other-chapter-2", "manga", "星河物语 - 第2话.cbz", {
    reading: { mediaId: "media-series-b", seriesTitle: "星河物语", unitTitle: "第2话", unitNumber: 2 },
  });
  const simulation = await simulateViewer(page);
  simulation.prepare = async (request) => request.path === first.outputPath
    ? { sessionId: chapterOneSessionId, kind: "comic", title: "星海物语 · 第1话", pageCount: 1, sizeBytes: 100, modifiedAt }
    : { sessionId: chapterTwoSessionId, kind: "comic", title: "星海物语 · 第2话", pageCount: 1, sizeBytes: 100, modifiedAt };
  await seedTasks(page, [first, second, unrelated]);
  await page.goto("/#/viewer/local/series-chapter-1");
  await expect(page.getByRole("heading", { name: "星海物语 · 第1话", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "连续滚动", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "下一话 / 卷", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "自动接续已开启", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("combobox", { name: "作品章节目录", exact: true }).getByRole("option")).toHaveText(["第1话", "第2话"]);
  await expect(page.getByRole("img", { name: "星海物语 · 第1话，第 1 页", exact: true })).toHaveJSProperty("naturalWidth", 480);
  // Auto continuation is gated by user interaction and a successfully loaded
  // final page; reaching the end alone must not move to another work.
  const readingStage = page.locator('[aria-label="漫画阅读区域"]');
  await readingStage.hover();
  await page.mouse.wheel(0, 1200);
  await expect(page.getByRole("status")).toContainText(/秒后继续/);
  await expect(page.getByRole("heading", { name: "星海物语 · 第2话", exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page).toHaveURL(/#\/viewer\/local\/series-chapter-2$/);
  await expect(page.getByRole("heading", { name: "星河物语", exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "自动接续已开启", exact: true }).click();
  await expect(page.getByRole("button", { name: "自动接续已关闭", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一话 / 卷", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toContain(chapterOneSessionId);
  await expect.poll(() => simulation.closed).toContain(chapterTwoSessionId);
  // The unrelated work was seeded as completed but was never prepared or routed.
  expect(simulation.prepared.map((request) => request.path)).not.toContain(unrelated.outputPath);
});

test("plain-text novel exposes chapter navigation, reading controls and restores its position", async ({ page }) => {
  const saved = localTask("novel-reader", "novel", "星海物语 - 第一卷.txt", {
    reading: { mediaId: "novel-series-a", seriesTitle: "星海物语", unitTitle: "第一卷", unitNumber: 1 },
  });
  const text = [
    "序章", "这是序章正文。".repeat(100), "第二章 星光", "这是第二章正文。".repeat(100),
    "第三章 远航", "这是第三章正文。".repeat(100),
  ].join("\n\n");
  const simulation = await simulateViewer(page);
  simulation.prepare = async () => ({ sessionId: novelSessionId, kind: "text", title: saved.title, sizeBytes: text.length, modifiedAt, text });
  await seedTasks(page, [saved]);
  await page.goto("/#/viewer/local/novel-reader");
  const body = page.getByRole("article", { name: "小说正文", exact: true });
  await expect(body).toContainText("序章");
  const contents = page.getByRole("combobox", { name: "小说章节目录", exact: true });
  await expect(contents.getByRole("option")).toHaveText(["序章", "第二章 星光", "第三章 远航"]);
  await contents.selectOption({ label: "第二章 星光" });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.locator("summary", { hasText: "阅读设置" }).click();
  await page.getByRole("combobox", { name: "小说行距", exact: true }).selectOption("2.4");
  await page.getByRole("combobox", { name: "小说纸色", exact: true }).selectOption("sage");
  await expect(body).toHaveCSS("line-height", "45.6px");
  await expect(page.locator(".viewer-surface")).toHaveClass(/paper-sage/);
  await contents.selectOption({ label: "第三章 远航" });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(localStorage).find((entry) => entry.startsWith("acgn-hub.viewer-progress.v1:"));
    return key ? Number(localStorage.getItem(key)) : 0;
  })).toBeGreaterThan(0);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await expect.poll(() => simulation.closed).toEqual([novelSessionId]);
  await page.evaluate(() => { location.hash = "/viewer/local/novel-reader"; });
  await expect(page.getByRole("article", { name: "小说正文", exact: true })).toBeVisible();
  await expect.poll(() => page.getByRole("article", { name: "小说正文", exact: true }).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("combobox", { name: "小说章节目录", exact: true }).locator("option:checked")).toHaveText("第三章 远航");
});

for (const mode of ["native", "webview-fallback"] as const) {
  test(`a short final novel chapter remains selected at the bottom and after reopening (${mode})`, async ({ page }) => {
    if (mode === "webview-fallback") await page.setViewportSize({ width: 390, height: 844 });
    const saved = localTask("short-final-chapter", "novel", "星海物语 - 第一卷.txt");
    const text = ["第一章 启程", "旅程中的正文。".repeat(800), "第二章 尾声", "终点的短篇正文。"].join("\n\n");
    const simulation = await simulateViewer(page);
    simulation.prepare = async () => ({ sessionId: novelSessionId, kind: "text", title: saved.title, sizeBytes: text.length, modifiedAt, text });
    await seedTasks(page, [saved]);
    await page.goto("/#/viewer/local/short-final-chapter");
    const contents = page.getByRole("combobox", { name: "小说章节目录", exact: true });
    const body = page.getByRole("article", { name: "小说正文", exact: true });
    await contents.selectOption({ label: "第二章 尾声" });
    await expect.poll(() => body.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    await expect(body.getByRole("heading", { name: "第二章 尾声", exact: true })).toBeInViewport();
    // A short final chapter cannot scroll to the top. Waiting for a settled
    // scroll event must not move the contents selector back to chapter one.
    await expect.poll(async () => {
      await page.waitForTimeout(350);
      return contents.locator("option:checked").textContent();
    }).toBe("第二章 尾声");
    if (mode === "webview-fallback") await page.evaluate(() => {
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: undefined });
    });
    await page.getByRole("button", { name: "全屏观看", exact: true }).click();
    const fullscreen = page.locator(mode === "native" ? ".viewer-surface:fullscreen" : ".viewer-surface.is-immersive");
    await expect(fullscreen).toBeVisible();
    await expect(contents.locator("option:checked")).toHaveText("第二章 尾声");
    await expect(body.getByRole("heading", { name: "第二章 尾声", exact: true })).toBeInViewport();
    if (mode === "native") await page.evaluate(() => document.exitFullscreen());
    else await page.keyboard.press("Escape");
    await expect(fullscreen).toHaveCount(0);
    await expect(body.getByRole("heading", { name: "第二章 尾声", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "全屏观看", exact: true }).click();
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(contents.locator("option:checked")).toHaveText("第二章 尾声");
    if (mode === "native") await page.setViewportSize({ width: 1200, height: 800 });
    else {
      await page.getByRole("button", { name: "全屏观看", exact: true }).click();
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(body.getByRole("heading", { name: "第二章 尾声", exact: true })).toBeInViewport();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    }
    await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
    await waitDownloadReady(page);
    await page.evaluate(() => { location.hash = "/viewer/local/short-final-chapter"; });
    await expect(body.getByRole("heading", { name: "第二章 尾声", exact: true })).toBeInViewport();
    await expect(contents.locator("option:checked")).toHaveText("第二章 尾声");
  });
}

test("a short landscape final comic page becomes current at the bottom and is restored", async ({ page }) => {
  const saved = localTask("short-final-comic", "manga", "固定漫画 - 第01话.cbz");
  const simulation = await simulateViewer(page);
  simulation.imageSizes = [{ width: 600, height: 900 }, { width: 600, height: 900 }, { width: 1200, height: 100 }];
  await seedTasks(page, [saved]);
  await page.goto("/#/viewer/local/short-final-comic");
  await expectComicPage(page, 1, 600);
  await page.getByRole("spinbutton", { name: "跳转页码" }).fill("3");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  const stage = page.locator('[aria-label="漫画阅读区域"]');
  const last = stage.locator('[data-page-index="2"]');
  await expect(last.locator("img")).toHaveJSProperty("naturalWidth", 1200);
  await expect(last).toBeInViewport();
  await expect.poll(() => stage.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("3");
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await page.evaluate(() => { location.hash = "/viewer/local/short-final-comic"; });
  await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("3");
  await expect(stage.locator('[data-page-index="2"] img')).toHaveJSProperty("naturalWidth", 1200);
});

test("a short final comic page auto-continues only after reading and supports cancellation", async ({ page }) => {
  const first = localTask("short-page-series-1", "manga", "星海物语 - 第1话.cbz", {
    reading: { mediaId: "short-page-series", seriesTitle: "星海物语", unitTitle: "第1话", unitNumber: 1 },
  });
  const second = localTask("short-page-series-2", "manga", "星海物语 - 第2话.cbz", {
    reading: { mediaId: "short-page-series", seriesTitle: "星海物语", unitTitle: "第2话", unitNumber: 2 },
  });
  const simulation = await simulateViewer(page);
  simulation.imageSizes = [{ width: 600, height: 900 }, { width: 600, height: 900 }, { width: 1200, height: 100 }];
  simulation.prepare = async (request) => request.path === first.outputPath
    ? { ...comicSession(chapterOneSessionId), title: first.title }
    : { ...comicSession(chapterTwoSessionId), title: second.title };
  await seedTasks(page, [first, second]);
  await page.goto("/#/viewer/local/short-page-series-1");
  const stage = page.locator('[aria-label="漫画阅读区域"]');
  await stage.hover();
  await page.mouse.wheel(0, 20_000);
  await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("3");
  await expect(page.getByRole("status")).toContainText(/秒后继续/);
  await page.getByRole("button", { name: "取消本次接续", exact: true }).click();
  await page.waitForTimeout(3500);
  await expect(page).toHaveURL(/#\/viewer\/local\/short-page-series-1$/);
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "下一话 →", exact: true }).click();
  await expect(page).toHaveURL(/#\/viewer\/local\/short-page-series-2$/);
  await expect(page.getByRole("heading", { name: second.title, exact: true })).toBeVisible();
});

test("novel end continuation waits for reading, can be cancelled and never repeats on reopen", async ({ page }) => {
  const first = localTask("short-novel-series-1", "novel", "星海物语 - 第1卷.txt", {
    reading: { mediaId: "short-novel-series", seriesTitle: "星海物语", unitTitle: "第1卷", unitNumber: 1 },
  });
  const second = localTask("short-novel-series-2", "novel", "星海物语 - 第2卷.txt", {
    reading: { mediaId: "short-novel-series", seriesTitle: "星海物语", unitTitle: "第2卷", unitNumber: 2 },
  });
  const simulation = await simulateViewer(page);
  simulation.prepare = async (request) => ({ sessionId: request.path === first.outputPath ? chapterOneSessionId : chapterTwoSessionId,
    kind: "text", title: request.path === first.outputPath ? first.title : second.title, sizeBytes: 1000, modifiedAt,
    text: ["第一章 启程", "旅程中的正文。".repeat(300), "第二章 尾声", "终点的短篇正文。"].join("\n\n") });
  await seedTasks(page, [first, second]);
  await page.goto("/#/viewer/local/short-novel-series-1");
  await page.getByRole("combobox", { name: "小说章节目录", exact: true }).selectOption({ label: "第二章 尾声" });
  await expect(page.getByRole("status")).toContainText(/秒后继续/);
  await page.getByRole("button", { name: "取消本次接续", exact: true }).click();
  await page.waitForTimeout(3500);
  await expect(page).toHaveURL(/#\/viewer\/local\/short-novel-series-1$/);
  await page.getByRole("link", { name: "← 返回下载", exact: true }).click();
  await waitDownloadReady(page);
  await page.evaluate(() => { location.hash = "/viewer/local/short-novel-series-1"; });
  await expect(page.getByRole("combobox", { name: "小说章节目录", exact: true }).locator("option:checked")).toHaveText("第二章 尾声");
  await page.waitForTimeout(3500);
  await expect(page).toHaveURL(/#\/viewer\/local\/short-novel-series-1$/);
  await expect(page.getByRole("status")).toHaveCount(0);
  const body = page.getByRole("article", { name: "小说正文", exact: true });
  await body.hover();
  await page.mouse.wheel(0, -300);
  await page.mouse.wheel(0, 1000);
  await expect(page.getByRole("status")).toContainText(/秒后继续/);
  await expect(page).toHaveURL(/#\/viewer\/local\/short-novel-series-2$/, { timeout: 7000 });
});
