import { afterEach, describe, expect, it, vi } from "vitest";
import { Aria2Client, FetchAria2Transport, createAria2Client, type Aria2RpcTransport } from "@/infrastructure/aria2/aria2-client";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function createTransport(result: unknown): Aria2RpcTransport {
  return { request: vi.fn().mockResolvedValue(result) };
}

describe("Aria2Client", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("adds a HTTP URI with a directory option", async () => {
    const transport = createTransport("0123456789abcdef");
    const client = new Aria2Client(transport, "http://127.0.0.1:6800/jsonrpc", "secret");
    await expect(client.add({ protocol: "http", url: "https://example.com/a.zip" }, { directory: "D:\\Incoming" })).resolves.toBe("0123456789abcdef");
    expect(transport.request).toHaveBeenCalledWith({
      endpoint: "http://127.0.0.1:6800/jsonrpc",
      secret: "secret",
      method: "aria2.addUri",
      params: [["https://example.com/a.zip"], expect.objectContaining({ dir: "D:\\Incoming", "check-certificate": "true", "user-agent": "ACGN-Hub/0.2", "max-tries": "5", "allow-overwrite": "false" })],
    });
  });

  it("applies the output filename to single-file HTTP downloads", async () => {
    const transport = createTransport("0123456789abcdef");
    const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
    await client.add({ protocol: "http", url: "https://example.com/book.epub" }, { directory: "D:\\Library", filename: "书名.epub" });
    const request = vi.mocked(transport.request).mock.calls[0][0];
    const options = request.params[1] as Record<string, string>;
    expect(options.out).toBe("书名.epub");
    // BitTorrent-specific options must stay gone together with the feature.
    expect(Object.keys(options).filter((key) => key.startsWith("bt-"))).toEqual([]);
    expect(options["enable-dht"]).toBeUndefined();
  });

  it("maps aria2 status values", async () => {
    const transport = createTransport({
      status: "active",
      totalLength: "1000",
      completedLength: "250",
      downloadSpeed: "50",
      files: [{ path: "D:\\Incoming\\a.zip" }],
    });
    const client = new Aria2Client(transport, "http://127.0.0.1:6800/jsonrpc");
    await expect(client.status("gid-1")).resolves.toEqual({
      state: "downloading",
      stage: "downloading",
      totalBytes: 1000,
      completedBytes: 250,
      speedBytesPerSecond: 50,
      files: ["D:\\Incoming\\a.zip"],
    });
  });

  it("waits for aria2 completion even when received bytes have reached the total", async () => {
    const transport = createTransport({
      status: "active",
      totalLength: "1000",
      completedLength: "1000",
      downloadSpeed: "0",
      files: [{ path: "D:\\Incoming\\a.zip" }],
    });
    const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
    await expect(client.status("gid-1").then((status) => status.state)).resolves.toBe("downloading");
  });

  it("turns a missing engine GID into a recoverable migration status", async () => {
    const transport: Aria2RpcTransport = { request: vi.fn().mockRejectedValue(new Error("GID 42 not found")) };
    const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");

    await expect(client.status("42")).resolves.toMatchObject({
      state: "failed",
      errorCode: "ENGINE_TASK_NOT_FOUND",
      files: [],
    });
  });

  it("accepts magnet and torrent targets using the embedded BitTorrent engine", async () => {
    const transport = createTransport("0123456789abcdef");
    const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
    await expect(client.add(
      { protocol: "magnet", url: "magnet:?xt=urn:btih:" + "a".repeat(40) },
      { directory: "D:\\Incoming" },
    )).resolves.toBe("0123456789abcdef");
    await expect(client.add(
      { protocol: "torrent", url: "https://example.com/a.torrent" },
      { directory: "D:\\Incoming" },
    )).resolves.toBe("0123456789abcdef");
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ params: expect.arrayContaining([expect.objectContaining({ "seed-time": "0", "follow-torrent": "mem", "bt-stop-timeout": "0", "max-download-limit": "0" })]) }));
  });

  it("follows a torrent metadata GID and returns the real content task handle", async () => {
    const transport: Aria2RpcTransport = { request: vi.fn().mockResolvedValueOnce({ status: "complete", totalLength: "500", completedLength: "500", followedBy: ["fedcba9876543210"] }).mockResolvedValueOnce({ status: "active", totalLength: "1000000", completedLength: "20000", files: [{ path: "D:\\Incoming\\episode.mkv" }] }) };
    const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
    await expect(client.status("0123456789abcdef")).resolves.toMatchObject({ state: "downloading", engineTaskId: "fedcba9876543210", totalBytes: 1000000, files: ["D:\\Incoming\\episode.mkv"] });
  });

  it("surfaces aria2 error messages on failures", async () => {
    const transport = createTransport({
      status: "error",
      errorCode: "1",
      errorMessage: "URI 不可用",
      totalLength: "100",
      completedLength: "0",
      downloadSpeed: "0",
      files: [],
    });
    const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
    await expect(client.status("gid-err")).resolves.toMatchObject({ state: "failed", error: "URI 不可用", errorCode: "1" });
  });

  it("recognizes a missing GID inside an HTTP 400 JSON-RPC response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: 1, message: "GID 0123456789abcdef is not found" } }), { status: 400 })));
    const client = new Aria2Client(new FetchAria2Transport(), "http://127.0.0.1:16800/jsonrpc");
    await expect(client.status("0123456789abcdef")).resolves.toMatchObject({ errorCode: "ENGINE_TASK_NOT_FOUND" });
  });

  it("keeps authentication errors distinct from missing download tasks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 1, message: "Unauthorized" } }), { status: 400 })));
    const client = new Aria2Client(new FetchAria2Transport(), "http://127.0.0.1:16800/jsonrpc");
    await expect(client.status("0123456789abcdef")).rejects.toThrow("Unauthorized");
  });

  it("distinguishes torrent transfer, magnet metadata, waiting, peer discovery and verification", async () => {
    const cases = [
      { protocol: "torrent", response: { status: "active", totalLength: "500", completedLength: "250", files: [{ path: "D:\\Incoming\\episode.torrent" }] }, stage: "fetching_torrent" },
      { protocol: "magnet", response: { status: "active", totalLength: "0", completedLength: "0", infoHash: "a".repeat(40), connections: "2", bittorrent: {} }, stage: "fetching_metadata" },
      { protocol: "torrent", response: { status: "active", totalLength: "1000", completedLength: "0", downloadSpeed: "0", connections: "0", numSeeders: "0", bittorrent: { info: { name: "episode.mkv" } } }, stage: "connecting" },
      { protocol: "magnet", response: { status: "waiting", totalLength: "0" }, stage: "queued_engine" },
      { protocol: "torrent", response: { status: "active", totalLength: "1000", completedLength: "1000", verifiedLength: "250", verifyIntegrityPending: true, bittorrent: { info: { name: "episode.mkv" } } }, stage: "checking" },
      { protocol: "torrent", response: { status: "active", totalLength: "1000", completedLength: "500", downloadSpeed: "100", bittorrent: { info: { name: "episode.mkv" } } }, stage: "downloading" },
      { protocol: "torrent", response: { status: "complete", totalLength: "1000", completedLength: "1000", bittorrent: { info: { name: "episode.mkv" } } }, stage: "completed" },
    ] as const;
    for (const entry of cases) {
      const client = new Aria2Client(createTransport(entry.response), "http://127.0.0.1:16800/jsonrpc");
      await expect(client.status("0123456789abcdef", { protocol: entry.protocol })).resolves.toMatchObject({ stage: entry.stage });
    }
  });

  it("does not report an already-fetched torrent metadata file as a finished episode while the child is pending", async () => {
    const client = new Aria2Client(createTransport({ status: "complete", totalLength: "500", completedLength: "500", files: [{ path: "D:\\Incoming\\episode.torrent" }] }), "http://127.0.0.1:16800/jsonrpc");
    await expect(client.status("0123456789abcdef", { protocol: "torrent" })).resolves.toMatchObject({ state: "downloading", stage: "fetching_torrent" });
  });

  it("validates and exposes connected peers, seeders, hash and checked bytes without fabricating an empty swarm", async () => {
    const transport = createTransport({ status: "active", totalLength: "1000", completedLength: "500", connections: "3", numSeeders: "1", infoHash: "AB".repeat(20), verifiedLength: "100", verifyIntegrityPending: "true", bittorrent: { info: { name: "episode.mkv" }, mode: "single" } });
    const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
    await expect(client.status("0123456789abcdef", { protocol: "torrent" })).resolves.toMatchObject({ connections: 3, peers: 3, seeders: 1, infoHash: "ab".repeat(20), verifiedBytes: 100, verifyIntegrityPending: true, stage: "checking" });
    const keys = vi.mocked(transport.request).mock.calls[0][0].params[1];
    expect(keys).toEqual(expect.arrayContaining(["connections", "numSeeders", "bittorrent", "infoHash", "verifiedLength", "verifyIntegrityPending"]));
    const unknown = await new Aria2Client(createTransport({ status: "active" }), "http://127.0.0.1:16800/jsonrpc").status("0123456789abcdef", { protocol: "magnet" });
    expect(unknown.peers).toBeUndefined();
    expect(unknown.seeders).toBeUndefined();
  });

  it("rejects malformed diagnostic fields instead of coercing or persisting untrusted counts", async () => {
    for (const invalid of [{ connections: "-1" }, { numSeeders: "NaN" }, { infoHash: "" }, { verifiedLength: "9007199254740992" }, { verifyIntegrityPending: "yes" }, { bittorrent: { info: { name: 123 } } }]) {
      const client = new Aria2Client(createTransport({ status: "active", ...invalid }), "http://127.0.0.1:16800/jsonrpc");
      await expect(client.status("0123456789abcdef", { protocol: "torrent" })).rejects.toThrow("无效的下载状态");
    }
  });

  it("reads the current followedBy chain before pause, resume or cancel instead of controlling a completed parent", async () => {
    const parent = "0123456789abcdef";
    const child = "fedcba9876543210";
    for (const action of ["pause", "resume", "cancel"] as const) {
      const transport: Aria2RpcTransport = { request: vi.fn(async (request) => {
        if (request.method !== "aria2.tellStatus") return "OK";
        return request.params[0] === parent ? { status: "complete", followedBy: [child] }
          : { status: action === "resume" ? "paused" : "active", files: [{ path: "D:\\Incoming\\episode.mkv" }] };
      }) };
      const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
      await client[action](parent);
      const mutation = action === "cancel" ? "aria2.forceRemove" : action === "resume" ? "aria2.unpause" : "aria2.pause";
      expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ method: mutation, params: [child] }));
      expect(transport.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: mutation, params: [parent] }));
    }
  });

  it("cancels only children derived from this GID and never selects unrelated downloads by directory", async () => {
    const parent = "0123456789abcdef";
    const children = ["1111111111111111", "2222222222222222"];
    const transport: Aria2RpcTransport = { request: vi.fn(async (request) => {
      if (request.method !== "aria2.tellStatus") return "OK";
      return request.params[0] === parent ? { status: "complete", followedBy: children }
        : { status: "active", files: [{ path: "D:\\Incoming\\shared-folder\\file.mkv" }] };
    }) };
    await new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc").cancel(parent);
    expect(vi.mocked(transport.request).mock.calls.filter(([request]) => request.method === "aria2.forceRemove").map(([request]) => request.params[0])).toEqual(children);
    expect(vi.mocked(transport.request).mock.calls.every(([request]) => ["aria2.tellStatus", "aria2.forceRemove"].includes(request.method))).toBe(true);
    const cycle = new Aria2Client(createTransport({ status: "complete", followedBy: [parent] }), "http://127.0.0.1:16800/jsonrpc");
    await expect(cycle.cancel(parent)).rejects.toThrow("派生任务链异常");
  });

  it("applies changed concurrency and an explicit zero speed limit to current content handles without touching global bandwidth", async () => {
    const parent = "0123456789abcdef";
    const child = "fedcba9876543210";
    const transport: Aria2RpcTransport = { request: vi.fn(async (request) => {
      if (request.method !== "aria2.tellStatus") return "OK";
      return request.params[0] === parent ? { status: "complete", followedBy: [child] } : { status: "paused", bittorrent: { info: { name: "episode.mkv" } } };
    }) };
    const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
    await client.applySettings({ maxConcurrentDownloads: 7, speedLimitBytesPerSecond: 0 }, [parent]);
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ method: "aria2.changeGlobalOption", params: [{ "max-concurrent-downloads": "7" }] }));
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ method: "aria2.changeOption", params: [child, { "max-download-limit": "0", "bt-stop-timeout": "0" }] }));
    expect(JSON.stringify(vi.mocked(transport.request).mock.calls)).not.toContain("max-overall-download-limit");
  });

  it("rechecks only the specific metadata changeOption race and still reports failures for a genuinely active task", async () => {
    const parent = "0123456789abcdef";
    const child = "fedcba9876543210";
    for (const outcome of ["child", "terminal", "active"] as const) {
      let parentReads = 0;
      const transport: Aria2RpcTransport = { request: vi.fn(async (request) => {
        if (request.method === "aria2.tellStatus") {
          if (request.params[0] === child) return { status: "active" };
          parentReads++;
          if (parentReads === 1 || outcome === "active") return { status: "active" };
          return { status: "complete", ...(outcome === "child" ? { followedBy: [child] } : {}) };
        }
        if (request.method === "aria2.changeOption" && request.params[0] === parent) throw new Error(`Cannot change option for GID#${parent}`);
        return "OK";
      }) };
      const client = new Aria2Client(transport, "http://127.0.0.1:16800/jsonrpc");
      const applying = client.applySettings({ maxConcurrentDownloads: 3, speedLimitBytesPerSecond: 0 }, [parent]);
      if (outcome === "active") await expect(applying).rejects.toThrow("Cannot change option");
      else await expect(applying).resolves.toBeUndefined();
      expect(parentReads).toBe(2);
      const changed = vi.mocked(transport.request).mock.calls.filter(([request]) => request.method === "aria2.changeOption").map(([request]) => request.params[0]);
      expect(changed).toEqual(outcome === "child" ? [parent, child] : [parent]);
    }
  });

  it("marks only the exact internal authenticated endpoint for native managed recovery", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockReset().mockResolvedValue({ version: "1.37.0" });
    await createAria2Client("http://127.0.0.1:16800/jsonrpc", "local-secret").probe();
    expect(invoke).toHaveBeenLastCalledWith("aria2_rpc", expect.objectContaining({ managed: true, endpoint: "http://127.0.0.1:16800/jsonrpc" }));
    await createAria2Client("http://127.0.0.1:6800/jsonrpc", "external-secret").probe();
    expect(invoke.mock.calls.at(-1)?.[1]).not.toHaveProperty("managed");
    await createAria2Client("http://127.0.0.1:16800/jsonrpc").probe();
    expect(invoke.mock.calls.at(-1)?.[1]).not.toHaveProperty("managed");
  });

  it("explains an empty aria2 error message while retaining the original code without claiming a timeout", async () => {
    const client = new Aria2Client(createTransport({ status: "error", errorCode: "7", errorMessage: "", totalLength: "416074928", completedLength: "0", connections: "0", numSeeders: "0" }), "http://127.0.0.1:16800/jsonrpc");
    const result = await client.status("0123456789abcdef", { protocol: "torrent" });
    expect(result).toMatchObject({ state: "failed", errorCode: "7", completedBytes: 0, peers: 0, seeders: 0 });
    expect(result.error).toContain("下载未完成");
    expect(result.error).not.toMatch(/timeout|超时/i);
  });
});
