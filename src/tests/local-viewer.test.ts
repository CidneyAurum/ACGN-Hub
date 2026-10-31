import { describe, expect, it } from "vitest";
import type { DownloadTask } from "@/domain/download";
import type { LocalDownloadTask } from "@/domain/local-download";
import {
  clampComicPage, clampVideoPosition, comicPageWindow, getLocalViewerKind, localViewerProgressKey,
  readLocalViewerProgress, resolveLocalViewerTarget, writeLocalViewerProgress,
} from "@/domain/local-viewer";

const localTask: LocalDownloadTask = { id: "chapter", kind: "manga", title: "作品 · 第01话", sourceName: "漫画来源", directory: "D:\\Books", outputPath: "D:\\Books\\作品 - 第01话.cbz", stage: "completed", completedUnits: 12, totalUnits: 12, createdAt: "2026-10-31", updatedAt: "2026-10-31" };
const engineTask: DownloadTask = { id: "episode", engineId: "aria2", directory: "D:\\Incoming", sourceUrl: "magnet:?xt=urn:btih:test", protocol: "magnet", state: "completed", files: ["D:\\Incoming\\01.mp4", "D:\\Incoming\\02.mkv"], totalBytes: 100, completedBytes: 100, speedBytesPerSecond: 0, dedupeKey: "test", createdAt: "2026-10-31", updatedAt: "2026-10-31" };
const input = { collection: "local", id: localTask.id, localTasks: [localTask], engineTasks: [engineTask], ownedLocalOutput: () => localTask.outputPath, configuredRoots: ["D:\\Library"] };

describe("current local viewing targets", () => {
  it("opens the currently owned completed file and ignores no unregistered paths", () => {
    expect(resolveLocalViewerTarget(input)).toEqual({ path: localTask.outputPath, allowedRoot: localTask.directory, title: localTask.title, kind: "comic" });
    expect(() => resolveLocalViewerTarget({ ...input, file: "D:\\Secrets\\outside.cbz" })).toThrow("额外");
    expect(() => resolveLocalViewerTarget({ ...input, ownedLocalOutput: () => undefined })).toThrow("不再拥有");
    expect(() => resolveLocalViewerTarget({ ...input, localTasks: [{ ...localTask, stage: "downloading" }] })).toThrow("尚未完成");
    expect(() => resolveLocalViewerTarget({ ...input, localTasks: [{ ...localTask, outputPath: "D:\\Books\\renamed.cbz" }] })).toThrow("不再拥有");
  });

  it("requires a current registered choice for engine multi-file downloads", () => {
    const engine = { ...input, collection: "engine", id: engineTask.id };
    expect(() => resolveLocalViewerTarget(engine)).toThrow("选择一个");
    expect(resolveLocalViewerTarget({ ...engine, file: engineTask.files[1] })).toMatchObject({ path: engineTask.files[1], kind: "video", allowedRoot: engineTask.directory });
    for (const file of ["D:\\Incoming\\unknown.mp4", "D:\\Other\\01.mp4", [engineTask.files[0]], "", "D:\\Incoming\\..\\Other\\01.mp4"]) {
      expect(() => resolveLocalViewerTarget({ ...engine, file })).toThrow();
    }
  });

  it("revalidates renamed and organized engine paths instead of keeping stale choices", () => {
    const engine = { ...input, collection: "engine", id: engineTask.id, engineTasks: [{ ...engineTask, files: [engineTask.files[0]], finalPath: "D:\\Library\\作品.mp4" }] };
    expect(resolveLocalViewerTarget(engine)).toMatchObject({ path: "D:\\Library\\作品.mp4", allowedRoot: "D:\\Library" });
    expect(() => resolveLocalViewerTarget({ ...engine, file: engineTask.files[0] })).toThrow("当前登记");
    expect(() => resolveLocalViewerTarget({ ...engine, configuredRoots: [] })).toThrow();
    expect(() => resolveLocalViewerTarget({ ...engine, engineTasks: [{ ...engineTask, state: "cancelled" }] })).toThrow("尚未完成");
  });

  it("rejects unsupported formats and invalid task routes", () => {
    expect(getLocalViewerKind("第1话.CBZ")).toBe("comic");
    expect(getLocalViewerKind("volume.TXT")).toBe("text");
    expect(getLocalViewerKind("episode.MKV")).toBe("video");
    for (const path of ["book.epub", "book.pdf", "script.html", "video.mp4.exe", "chapter.zip", "a.cbz?path=secret"]) expect(getLocalViewerKind(path)).toBeUndefined();
    for (const route of [{ collection: "other" }, { id: [] }, { id: "" }, { id: "missing" }]) expect(() => resolveLocalViewerTarget({ ...input, ...route })).toThrow();
  });
});

describe("local reading position", () => {
  it("separates same-path replacement files by size and precise modification time", () => {
    const identity = { kind: "comic" as const, sizeBytes: 100, modifiedAt: "1793400000000000000" };
    const first = localViewerProgressKey(localTask.outputPath, identity);
    expect(localViewerProgressKey(localTask.outputPath, identity)).toBe(first);
    expect(localViewerProgressKey(localTask.outputPath, { ...identity, sizeBytes: 101 })).not.toBe(first);
    expect(localViewerProgressKey(localTask.outputPath, { ...identity, modifiedAt: "1793400000000000001" })).not.toBe(first);
    expect(localViewerProgressKey(localTask.outputPath + "x", identity)).not.toBe(first);
  });

  it("ignores damaged progress and survives unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readLocalViewerProgress(storage, "new")).toBeUndefined();
    expect(writeLocalViewerProgress(storage, "comic", 4)).toBe(true);
    expect(readLocalViewerProgress(storage, "comic")).toBe(4);
    for (const raw of ["bad", '"4"', "{}", "-1", "null", "1e999"]) { values.set("bad", raw); expect(readLocalViewerProgress(storage, "bad")).toBeUndefined(); }
    expect(writeLocalViewerProgress(storage, "comic", NaN)).toBe(false);
    const broken = { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("full"); } };
    expect(readLocalViewerProgress(broken, "comic")).toBeUndefined();
    expect(writeLocalViewerProgress(broken, "comic", 3)).toBe(false);
  });

  it("clamps pages and restores video time only after valid metadata", () => {
    expect(clampComicPage(30, 12)).toBe(11);
    expect(clampComicPage(-5, 12)).toBe(0);
    expect(clampComicPage(3.9, 12)).toBe(3);
    expect(clampComicPage(NaN, 12)).toBe(0);
    expect(clampVideoPosition(80, 100)).toBe(80);
    expect(clampVideoPosition(200, 100)).toBe(99.9);
    for (const duration of [NaN, Infinity, 0, -1]) expect(clampVideoPosition(80, duration)).toBeUndefined();
    expect(clampVideoPosition(-1, 100)).toBeUndefined();
    expect(clampVideoPosition(undefined, 100)).toBeUndefined();
  });

  it("keeps continuous reading to at most the current image and its neighbours", () => {
    expect(comicPageWindow(0, 17)).toEqual([0, 1]);
    expect(comicPageWindow(8, 17)).toEqual([7, 8, 9]);
    expect(comicPageWindow(16, 17)).toEqual([15, 16]);
    expect(comicPageWindow(999, 17)).toEqual([15, 16]);
    expect(comicPageWindow(-1, 17)).toEqual([0, 1]);
    expect(comicPageWindow(0, 0)).toEqual([]);
    expect(comicPageWindow(0, 1)).toEqual([0]);
  });
});
