import { describe, expect, it } from "vitest";
import type { Media } from "@/domain/media";
import { buildOrganizationPlan, detectEpisode, isPathInside, sanitizeFileName } from "@/domain/organization";

const anime: Media = {
  id: "bangumi:123",
  type: "anime",
  title: "葬送的芙莉莲",
  aliases: [],
  externalIds: [],
  metadata: {},
};

describe("organization planning", () => {
  it("sanitizes Windows names and reserved device names", () => {
    expect(sanitizeFileName('CON: episode? 01.')).toBe("CON_ episode_ 01");
    expect(sanitizeFileName("CON")).toBe("_CON");
    expect(sanitizeFileName("...", "fallback")).toBe("fallback");
  });

  it("detects common anime episode patterns", () => {
    expect(detectEpisode("Frieren - S01E07 - 1080p")).toEqual({ season: 1, episode: 7 });
    expect(detectEpisode("作品 2x03")).toEqual({ season: 2, episode: 3 });
    expect(detectEpisode("作品 Episode 12")).toEqual({ season: 1, episode: 12 });
  });

  it("builds a safe, deterministic anime destination", () => {
    const plan = buildOrganizationPlan({
      taskId: "task-1",
      sourcePath: "D:\\ACGN\\Incoming\\Frieren - S01E07 - 1080p.mkv",
      incomingRoot: "D:\\ACGN\\Incoming",
      libraryRoot: "D:\\ACGN\\Library",
      media: anime,
    });

    expect(plan).toMatchObject({
      destinationPath: "D:\\ACGN\\Library\\Anime\\葬送的芙莉莲\\Season 01\\葬送的芙莉莲 S01E07 [1080p].mkv",
      mediaId: "bangumi:123",
    });
    expect(isPathInside("D:\\ACGN\\Library", plan.destinationPath)).toBe(true);
  });

  it("rejects source paths outside Incoming", () => {
    expect(() => buildOrganizationPlan({
      taskId: "task-1",
      sourcePath: "D:\\ACGN\\Other\\episode.mkv",
      incomingRoot: "D:\\ACGN\\Incoming",
      libraryRoot: "D:\\ACGN\\Library",
      media: anime,
    })).toThrow("Incoming");
  });

  it("rejects parent-directory traversal segments", () => {
    expect(() => buildOrganizationPlan({
      taskId: "task-3",
      sourcePath: "D:\\ACGN\\Incoming\\..\\Other\\episode.mkv",
      incomingRoot: "D:\\ACGN\\Incoming",
      libraryRoot: "D:\\ACGN\\Library",
      media: anime,
    })).toThrow("父目录");
  });

  it("marks anime files without a recognizable episode", () => {
    const plan = buildOrganizationPlan({
      taskId: "task-2",
      sourcePath: "D:\\ACGN\\Incoming\\special.mkv",
      incomingRoot: "D:\\ACGN\\Incoming",
      libraryRoot: "D:\\ACGN\\Library",
      media: anime,
    });

    expect(plan.warning).toBe("episode_unresolved");
    expect(plan.destinationPath).toContain("\\Unmatched\\葬送的芙莉莲\\special.mkv");
  });

  it("uses a manual episode override", () => {
    const plan = buildOrganizationPlan({
      taskId: "task-4",
      sourcePath: "D:\\ACGN\\Incoming\\special.mkv",
      incomingRoot: "D:\\ACGN\\Incoming",
      libraryRoot: "D:\\ACGN\\Library",
      media: anime,
      episodeOverride: { season: 2, episode: 4 },
    });

    expect(plan.warning).toBeUndefined();
    expect(plan.destinationPath).toContain("\\Anime\\葬送的芙莉莲\\Season 02\\葬送的芙莉莲 S02E04.mkv");
  });

  it("preserves UNC shares when planning organization on a network drive", () => {
    const plan = buildOrganizationPlan({ taskId: "nas", sourcePath: "\\\\nas\\media\\Incoming\\Frieren S01E01.mkv", incomingRoot: "\\\\nas\\media\\Incoming", libraryRoot: "\\\\nas\\media\\Library", media: anime });
    expect(plan.sourcePath).toBe("\\\\nas\\media\\Incoming\\Frieren S01E01.mkv");
    expect(plan.destinationPath.startsWith("\\\\nas\\media\\Library\\Anime\\")).toBe(true);
  });

  it("rejects a parent segment at the end of a path rather than stripping it", () => {
    expect(() => buildOrganizationPlan({ taskId: "parent", sourcePath: "D:\\Incoming\\..", incomingRoot: "D:\\Incoming", libraryRoot: "D:\\Library", media: anime })).toThrow("父目录");
  });
});
