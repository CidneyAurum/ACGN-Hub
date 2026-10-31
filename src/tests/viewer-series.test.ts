import { describe, expect, it } from "vitest";
import type { DownloadTask } from "@/domain/download";
import type { LocalDownloadTask } from "@/domain/local-download";
import { buildViewerSeries } from "@/domain/viewer-series";

const root = "D:\\ACGN-E2E\\Library";

function local(id: string, file: string, overrides: Partial<LocalDownloadTask> = {}): LocalDownloadTask {
  return {
    id, kind: "manga", title: file.replace(/\.cbz$/i, ""), sourceName: "漫画来源", directory: root,
    outputPath: `${root}\\${file}`, stage: "completed", completedUnits: 10, totalUnits: 10,
    createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", ...overrides,
  };
}

function engine(id: string, files: string[], overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id, engineId: "aria2", directory: root, sourceUrl: "https://fixture.example.test/file",
    protocol: "http", state: "completed", files, totalBytes: 100, completedBytes: 100,
    speedBytesPerSecond: 0, dedupeKey: id, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", ...overrides,
  };
}

function series(current: { collection: "local" | "engine"; id: string; file?: string }, localTasks: LocalDownloadTask[], engineTasks: DownloadTask[] = []) {
  return buildViewerSeries({ localTasks, engineTasks, configuredRoots: [root], current,
    ownedLocalOutput: (id) => localTasks.find((task) => task.id === id)?.outputPath });
}

