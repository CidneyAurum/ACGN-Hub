import { describe, expect, it, vi } from "vitest";
import type { DownloadTask } from "@/domain/download";
import type { ResourceItem } from "@/domain/resource";
import { requiresFreshSourceTarget, resolveSourceDownloadTarget } from "@/application/refreshable-source-download";

const task: DownloadTask = { id: "game", resourceId: "itch_freeware:creator/game:12", mediaId: "work", engineId: "aria2", sourceUrl: "https://creator.itch.io/game?acgn_upload=12", protocol: "http", directory: "D:\\Games", state: "queued", files: [], totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0, dedupeKey: "game", createdAt: "2026-11-02", updatedAt: "2026-11-02" };
const resource: ResourceItem = { id: task.resourceId!, mediaId: "work", sourceId: "itch_freeware:https://itch.io", sourceItemId: "creator/game", title: "Game", protocol: "http", targetUrl: task.sourceUrl, metadata: { needsFreshDownloadTarget: true }, createdAt: "2026-11-02" };

describe("source-owned expiring downloads", () => {
  it("uses a current matching resource identity to obtain a fresh file link", async () => {
    const resolve = vi.fn(async () => ({ protocol: "http" as const, url: "https://cdn.example/game.zip?expires=new" }));
    expect(requiresFreshSourceTarget(task)).toBe(true);
    await expect(resolveSourceDownloadTarget(task, { findResource: async () => resource, resolve })).resolves.toMatchObject({ url: "https://cdn.example/game.zip?expires=new" });
    expect(resolve).toHaveBeenCalledWith(resource.id);
    expect(task.sourceUrl).toBe(resource.targetUrl);
  });

  it("refuses missing, mismatched or downgraded source records before issuing a download", async () => {
    for (const changed of [undefined, { ...resource, mediaId: "other-work" }, { ...resource, sourceId: "other-source" },
      { ...resource, targetUrl: "https://unknown.example/page" }, { ...resource, metadata: {} }]) {
      const resolve = vi.fn();
      await expect(resolveSourceDownloadTarget(task, { findResource: async () => changed, resolve })).rejects.toThrow("来源记录不可用");
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it("leaves normal sources on their original link and rejects a non-HTTPS refresh result", async () => {
    const normal = { ...task, resourceId: "normal-resource", sourceUrl: "https://example.test/book.epub" };
    const resolve = vi.fn(async () => ({ protocol: "http" as const, url: "http://cdn.example/game.zip" }));
    expect(requiresFreshSourceTarget(normal)).toBe(false);
    await expect(resolveSourceDownloadTarget(normal, { findResource: vi.fn(), resolve })).resolves.toMatchObject({ url: normal.sourceUrl });
    expect(resolve).not.toHaveBeenCalled();
    await expect(resolveSourceDownloadTarget(task, { findResource: async () => resource, resolve })).rejects.toThrow("HTTPS");
  });
});
