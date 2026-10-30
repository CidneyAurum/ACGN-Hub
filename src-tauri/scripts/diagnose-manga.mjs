import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const mode = process.argv[2] || "direct";
const directory = resolve(".work/native-manga-diagnostics", `${mode}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const profile = resolve(directory, "profile");
const executable = resolve("src-tauri/target/release/acgn-hub.exe");
const evidence = { mode, directory, events: [] };
const started = Date.now();
function record(event, data = {}) {
  const entry = { elapsedMs: Date.now() - started, event, ...data };
  evidence.events.push(entry); console.log(JSON.stringify(entry));
}
const environment = { ...process.env, ACGN_HUB_DATA_DIR: profile };
if (mode.includes("no-cdp")) delete environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
else environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223";
const breakaway = mode.includes("breakaway");
const app = spawn(breakaway ? "python" : executable, breakaway ? [resolve("src-tauri/scripts/diagnose-launch.py"), executable] : [], { cwd: resolve("."), env: environment, windowsHide: !mode.includes("visible"), stdio: [breakaway ? "pipe" : "ignore", "pipe", "pipe"] });
let applicationPid = app.pid;
record("app.spawned", { pid: app.pid });
let stdout = "", stderr = "";
app.stdout.on("data", (bytes) => { stdout += bytes.toString(); const match = stdout.match(/"applicationPid":\s*(\d+)/); if (match && applicationPid === app.pid) { applicationPid = Number(match[1]); record("app.breakaway.pid", { pid: applicationPid }); } });
app.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
app.on("exit", (code, signal) => record("app.exit", { code, signal }));
let browser;
let debuggerProcess;
let debuggerOutput = "";
try {
  if (mode.includes("no-cdp")) {
    record("idle.no_cdp.wait.begin");
    await new Promise((done) => setTimeout(done, 30000));
    record("idle.no_cdp.wait.end", { appExitCode: app.exitCode });
  } else {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`App exited before CDP: ${app.exitCode}`);
    try { const response = await fetch("http://127.0.0.1:9223/json/list"); const pages = await response.json(); if (pages.some((page) => page.url.includes("tauri.localhost"))) break; } catch { /* Starting. */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  browser.on("disconnected", () => record("browser.disconnected"));
  const originalClose = browser.close.bind(browser);
  browser.close = async (...args) => { record("browser.close.called", { stack: new Error().stack }); return originalClose(...args); };
  let page;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("tauri.localhost"));
    if (page) break;
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!page) throw new Error("Native page missing");
  page.on("close", () => record("page.close"));
  page.on("crash", () => record("page.crash"));
  page.on("pageerror", (error) => record("page.error", { message: error.message }));
  record("cdp.connected");
  if (mode.includes("gdb")) {
    const commands = resolve(directory, "exit-breakpoints.gdb");
    await writeFile(commands, `set pagination off\nset confirm off\nset breakpoint pending on\nhandle SIGSEGV nostop noprint pass\nbreak RtlExitUserProcess\ncommands\nsilent\nprintf "INTERNAL_RTL_EXIT\\n"\nbt\ninfo registers rcx rdx rip rsp\ncontinue\nend\nbreak NtTerminateProcess\ncommands\nsilent\nprintf "INTERNAL_NT_TERMINATE\\n"\nbt\ninfo registers rcx rdx rip rsp\ncontinue\nend\necho DEBUGGER_READY\\n\ncontinue\n`);
    debuggerProcess = spawn("C:/msys64/ucrt64/bin/gdb.exe", ["--quiet", "--batch", "--pid", String(applicationPid), "--command", commands], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (bytes) => { const message = bytes.toString(); debuggerOutput += message; process.stdout.write(message); };
    debuggerProcess.stdout.on("data", collect); debuggerProcess.stderr.on("data", collect);
    for (let attempt = 0; attempt < 100 && !debuggerOutput.includes("DEBUGGER_READY"); attempt += 1) await new Promise((done) => setTimeout(done, 100));
    record("debugger.ready", { confirmed: debuggerOutput.includes("DEBUGGER_READY") });
  }
  if (mode.startsWith("idle")) {
    record("idle.wait.begin");
    await new Promise((done) => setTimeout(done, 12000));
    record("idle.wait.end", { appExitCode: app.exitCode });
  } else if (mode.startsWith("direct")) {
    const resource = JSON.parse(await readFile(".work/real-workflow/requested-title-resource.json", "utf8"));
    const descriptor = resource.manga.descriptor;
    const incomingRoot = resolve(profile, "Files/Incoming"); const tempDirectory = resolve(incomingRoot, "direct-one-image");
    record("direct.invoke.start");
    const result = await page.evaluate(async ({ imageUrl, incomingRoot, tempDirectory, referer }) => {
      return window.__TAURI_INTERNALS__.invoke("download_manga_images", { imageUrls: [imageUrl], incomingRoot, tempDirectory, referer, cookie: null });
    }, { imageUrl: descriptor.imageUrls[0], incomingRoot, tempDirectory, referer: descriptor.referer });
    record("direct.invoke.finished", { pages: result.imagePaths.length });
  } else {
    await page.evaluate(() => { location.hash = "/resources?type=manga&q=" + encodeURIComponent("脑洞学生会"); });
    await page.locator(".resource-search-panel select").waitFor();
    await page.locator(".resource-search-panel select").selectOption("builtin:copymanga");
    await page.locator('.resource-search-panel form button[type="submit"]').click();
    await page.locator(".resource-work-card").first().waitFor({ timeout: 45000 });
    await page.locator(".resource-work-card").first().getByRole("button", { name: "选择作品并查看资源", exact: true }).click();
    await page.locator(".subject-find-button").waitFor(); await page.locator(".subject-find-button").click();
    await page.locator(".subject-resource-item").first().waitFor({ timeout: 45000 });
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem("acgn-hub.local-download-tasks.v1") || "[]").map((task) => task.id));
    record("ui.download.click");
    await page.locator(".subject-resource-item").first().getByRole("button").click();
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const task = await page.evaluate((before) => JSON.parse(localStorage.getItem("acgn-hub.local-download-tasks.v1") || "[]").find((task) => !before.includes(task.id)), before);
      record("ui.download.state", { stage: task?.stage, completed: task?.completedUnits, total: task?.totalUnits });
      if (task && ["completed", "cancelled", "failed"].includes(task.stage)) { evidence.task = task; break; }
      await new Promise((done) => setTimeout(done, 2000));
    }
  }
  await new Promise((done) => setTimeout(done, 3000)); record("verification.finished", { appExitCode: app.exitCode });
  }
} catch (error) {
  record("verification.failed", { message: String(error) }); process.exitCode = 1;
} finally {
  record("cleanup.browser.close.begin");
  if (browser) await browser.close().catch((error) => record("cleanup.browser.close.error", { message: String(error) }));
  record("cleanup.browser.close.end", { appExitCode: app.exitCode });
  await new Promise((done) => setTimeout(done, 1000));
  if (app.exitCode === null) { record("cleanup.app.kill"); if (breakaway) app.stdin.write("stop\n"); else app.kill(); }
  await writeFile(resolve(directory, "result.json"), JSON.stringify(evidence, null, 2));
  await writeFile(resolve(directory, "stdout.log"), stdout); await writeFile(resolve(directory, "stderr.log"), stderr);
  await writeFile(resolve(directory, "debugger.log"), debuggerOutput);
}
