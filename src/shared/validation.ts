import { z } from "zod";
import type { DownloadTarget } from "@/domain/download";
import { isAndroidRuntime } from "./runtime";

const downloadUrlSchema = z.string().trim().min(1).max(8192);

export function parseDownloadTarget(input: string): DownloadTarget {
  const raw = downloadUrlSchema.parse(input);
  const url = new URL(raw);
  if (url.protocol === "magnet:") {
    const topics = url.searchParams.getAll("xt");
    if (!topics.some((value) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(value) || /^urn:btmh:1220[a-f0-9]{64}$/i.test(value))) {
      throw new Error("磁力链接缺少有效的 BT 信息哈希");
    }
    const name = url.searchParams.get("dn")?.trim();
    return { protocol: "magnet", url: raw, ...(name ? { filename: name } : {}) };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("支持 HTTP、HTTPS、Magnet 和 Torrent 链接");
  if (url.username || url.password) throw new Error("不接受包含用户名或密码的链接");
  let filename: string;
  try { filename = decodeURIComponent(url.pathname.split("/").pop() ?? "").trim(); }
  catch { throw new Error("链接中的文件名编码无效"); }
  return { protocol: /\.torrent$/i.test(filename) ? "torrent" : "http", url: raw, ...(filename ? { filename } : {}) };
}

export function normalizeDedupeKey(input: string): string {
  const parsed = new URL(input);
  if (parsed.protocol === "magnet:") {
    const hash = parsed.searchParams.getAll("xt").find((value) => /^urn:btih:/i.test(value)) ?? parsed.searchParams.get("xt");
    return "magnet:" + hash?.toLowerCase();
  }
  parsed.hash = "";
  return parsed.toString();
}

export function assertDownloadDirectory(directory: string): string {
  const normalized = directory.trim();
  if (!normalized) throw new Error("请先在设置中选择下载目录");
  if (normalized.length > 4096) throw new Error("下载目录路径过长");
  if (isAndroidRuntime()) {
    if (!normalized.startsWith("/") || normalized.startsWith("//") || normalized.includes("\\")) throw new Error("请选择应用内的有效保存目录");
  } else if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(normalized)) throw new Error("下载目录必须使用 Windows 绝对路径");
  if (normalized.split(/[\\/]/).some((segment) => segment === "..")) throw new Error("下载目录不能包含 .. 父目录片段");
  if (/[\u0000-\u001f]/.test(normalized)) throw new Error("下载目录包含无效字符");
  return normalized;
}

export function assertLocalEndpoint(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error(name + "地址必须是不含账号和查询参数的本机 HTTP 地址");
  }
  return url.toString().replace(/\/$/, "");
}