describe("viewer series grouping", () => {
  it("sorts explicit manga chapters numerically and exposes next/previous routes", () => {
    const tasks = [
      local("ch10", "安達與島村 - 第10话.cbz", { reading: { mediaId: "bgm:1", seriesTitle: "安達與島村", unitTitle: "第10话", unitNumber: 10 } }),
      local("ch2", "安達與島村 - 第02话.cbz", { reading: { mediaId: "bgm:1", seriesTitle: "安達與島村", unitTitle: "第02话", unitNumber: 2 } }),
      local("ch1", "安達與島村 - 第01话.cbz", { reading: { mediaId: "bgm:1", seriesTitle: "安達與島村", unitTitle: "第01话", unitNumber: 1 } }),
    ];
    const result = series({ collection: "local", id: "ch2" }, tasks);
    expect(result.title).toBe("安達與島村");
    expect(result.items.map((item) => item.id)).toEqual(["ch1", "ch2", "ch10"]);
    expect(result.currentIndex).toBe(1);
    expect(result.previous?.id).toBe("ch1");
    expect(result.next).toMatchObject({ id: "ch10", route: { path: "/viewer/local/ch10" } });
  });

  it("does not bridge different media IDs, seasons, or same-looking titles", () => {
    const tasks = [
      local("one", "作品 - 第01话.cbz", { reading: { mediaId: "media:one", seriesTitle: "作品", unitNumber: 1 } }),
      local("two", "作品 - 第02话.cbz", { reading: { mediaId: "media:one", seriesTitle: "作品", unitNumber: 2 } }),
      local("other", "作品 - 第03话.cbz", { reading: { mediaId: "media:other", seriesTitle: "作品", unitNumber: 3 } }),
      local("season", "作品 S02E01.cbz", { reading: { mediaId: "media:one", seriesTitle: "作品", unitNumber: 1 } }),
      local("other-title", "作品！ - 第04话.cbz", { reading: { seriesTitle: "作品！", unitNumber: 4 } }),
    ];
    const result = series({ collection: "local", id: "one" }, tasks);
    expect(result.items.map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("keeps simplified/traditional legacy titles separate when no authoritative association exists", () => {
    const tasks = [
      local("simplified", "葬送的芙莉莲 - 第01话.cbz"),
      local("traditional", "葬送的芙莉蓮 - 第02话.cbz"),
    ];
    expect(series({ collection: "local", id: "simplified" }, tasks).items.map((item) => item.id)).toEqual(["simplified"]);
    expect(series({ collection: "local", id: "traditional" }, tasks).items.map((item) => item.id)).toEqual(["traditional"]);
  });

  it("excludes incomplete, unowned, unsupported and old same-path records", () => {
    const tasks = [
      local("current", "作品 - 第01话.cbz", { reading: { seriesTitle: "作品", unitNumber: 1 } }),
      local("pending", "作品 - 第02话.cbz", { stage: "packaging", reading: { seriesTitle: "作品", unitNumber: 2 } }),
      local("stale", "作品 - 第03话.cbz", { reading: { seriesTitle: "作品", unitNumber: 3 } }),
      local("text", "作品 - 第04话.txt", { kind: "novel", reading: { seriesTitle: "作品", unitNumber: 4 } }),
    ];
    const result = buildViewerSeries({ localTasks: tasks, engineTasks: [], configuredRoots: [root], current: { collection: "local", id: "current" },
      ownedLocalOutput: (id) => id === "stale" ? `${root}\\new-owner.cbz` : tasks.find((task) => task.id === id)?.outputPath });
    expect(result.items.map((item) => item.id)).toEqual(["current"]);
  });

  it("groups a completed engine batch only through registered outputs and a shared media ID", () => {
    const files = [`${root}\\Show [01].mp4`, `${root}\\Show [10].mp4`, `${root}\\Show [02].mp4`, `${root}\\install.exe`];
    const task = engine("batch", files, { mediaId: "anime:show", filename: "Show" });
    const result = series({ collection: "engine", id: "batch", file: files[1] }, [], [task]);
    expect(result.items.map((item) => item.path)).toEqual([files[0], files[2], files[1]]);
    expect(result.items.every((item) => item.route.query?.file === item.path)).toBe(true);
    expect(result.next).toBeUndefined();
  });

  it("does not merge bare numbered files from separate tasks or an untrusted directory", () => {
    const first = engine("first", [`${root}\\01.mp4`], { mediaId: undefined });
    const second = engine("second", [`${root}\\02.mp4`], { mediaId: undefined });
    expect(series({ collection: "engine", id: "first" }, [], [first, second]).items.map((item) => item.id)).toEqual(["first"]);
    const outside = engine("outside", ["D:\\Other\\03.mp4"]);
    expect(series({ collection: "engine", id: "outside" }, [], [outside]).items).toEqual([]);
  });

  it("rejects arbitrary current file paths and invalid current routes", () => {
    const task = local("one", "作品 - 第01话.cbz", { reading: { seriesTitle: "作品", unitNumber: 1 } });
    expect(series({ collection: "local", id: "one", file: task.outputPath }, [task]).items).toEqual([]);
    expect(series({ collection: "local", id: "one", file: "D:\\Secrets\\outside.cbz" }, [task]).items).toEqual([]);
    expect(series({ collection: "other" as "local", id: "one" }, [task]).items).toEqual([]);
  });

  it("groups explicit legacy title separators but preserves season and volume boundaries", () => {
    const tasks = [local("one", "安達與島村 - 第01话.cbz", { title: "安達與島村 · 第01话" }),
      local("two", "安達與島村 - 第02话.cbz", { title: "安達與島村 · 第02话" }),
      local("volume", "安達與島村 - 第01卷.cbz"),
      local("season", "安達與島村 第二季 - 第03话.cbz"),
      local("prefix", "安達與島村2 - 第04话.cbz"),
      local("nodelimiter", "安達與島村第05话.cbz")];
    expect(series({ collection: "local", id: "one" }, tasks).items.map((item) => item.id)).toEqual(["one", "two"]);
    expect(series({ collection: "local", id: "nodelimiter" }, tasks).items.map((item) => item.id)).toEqual(["nodelimiter"]);
  });

  it("keeps differing names and resolution tags out of an unassociated engine batch", () => {
    const files = [`${root}\\Show EP01.mp4`, `${root}\\Show EP02.mp4`, `${root}\\Other EP03.mp4`, `${root}\\Show [1080].mp4`];
    const task = engine("batch", files);
    expect(series({ collection: "engine", id: "batch", file: files[0] }, [], [task]).items.map((item) => item.path)).toEqual(files.slice(0, 2));
    expect(series({ collection: "engine", id: "batch", file: files[2] }, [], [task]).items.map((item) => item.path)).toEqual([files[2]]);
  });

  it("does not bridge season-marked files when authoritative metadata omits a season field", () => {
    const tasks = [
      local("s1", "作品 S01E01.cbz", { reading: { mediaId: "m", seriesTitle: "作品", unitNumber: 1 } }),
      local("s2", "作品 S02E01.cbz", { reading: { mediaId: "m", seriesTitle: "作品", unitNumber: 1 } }),
    ];
    expect(series({ collection: "local", id: "s1" }, tasks).items.map((item) => item.id)).toEqual(["s1"]);
  });

  it("never merges known distinct editions or legacy no-edition records of the same work", () => {
    const tasks = [
      local("new1", "new1.cbz", { reading: { mediaId: "m", editionId: "copy:new", seriesTitle: "安達與島村", unitNumber: 1 } }),
      local("new2", "new2.cbz", { reading: { mediaId: "m", editionId: "copy:new", seriesTitle: "安達與島村", unitNumber: 2 } }),
      local("old", "old.cbz", { reading: { mediaId: "m", editionId: "copy:old", seriesTitle: "安達與島村", unitNumber: 3 } }),
      local("legacy", "安達與島村 - 第04话.cbz", { reading: { mediaId: "m", seriesTitle: "安達與島村", unitNumber: 4 } }),
    ];
    expect(series({ collection: "local", id: "new1" }, tasks).items.map((item) => item.id)).toEqual(["new1", "new2"]);
    expect(series({ collection: "local", id: "old" }, tasks).items.map((item) => item.id)).toEqual(["old"]);
    expect(series({ collection: "local", id: "legacy" }, tasks).items.map((item) => item.id)).toEqual(["legacy"]);
  });

  it("keeps unknown units in a confirmed association with stable natural filename order", () => {
    const tasks = [local("ten", "special10.cbz", { reading: { mediaId: "manga:one", seriesTitle: "作品" } }),
      local("two", "special2.cbz", { reading: { mediaId: "manga:one", seriesTitle: "作品" } }),
      local("one", "第1话.cbz", { reading: { mediaId: "manga:one", seriesTitle: "作品", unitNumber: 1 } })];
    const result = series({ collection: "local", id: "two" }, tasks);
    expect(result.items.map((item) => item.id)).toEqual(["one", "two", "ten"]);
    expect(result.next?.id).toBe("ten");
  });

  it("matches a confirmed engine episode and generated local episode without crossing media kinds", () => {
    const tasks = [local("local", "作品 - 第01话.mp4", { kind: "video", reading: { mediaId: "anime:one", seriesTitle: "作品", unitNumber: 1 } }),
      local("comic", "作品 - 第02话.cbz", { reading: { mediaId: "anime:one", seriesTitle: "作品", unitNumber: 2 } })];
    const downloaded = engine("engine", [`${root}\\作品 - EP02.mkv`], { mediaId: "anime:one" });
    expect(series({ collection: "local", id: "local" }, tasks, [downloaded]).items.map((item) => item.id)).toEqual(["local", "engine"]);
  });

  it("rejects lexical traversal/outside-root local ownership even when the callback returns it", () => {
    for (const outputPath of ["D:\\Elsewhere\\作品 - 第02话.cbz", `${root}\\..\\Outside\\作品 - 第02话.cbz`, "relative.cbz"]) {
      const task = local("unsafe", "unused.cbz", { outputPath, reading: { seriesTitle: "作品", unitNumber: 2 } });
      expect(series({ collection: "local", id: "unsafe" }, [task]).items).toEqual([]);
    }
  });
});
