import { describe, expect, it } from "vitest";
import { buildCompletedDownloadName } from "@/domain/download-naming";
import type { DownloadTask } from "@/domain/download";
import type { Media } from "@/domain/media";
import type { ResourceItem } from "@/domain/resource";

const media: Media = { id: "bangumi:554779", type: "anime", title: "学生会也有洞！", aliases: ["脑洞学生会"], externalIds: [], metadata: {} };
function task(name: string, overrides: Partial<DownloadTask> = {}): DownloadTask {
  return { id: "task", engineId: "aria2", mediaId: media.id, sourceUrl: "https://mikanani.me/Download/test.torrent", protocol: "torrent", directory: "D:\\Incoming", filename: name,
    files: ["D:\\Incoming\\" + name], state: "completed", totalBytes: 416074928, completedBytes: 416074928, speedBytesPerSecond: 0, dedupeKey: "torrent:fixture", createdAt: "2026-10-30", updatedAt: "2026-10-30", ...overrides };
}
function resource(overrides: Partial<ResourceItem> = {}): ResourceItem {
  return { id: "resource", sourceId: "mikan", sourceItemId: "episode", mediaId: media.id, title: "[字幕组] 学生会也有洞 [01]", protocol: "torrent", targetUrl: "https://example.test/file.torrent", metadata: {}, createdAt: "2026-10-30", ...overrides };
}

