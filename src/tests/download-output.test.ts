import { describe, expect, it } from "vitest";
import type { DownloadTask } from "@/domain/download";
import { getCompletedDownloadFiles, getCompletedDownloadOutputs } from "@/domain/download-output";

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return { id: "completed", engineId: "aria2", directory: "D:\\Incoming", sourceUrl: "https://fixture.example/episode.torrent", protocol: "torrent", state: "completed", files: ["D:\\Incoming\\作品 - 第01话.mkv"], totalBytes: 100, completedBytes: 100, speedBytesPerSecond: 0, dedupeKey: "completed", createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", ...overrides };
}

describe("completed download output choices", () => {
  it("offers registered media for completed aria2 and qBittorrent tasks", () => {
    expect(getCompletedDownloadOutputs(task())).toEqual([{ path: "D:\\Incoming\\作品 - 第01话.mkv", allowedRoot: "D:\\Incoming", label: "作品 - 第01话.mkv" }]);
    expect(getCompletedDownloadOutputs(task({ engineId: "qbittorrent" }))).toHaveLength(1);
    for (const state of ["queued", "downloading", "paused", "failed", "cancelled"] as const) expect(getCompletedDownloadOutputs(task({ state }))).toEqual([]);
  });

  it("excludes executables, scripts and ambiguous extensions from mixed torrents", () => {
    const supported = ["MP4", "mkv", "webm", "m4v", "mov", "avi", "ts", "cbz", "txt", "epub", "pdf"];
    const rejected = ["exe", "bat", "cmd", "ps1", "js", "lnk", "url", "html", "zip", "mp4.exe", "mkv.part"];
    const files = [...supported, ...rejected].map((extension) => `D:\\Incoming\\asset.${extension}`);
    expect(getCompletedDownloadOutputs(task({ files })).map((file) => file.path)).toEqual(files.slice(0, supported.length));
  });

  it("normalizes Windows separators and case for containment and duplicate choices", () => {
    const files = ["d:/incoming/EP01.MKV", "D:\\INCOMING\\ep01.mkv", "D:\\Incoming\\Series\\EP02.mp4"];
    expect(getCompletedDownloadOutputs(task({ files })).map((file) => file.path)).toEqual([files[0], files[2]]);
  });

  it("rejects unregistered, relative, parent, sibling-prefix and device paths", () => {
    const files = ["D:\\Incoming-Other\\movie.mp4", "D:\\Incoming\\..\\Other\\movie.mp4", "relative.mp4", "D:episode.mkv", "\\\\.\\D:\\Incoming\\episode.mp4", "D:\\Incoming\\movie.mp4:evil", "D:\\Incoming"];
    expect(getCompletedDownloadOutputs(task({ files }), ["D:\\Other"])).toEqual([]);
    // A filename or tempPath alone is not a registered downloadable output.
    expect(getCompletedDownloadOutputs(task({ files: [], filename: "episode.mp4", tempPath: "D:\\Incoming\\episode.mp4" }))).toEqual([]);
  });

  it("prefers the final organized path only when an explicit allowed root contains it", () => {
    const organized = task({ finalPath: "D:\\Library\\Anime\\作品.mp4" });
    expect(getCompletedDownloadOutputs(organized, ["D:\\Library"])).toEqual([{ path: organized.finalPath, allowedRoot: "D:\\Library", label: "作品.mp4" }]);
    expect(getCompletedDownloadOutputs(organized)).toEqual([]);
    expect(getCompletedDownloadOutputs(task({ finalPath: "D:\\Library-Other\\作品.mp4" }), ["D:\\Library"])).toEqual([]);
    expect(getCompletedDownloadOutputs(task({ finalPath: "D:\\Library\\installer.exe" }), ["D:\\Library"])).toEqual([]);
  });

  it("retains absolute POSIX and UNC paths with real child boundaries", () => {
    expect(getCompletedDownloadOutputs(task({ directory: "/home/me/Incoming", files: ["/home/me/Incoming/series/a.mkv", "/home/me/Incoming-other/a.mkv"] }))).toHaveLength(1);
    expect(getCompletedDownloadOutputs(task({ directory: "\\\\server\\share\\Incoming", files: ["\\\\SERVER\\share\\incoming\\a.epub", "\\\\server\\share\\Incoming2\\a.epub"] }))).toHaveLength(1);
  });

  it("offers completed archives for export while rejecting control files and partial output", () => {
    const directory = "/data/user/0/local.acgnhub.mobile/files/Files";
    const files = [directory + "/Games/game.zip", directory + "/Books/小说.txt", directory + "/.http-tasks/task.json", directory + "/Incoming/a.zip.part", directory + "/Incoming/a.tmp", directory + "/../secret.zip", directory.toLowerCase() + "/Games/game.zip"];
    const completed = task({ directory, files });
    expect(getCompletedDownloadFiles(completed).map((item) => item.path)).toEqual(files.slice(0, 2));
    expect(getCompletedDownloadOutputs(completed).map((item) => item.path)).toEqual([files[1]]);
    expect(getCompletedDownloadFiles(task({ directory, files, state: "downloading" }))).toEqual([]);
    expect(getCompletedDownloadFiles(task({ directory, files, finalPath: "/other/game.zip" }))).toEqual([]);
  });
});
