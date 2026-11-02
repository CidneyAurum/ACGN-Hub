import { invoke } from "@tauri-apps/api/core";
import { isAndroidRuntime, isTauriRuntime, setRuntimePlatform } from "./runtime";
import { joinWindowsPath } from "@/domain/organization";
import { initializePortableProfile } from "./portable-profile";

export type DownloadEngineKind = "aria2" | "qbittorrent";
export interface AppSettings {
  /** Kept for old configurations; the protocol determines the actual engine. */
  downloadEngine: DownloadEngineKind;
  btDownloadEngine: DownloadEngineKind;
  aria2Endpoint: string;
  qbittorrentEndpoint: string;
  downloadDirectory: string;
  incomingDirectory: string;
  libraryDirectory: string;
  obsidianEbookDirectory: string;
  backupDirectory: string;
  maxConcurrentDownloads: number;
  speedLimitBytesPerSecond: number;
  pollIntervalMs: number;
  autoRenameDownloads: boolean;
  /** Selected from native platform capabilities, never a user-controlled RPC endpoint. */
  httpDownloadEngine?: "aria2" | "mobile_http";
}
export interface QbittorrentCredentials { username: string; password: string }
interface RuntimeDefaults { incomingDirectory: string; libraryDirectory: string; backupDirectory: string; aria2Endpoint: string; platform?: string; desktopEngineAvailable?: boolean }

const SETTINGS_KEY = "acgn-hub.settings.v1";
export const SETTINGS_CHANGED_EVENT = "acgn-hub:settings-changed";
const DEFAULT_SETTINGS: AppSettings = {
  downloadEngine: "aria2",
  btDownloadEngine: "aria2",
  aria2Endpoint: "http://127.0.0.1:16800/jsonrpc",
  qbittorrentEndpoint: "http://127.0.0.1:8080",
  downloadDirectory: "",
  incomingDirectory: "",
  libraryDirectory: "",
  obsidianEbookDirectory: "",
  backupDirectory: "",
  maxConcurrentDownloads: 3,
  speedLimitBytesPerSecond: 0,
  pollIntervalMs: 2500,
  autoRenameDownloads: true,
};

function savedValues(): Record<string, unknown> {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw === null) return {};
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("设置数据无法读取。请导出备份后重新保存；原始数据已保留。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("设置数据格式无效，原始数据已保留。");
  return value as Record<string, unknown>;
}

export function loadSettings(): AppSettings {
  const saved = savedValues();
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of ["aria2Endpoint", "qbittorrentEndpoint", "downloadDirectory", "incomingDirectory", "libraryDirectory", "obsidianEbookDirectory", "backupDirectory"] as const) {
    if (typeof saved[key] === "string") settings[key] = saved[key].trim();
  }
  settings.aria2Endpoint ||= DEFAULT_SETTINGS.aria2Endpoint;
  settings.qbittorrentEndpoint ||= DEFAULT_SETTINGS.qbittorrentEndpoint;
  settings.downloadEngine = saved.downloadEngine === "qbittorrent" ? "qbittorrent" : "aria2";
  settings.btDownloadEngine = saved.btDownloadEngine === "qbittorrent" ? "qbittorrent" : "aria2";
  settings.maxConcurrentDownloads = boundedNumber(saved.maxConcurrentDownloads, 1, isAndroidRuntime() ? 3 : 20, 3);
  settings.speedLimitBytesPerSecond = boundedNumber(saved.speedLimitBytesPerSecond, 0, 1024 ** 3, 0);
  settings.pollIntervalMs = boundedNumber(saved.pollIntervalMs, 1000, 60000, 2500);
  settings.autoRenameDownloads = typeof saved.autoRenameDownloads === "boolean" ? saved.autoRenameDownloads : true;
  if (isAndroidRuntime()) settings.httpDownloadEngine = "mobile_http";
  return settings;
}

let initializing: Promise<AppSettings> | undefined;
export function initializeSettings(): Promise<AppSettings> {
  initializing ??= (async () => {
    if (!isTauriRuntime()) return loadSettings();
    await initializePortableProfile();
    const defaults = await invoke<RuntimeDefaults>("get_runtime_defaults");
    setRuntimePlatform(defaults.platform);
    const settings = loadSettings();
    settings.incomingDirectory ||= defaults.incomingDirectory;
    settings.libraryDirectory ||= defaults.libraryDirectory;
    settings.backupDirectory ||= defaults.backupDirectory;
    settings.obsidianEbookDirectory ||= joinWindowsPath(settings.libraryDirectory, "Books");
    if (!isAndroidRuntime() && settings.aria2Endpoint === defaults.aria2Endpoint && !loadSessionSecret()) saveSessionSecret(crypto.randomUUID() + crypto.randomUUID());
    saveSettings(settings);
    return settings;
  })().catch((cause) => { initializing = undefined; throw cause; });
  return initializing;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}
export function loadSessionSecret(): string { return sessionStorage.getItem("acgn-hub.aria2-secret") ?? ""; }
export function saveSessionSecret(secret: string): void {
  if (secret) sessionStorage.setItem("acgn-hub.aria2-secret", secret);
  else sessionStorage.removeItem("acgn-hub.aria2-secret");
}
export function loadSessionQbittorrentCredentials(): QbittorrentCredentials {
  return { username: sessionStorage.getItem("acgn-hub.qbit-username") ?? "", password: sessionStorage.getItem("acgn-hub.qbit-password") ?? "" };
}
export function saveSessionQbittorrentCredentials(credentials: QbittorrentCredentials): void {
  const values = { username: credentials.username.trim(), password: credentials.password };
  for (const key of ["username", "password"] as const) {
    const storageKey = "acgn-hub.qbit-" + key;
    if (values[key]) sessionStorage.setItem(storageKey, values[key]);
    else sessionStorage.removeItem(storageKey);
  }
}
