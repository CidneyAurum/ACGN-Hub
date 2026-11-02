import { expect, it, vi } from "vitest";
import { joinWindowsPath, sanitizeFileName, sanitizeMobileFileName } from "@/domain/organization";
import { MobileHttpClient } from "@/infrastructure/download/mobile-http-client";
import { DownloadManager } from "@/application/download-manager";
import type { TaskRepository } from "@/application/ports";
import type { DownloadTask } from "@/domain/download";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const encoder = new TextEncoder();

it.each([
  ["无职转生とある異世界の物語".repeat(20), ".txt"],
  ["長い日本語の漫画作品と物語".repeat(20), ".cbz"],
  ["月🌸📚ものがたり".repeat(30), ".7z.001"],
  ["汉化版ゲーム🎮".repeat(30), ".part01.rar"],
  ["物語".repeat(120), ".tar.gz"],
])("bounds UTF-8 output components and preserves the full %s extension %s", (stem, suffix) => {
  const name = sanitizeMobileFileName(stem + suffix);
  expect(encoder.encode(name).length).toBeLessThanOrEqual(220);
  expect(name.endsWith(suffix)).toBe(true);
  expect(new TextDecoder().decode(encoder.encode(name))).toBe(name);
  expect(sanitizeMobileFileName(name)).toBe(name);
  const path = joinWindowsPath("/data/user/0/local.acgnhub.mobile/files/Files/Library", "漫画".repeat(120), name);
  for (const part of path.split("/")) expect(encoder.encode(part).length).toBeLessThanOrEqual(220);
});

it("preserves split archive stems, distinguishes truncated titles and leaves ordinary Windows names unchanged", () => {
  const stem = "中文原版と日本語ゲーム🌸".repeat(40);
  const first = sanitizeMobileFileName(stem + ".7z.001");
  const second = sanitizeMobileFileName(stem + ".7z.002");
  expect(first.slice(0, -7)).toBe(second.slice(0, -7));
  const nine = sanitizeMobileFileName(stem + ".part9.rar");
  const ten = sanitizeMobileFileName(stem + ".part10.rar");
  expect(nine.replace(/\.part\d+\.rar$/, "")).toBe(ten.replace(/\.part\d+\.rar$/, ""));
  expect(sanitizeMobileFileName(stem + "A.txt")).not.toBe(sanitizeMobileFileName(stem + "B.txt"));
  expect(sanitizeMobileFileName("文学少女 - 第01卷.txt")).toBe("文学少女 - 第01卷.txt");
  const legacySplitEmoji = sanitizeMobileFileName("旧名字\uD83C.txt");
  expect(new TextDecoder().decode(encoder.encode(legacySplitEmoji))).toBe(legacySplitEmoji);
  expect(joinWindowsPath("D:\\Books", "原书名".repeat(80) + ".txt")).toBe("D:\\Books\\" + sanitizeFileName("原书名".repeat(80) + ".txt"));
});

it("uses the same safe filename in persisted mobile tasks and the native command", async () => {
  let records: DownloadTask[] = [];
  const repository: TaskRepository = {
    initialize: async () => {}, list: async () => records,
    insert: async (task) => { records.push(task); }, update: async (task) => { records = records.map((item) => item.id === task.id ? task : item); },
    remove: async () => {}, findById: async (id) => records.find((item) => item.id === id),
  };
  const engine = new MobileHttpClient();
  const manager = new DownloadManager({ repository, engine: () => engine,
    settings: () => ({ httpDownloadEngine: "mobile_http", maxConcurrentDownloads: 1, speedLimitBytesPerSecond: 0 }), onChange: () => {} });
  const raw = "漢字🌸ゲーム原版".repeat(45) + ".zip.001";
  invoke.mockResolvedValue({ engineTaskId: "mobile", state: "queued" });
  // The runtime directory validator intentionally remains active; use Windows
  // syntax here while selecting the mobile engine explicitly at the port.
  await manager.add("https://files.example.org/archive", "D:\\Incoming", { filename: raw });
  expect(records[0].filename).toBe(sanitizeMobileFileName(raw));
  expect(invoke).toHaveBeenLastCalledWith("mobile_http_start", expect.objectContaining({ filename: records[0].filename }));
});
