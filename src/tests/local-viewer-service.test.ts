import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeLocalViewer, localViewerPageUrl, localViewerVideoUrl, openLocalViewerWithSystem, prepareLocalViewer,
} from "@/infrastructure/media/local-viewer-service";

const { invoke, convertFileSrc } = vi.hoisted(() => ({
  invoke: vi.fn(),
  // Match Tauri scripts/core.js and its official mockConvertFileSrc("windows"):
  // the entire filePath is encoded, so embedded slashes become %2F.
  convertFileSrc: vi.fn((path: string, protocol: string) => `http://${protocol}.localhost/${encodeURIComponent(path)}`),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc }));
const target = { path: "D:\\Books\\chapter.cbz", allowedRoot: "D:\\Books", kind: "comic" as const, title: "章节" };
const comic = { sessionId: "0123456789abcdef0123456789abcdef", kind: "comic", title: "章节.cbz", pageCount: 12, sizeBytes: 200, modifiedAt: "1234567890123456789", text: null };

describe("native local viewer service", () => {
  beforeEach(() => { vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); invoke.mockReset(); convertFileSrc.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("prepares only the validated target and builds token-based zero-indexed URLs", async () => {
    invoke.mockResolvedValueOnce(comic);
    await expect(prepareLocalViewer(target)).resolves.toEqual({ ...comic, text: undefined });
    expect(invoke).toHaveBeenCalledWith("prepare_local_viewer", { path: target.path, allowedRoot: target.allowedRoot });
    expect(localViewerPageUrl(comic.sessionId, 0)).toBe(`http://acgn-local.localhost/${comic.sessionId}/page/0`);
    expect(localViewerVideoUrl(comic.sessionId)).toBe(`http://acgn-local.localhost/${comic.sessionId}/video`);
    expect(convertFileSrc).toHaveBeenCalledWith(comic.sessionId, "acgn-local");
    for (const [converted] of convertFileSrc.mock.calls) expect(converted).not.toContain("/");
    expect(new URL(localViewerPageUrl(comic.sessionId, 3)).pathname.split("/")).toEqual(["", comic.sessionId, "page", "3"]);
  });

  it("accepts optional null fields but rejects corrupted or mismatched native results and revokes valid tokens", async () => {
    for (const patch of [{ kind: "video" }, { pageCount: 0 }, { pageCount: 1.5 }, { sizeBytes: -1 }, { modifiedAt: "" }, { text: null, title: "" }]) {
      invoke.mockResolvedValueOnce({ ...comic, ...patch }).mockResolvedValueOnce(undefined);
      await expect(prepareLocalViewer(target)).rejects.toThrow("无效");
      expect(invoke).toHaveBeenLastCalledWith("close_local_viewer", { sessionId: comic.sessionId });
    }
    invoke.mockResolvedValueOnce({ ...comic, kind: "text", pageCount: null, text: "<script>不会执行</script>" });
    await expect(prepareLocalViewer({ ...target, kind: "text", path: "D:\\Books\\volume.txt" })).resolves.toMatchObject({ kind: "text", text: "<script>不会执行</script>" });
  });

  it("rejects protocol traversal and unsafe page indices before generating a URL", async () => {
    for (const id of ["../secret", "id/video?x=1", "file:///C:/secret", "", "a".repeat(129)]) {
      expect(() => localViewerPageUrl(id, 0)).toThrow();
      expect(() => localViewerVideoUrl(id)).toThrow();
      await expect(closeLocalViewer(id)).rejects.toThrow();
    }
    for (const page of [-1, 1.2, NaN, Infinity]) expect(() => localViewerPageUrl(comic.sessionId, page)).toThrow();
    expect(convertFileSrc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the same checked root for system fallback and never launches browser preview", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await openLocalViewerWithSystem(target);
    expect(invoke).toHaveBeenCalledWith("open_downloaded_media", { path: target.path, allowedRoot: target.allowedRoot, preferSystem: true });
    await closeLocalViewer(comic.sessionId);
    expect(invoke).toHaveBeenLastCalledWith("close_local_viewer", { sessionId: comic.sessionId });
  });

  it("fails clearly outside the desktop without requesting filesystem access", async () => {
    vi.stubGlobal("window", {});
    await expect(prepareLocalViewer(target)).rejects.toThrow("桌面版");
    await expect(openLocalViewerWithSystem(target)).rejects.toThrow("桌面版");
    expect(invoke).not.toHaveBeenCalled();
  });
});
