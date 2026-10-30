import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: ".work/e2e/test-results",
  reporter: [["list"], ["html", { outputFolder: ".work/e2e/report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:1420",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: process.env.E2E_PREVIEW === "1"
      ? "npm run build && npx vite preview --host 127.0.0.1 --port 1420 --strictPort"
      : "npm run dev -- --host 127.0.0.1 --port 1420 --strictPort",
    url: "http://127.0.0.1:1420",
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
