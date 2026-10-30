import { invoke } from "@tauri-apps/api/core";
import type { DownloadEngine } from "@/application/ports";
import type { DownloadProtocol } from "@/domain/download";
import { createAria2Client } from "@/infrastructure/aria2/aria2-client";
import { QbittorrentClient, TauriQbittorrentTransport } from "@/infrastructure/qbittorrent/qbittorrent-client";
import { type AppSettings, type DownloadEngineKind, loadSessionSecret, loadSessionQbittorrentCredentials } from "@/shared/settings";
import { isTauriRuntime } from "@/shared/runtime";

export function engineForProtocol(protocol: DownloadProtocol, btEngine: DownloadEngineKind = "aria2"): DownloadEngineKind { return protocol === "http" ? "aria2" : btEngine; }
export function createDownloadEngine(id: string, settings: AppSettings): DownloadEngine {
  if (id === "aria2") return createAria2Client(settings.aria2Endpoint, loadSessionSecret() || undefined);
  if (id === "qbittorrent") return new QbittorrentClient(new TauriQbittorrentTransport(), settings.qbittorrentEndpoint, loadSessionQbittorrentCredentials());
  throw new Error("未知下载引擎：" + id + "。请重新添加该任务。");
}

export async function ensureAria2(settings: AppSettings): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("ensure_local_aria2", { endpoint: settings.aria2Endpoint, secret: loadSessionSecret() || null, directory: settings.incomingDirectory });
}
export async function probeDownloadEngine(settings: AppSettings, id: DownloadEngineKind = "aria2"): Promise<string> {
  if (id === "qbittorrent") return new QbittorrentClient(new TauriQbittorrentTransport(), settings.qbittorrentEndpoint, loadSessionQbittorrentCredentials()).probe();
  await ensureAria2(settings);
  return createAria2Client(settings.aria2Endpoint, loadSessionSecret() || undefined).probe();
}