describe("completed download naming proposals", () => {
  it("does not propose names for a path outside the task's registered file list", () => {
    expect(buildCompletedDownloadName({ task: task("Episode 2.mkv"), media, filePath: "D:\\Other\\Episode 2.mkv" }).newFileName).toBeUndefined();
  });
  it("names the actual Kitauji style release in Chinese without inventing a resolution or season", () => {
    const download = task("[KitaujiSub] Seitokai ni mo Ana wa Aru [01][Uncensored][WebRip][HEVC_AAC][CHS].mp4");
    const result = buildCompletedDownloadName({ task: download, media });
    expect(result).toEqual({ filePath: download.files[0], newFileName: "学生会也有洞！ - 第01话 [简中] [HEVC].mp4" });
    expect(result.newFileName).not.toContain("1080");
    expect(result.newFileName).not.toContain("第01季");
  });

  it("uses known source episode, quality and Chinese language while preserving the original extension", () => {
    const result = buildCompletedDownloadName({ task: task("unknown.ΜP4"), media, resource: resource({ episode: 1, resolution: "1080p", language: "zh-CN" }) });
    expect(result.newFileName).toBeUndefined();
    const named = buildCompletedDownloadName({ task: task("unknown.MP4"), media, resource: resource({ episode: 1, resolution: "1080p", language: "zh-CN" }) });
    expect(named.newFileName).toBe("学生会也有洞！ - 第01话 [1080p] [简中].MP4");
  });

  it("prefers the saved Chinese title and can recover a real raw name_cn without translating", () => {
    const download = task("Episode 2.mkv");
    expect(buildCompletedDownloadName({ task: download, media: { ...media, title: "脑洞学生会", metadata: { raw: { name_cn: "其它中文名" } } } }).newFileName).toBe("脑洞学生会 - 第02话.mkv");
    expect(buildCompletedDownloadName({ task: download, media: { ...media, title: "Seitokai", metadata: { raw: { name_cn: "学生会也有洞！" } } } }).newFileName).toBe("学生会也有洞！ - 第02话.mkv");
    expect(buildCompletedDownloadName({ task: download, media: { ...media, title: "生徒会にも穴はある！", metadata: { raw: { name_cn: "学生会也有洞！" } } } }).newFileName).toBe("学生会也有洞！ - 第02话.mkv");
    expect(buildCompletedDownloadName({ task: download, media: { ...media, title: "Known English Title" } }).newFileName).toBe("Known English Title - 第02话.mkv");
  });

  it("recognizes explicit seasons and the supported episode forms without defaulting to season one", () => {
    for (const [name, expected] of [
      ["Title S02E03 1080p H.264 CHT.mkv", "学生会也有洞！ - 第02季 第03话 [1080p] [繁中] [H264].mkv"],
      ["作品 第7集.mp4", "学生会也有洞！ - 第07话.mp4"],
      ["Title EP05 [AV1].webm", "学生会也有洞！ - 第05话 [AV1].webm"],
      ["Title - 06 [720p].mp4", "学生会也有洞！ - 第06话 [720p].mp4"],
      ["Title [000].mkv", "学生会也有洞！ - 第00话.mkv"],
    ]) expect(buildCompletedDownloadName({ task: task(name), media }).newFileName).toBe(expected);
    expect(buildCompletedDownloadName({ task: task("Title [04].mkv"), media, resource: resource({ metadata: { season: 3 } }) }).newFileName).toBe("学生会也有洞！ - 第03季 第04话.mkv");
  });

  it("does not mistake dates, quality, codec or a CRC for episode numbers", () => {
    for (const name of ["Title [2026] [1080p] [HEVC] [ABC123EF].mp4", "Title - 2026-10-07.mp4", "Title [720].mp4", "Title [265].mkv", "Title [01.5].mkv", "Title [20261007].mp4", "Title [01][02].mp4"]) {
      const result = buildCompletedDownloadName({ task: task(name), media });
      expect(result.newFileName, name).toBeUndefined();
      expect(result.reason).toBeTruthy();
    }
  });

  it("keeps specials and packs intact rather than assigning their files a regular episode one", () => {
    for (const name of ["Title [OVA] [01].mkv", "Title SP [01].mp4", "Title [SP01].mkv", "Title [OVA02].mp4", "Title [01-12] 1080p.mkv", "Title COMPLETE [01].mp4", "Title 特典 [01].mp4"]) {
      expect(buildCompletedDownloadName({ task: task(name), media, resource: resource({ episode: 1 }) }).newFileName, name).toBeUndefined();
    }
  });

  it("uses each file's episode for multi-file tasks instead of repeating resource.episode", () => {
    const download = task("pack", { files: ["D:\\Incoming\\Title [01].mp4", "D:\\Incoming\\Title [02].mp4"] });
    expect(buildCompletedDownloadName({ task: download, media, resource: resource({ episode: 99 }) }).newFileName).toBeUndefined();
    expect(buildCompletedDownloadName({ task: download, media, resource: resource({ episode: 99 }), filePath: download.files[1] }).newFileName).toBe("学生会也有洞！ - 第02话.mp4");
  });

  it("does not rename unfinished, unsupported or mismatched files", () => {
    for (const extension of [".exe", ".zip", ".ass", ".srt", ".jpg", ".torrent", ".mp4.exe"]) expect(buildCompletedDownloadName({ task: task("Title [01]" + extension), media }).newFileName).toBeUndefined();
    expect(buildCompletedDownloadName({ task: task("Title [01].mp4", { state: "downloading" }), media }).newFileName).toBeUndefined();
    expect(buildCompletedDownloadName({ task: task("Title [01].mp4"), media: { ...media, id: "wrong" } }).reason).toContain("不一致");
    expect(buildCompletedDownloadName({ task: task("Title [01].mp4"), resource: resource() }).newFileName).toBeUndefined();
  });

  it("keeps suffix and original extension within a full 180 UTF-16 filename and never creates a path", () => {
    const long = { ...media, title: '超长标题 / : ? < > \\ '.repeat(80) + "😀" };
    const result = buildCompletedDownloadName({ task: task("Title S02E123 [1080p][HEVC][CHS].MP4"), media: long });
    expect(result.newFileName!.length).toBeLessThanOrEqual(180);
    expect(result.newFileName).toMatch(/ - 第02季 第123话 \[1080p\] \[简中\] \[HEVC\]\.MP4$/);
    expect(result.newFileName).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
    expect(result.filePath).toBe("D:\\Incoming\\Title S02E123 [1080p][HEVC][CHS].MP4");
  });

  it("returns the same exact canonical basename for a no-op and does not decide overwrite conflicts", () => {
    const name = "学生会也有洞！ - 第01话 [1080p] [简中] [HEVC].mp4";
    expect(buildCompletedDownloadName({ task: task(name), media }).newFileName).toBe(name);
    const first = buildCompletedDownloadName({ task: task("A [01].mp4"), media });
    const second = buildCompletedDownloadName({ task: task("B [01].mp4"), media });
    expect(first.newFileName).toBe(second.newFileName);
    expect(first.filePath).not.toBe(second.filePath);
  });

  it("preserves an explicit manga chapter or novel volume label and leaves insufficient book metadata alone", () => {
    const manga = { ...media, type: "manga" as const };
    expect(buildCompletedDownloadName({ task: task("source.cbz"), media: manga, resource: resource({ metadata: { chapterName: "第01话 开始" } }) }).newFileName).toBe("学生会也有洞！ - 第01话 开始.cbz");
    expect(buildCompletedDownloadName({ task: task("source.txt"), media: { ...media, type: "novel" }, resource: resource({ metadata: { volumeTitle: "第一卷 相遇" } }) }).newFileName).toBe("学生会也有洞！ - 第一卷 相遇.txt");
    expect(buildCompletedDownloadName({ task: task("Readable - Chapter 01.cbz"), media: manga }).newFileName).toBeUndefined();
  });

  it("omits a conflicting resolution instead of claiming an unsupported quality and rejects conflicting seasons", () => {
    const result = buildCompletedDownloadName({ task: task("Title [01][720p].mp4"), media, resource: resource({ resolution: "1080p" }) });
    expect(result.newFileName).toBe("学生会也有洞！ - 第01话.mp4");
    expect(buildCompletedDownloadName({ task: task("Title S02E01.mp4"), media, resource: resource({ metadata: { season: 3 } }) }).reason).toContain("冲突");
  });
});
