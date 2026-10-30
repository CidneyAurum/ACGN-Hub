import { describe, expect, it } from "vitest";
import { assertDownloadDirectory, normalizeDedupeKey, parseDownloadTarget } from "@/shared/validation";

describe("download URL validation", () => {
  it("accepts HTTP URLs", () => {
    expect(parseDownloadTarget("https://example.com/file.zip")).toMatchObject({
      protocol: "http",
      filename: "file.zip",
    });
  });

  it("accepts valid magnet links and rejects missing or malformed info hashes", () => {
    const url = "magnet:?xt=urn:btih:" + "a".repeat(40) + "&dn=Example";
    expect(parseDownloadTarget(url)).toMatchObject({ protocol: "magnet", filename: "Example" });
    expect(() => parseDownloadTarget("magnet:?xt=urn:btih:abc")).toThrow("信息哈希");
  });

  it("recognizes .torrent URLs for the BitTorrent engine", () => {
    expect(parseDownloadTarget("https://example.com/episode.torrent")).toMatchObject({ protocol: "torrent" });
  });

  it("rejects unsupported schemes and credential URLs", () => {
    expect(() => parseDownloadTarget("file:///C:/secret.txt")).toThrow();
    expect(() => parseDownloadTarget("https://user:pass@example.com/file.zip")).toThrow();
  });

  it("normalizes URL fragments for deduplication", () => {
    expect(normalizeDedupeKey("https://example.com/file.zip#part")).toBe("https://example.com/file.zip");
  });

  it("requires a download directory", () => {
    expect(() => assertDownloadDirectory("  ")).toThrow();
    expect(() => assertDownloadDirectory("Incoming")).toThrow("绝对路径");
    expect(assertDownloadDirectory("D:\\ACGN\\Incoming")).toBe("D:\\ACGN\\Incoming");
  });
});
