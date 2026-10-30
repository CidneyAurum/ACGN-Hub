import { describe, expect, it, vi } from "vitest";
import { QbittorrentClient, type QbittorrentRequest, type QbittorrentResponse } from "@/infrastructure/qbittorrent/qbittorrent-client";

function client(reply: (input: QbittorrentRequest) => QbittorrentResponse) {
  const request = vi.fn(async (input: QbittorrentRequest) => reply(input));
  return { request, client: new QbittorrentClient({ request }, "http://127.0.0.1:8080", { username: "test", password: "test" }) };
}
const torrent = { hash: "a".repeat(40), name: "Example", state: "downloading", total_size: 100, completed: 50, progress: 0.5, content_path: "C:\\Downloads\\Example", dlspeed: 10 };
describe("qBittorrent Web UI adapter", () => {
  it("keeps an app tag as a stable id while torrent metadata is pending", async () => {
    const f = client((input) => ({ status: 200, body: input.path.includes("/info") ? [] : "Ok." }));
    await expect(f.client.add({ protocol: "magnet", url: "magnet:?xt=urn:btih:" + "a".repeat(40) }, { directory: "C:\\Downloads", clientTag: "acgn-123" })).resolves.toMatch(/^tag:acgn-123#\d+$/);
    const add = f.request.mock.calls.find(([input]) => input.path.endsWith("/add"))?.[0];
    expect(new URLSearchParams(add?.body).get("tags")).toBe("acgn-123");
    expect(new URLSearchParams(add?.body).get("savepath")).toBe("C:\\Downloads");
  });
  it("reconciles an existing tag instead of submitting a duplicate", async () => {
    const f = client(() => ({ status: 200, body: [torrent] }));
    await f.client.add({ protocol: "torrent", url: "https://example.org/a.torrent" }, { directory: "C:\\Downloads", clientTag: "acgn-123" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("supports qBittorrent 4 pause and qBittorrent 5 stop endpoints", async () => {
    const f = client((input) => input.path.includes("/info") ? { status: 200, body: [torrent] } : { status: input.path.endsWith("/stop") ? 404 : 200, body: "" });
    await f.client.pause("tag:acgn-123");
    expect(f.request.mock.calls.map(([input]) => input.path)).toContain("/api/v2/torrents/pause");
  });
  it("maps stopped and completed states and keeps the content directory", async () => {
    const f = client(() => ({ status: 200, body: [{ ...torrent, state: "stoppedDL" }] }));
    await expect(f.client.status("hash")).resolves.toMatchObject({ state: "paused", files: [torrent.content_path] });
    f.request.mockResolvedValue({ status: 200, body: [{ ...torrent, progress: 1, completed: 100, amount_left: 0, state: "stalledUP" }] });
    await expect(f.client.status("hash")).resolves.toMatchObject({ state: "completed" });
  });
  it("cancels the remote task without deleting downloaded files", async () => {
    const f = client((input) => ({ status: 200, body: input.path.includes("/info") ? [torrent] : "" }));
    await f.client.cancel("hash");
    const deletion = f.request.mock.calls.find(([input]) => input.path.endsWith("/delete"))?.[0];
    expect(new URLSearchParams(deletion?.body).get("deleteFiles")).toBe("false");
  });
  it("maps credentials and invalid response errors to useful messages", async () => {
    const f = client(() => ({ status: 403, body: "Forbidden" }));
    await expect(f.client.probe()).rejects.toThrow("登录失败");
    f.request.mockResolvedValue({ status: 200, body: "<html>other app</html>" });
    await expect(f.client.status("hash")).rejects.toThrow("无效的任务状态");
  });
  it("waits for asynchronous torrent acceptance without reporting a missing task", async () => {
    const f = client(() => ({ status: 200, body: [] }));
    const id = "tag:acgn-123#" + Date.now();
    await expect(f.client.status(id)).resolves.toMatchObject({ state: "downloading" });
    expect(f.request.mock.calls[0][0].path).toBe("/api/v2/torrents/info?tag=acgn-123");
    await expect(f.client.cancel(id)).rejects.toThrow("仍在接收种子");
    await expect(f.client.status("tag:acgn-123#" + (Date.now() - 180_000))).resolves.toMatchObject({ state: "failed", errorCode: "ENGINE_TASK_NOT_FOUND" });
  });
});
