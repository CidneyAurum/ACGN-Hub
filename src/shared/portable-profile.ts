import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";

export const PORTABLE_ROOT_KEY = "acgn-hub.portable-profile-root.v1";
const SETTINGS_KEY = "acgn-hub.settings.v1";
const PROGRESS_PREFIX = "acgn-hub.viewer-progress.v1:";
const PATH_FIELDS = new Set([
  "downloadDirectory", "incomingDirectory", "libraryDirectory", "obsidianEbookDirectory", "backupDirectory",
  "directory", "outputPath", "path", "allowedRoot", "tempPath", "finalPath", "originalPath",
  "duplicateOf", "sourcePath", "destinationPath", "launchPath",
]);
const ARRAY_FIELDS = new Set(["files", "detectedFiles"]);
const RECORD_KEYS = [
  SETTINGS_KEY, "acgn-hub.local-download-tasks.v1", "acgn-hub.download-tasks.v1",
  "acgn-hub.local-files.v1", "acgn-hub.game-installs.v1", "acgn-hub.organization-history.v1",
];

export interface PortableStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface StorageChange { key: string; previous: string | null; next: string }

function normalized(value: string): string {
  return value.replace(/\//g, "\\")
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "")
    .replace(/\\+$/, "");
}
function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + "\\"); }

export function relocatePortablePath(value: string, previous: string, current: string): string {
  const path = normalized(value); const root = normalized(previous);
  if (path.split("\\").some((part) => part === "." || part === "..") || !inside(path.toLowerCase(), root.toLowerCase())) return value;
  return normalized(current) + path.slice(root.length);
}

function relocateRecord(value: unknown, previous: string, current: string): unknown {
  if (Array.isArray(value)) return value.map((item) => relocateRecord(item, previous, current));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (PATH_FIELDS.has(key) && typeof item === "string") return [key, relocatePortablePath(item, previous, current)];
    if (ARRAY_FIELDS.has(key) && Array.isArray(item)) return [key, item.map((path) => typeof path === "string" ? relocatePortablePath(path, previous, current) : path)];
    if (["cleanupPaths", "naming"].includes(key)) return [key, relocateRecord(item, previous, current)];
    return [key, item];
  }));
}

/** Legacy releases stored no profile identity. Infer it only when two default directories agree. */
export function inferLegacyPortableRoot(raw: string | null): string | undefined {
  if (raw === null) return;
  const settings: unknown = JSON.parse(raw);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("设置数据格式无效，原始数据已保留。");
  const votes = new Map<string, { root: string; count: number }>();
  for (const [field, leaf] of [["incomingDirectory", "Incoming"], ["libraryDirectory", "Library"], ["backupDirectory", "Backups"]]) {
    const value = (settings as Record<string, unknown>)[field!];
    if (typeof value !== "string") continue;
    const path = normalized(value); const suffix = `\\Files\\${leaf}`;
    if (!path.toLowerCase().endsWith(suffix.toLowerCase())) continue;
    const root = path.slice(0, -suffix.length); const key = root.toLowerCase();
    const vote = votes.get(key) ?? { root, count: 0 }; vote.count += 1; votes.set(key, vote);
  }
  return [...votes.values()].find((vote) => vote.count >= 2)?.root;
}

export function planPortableStorageRelocation(storage: PortableStorage, previous: string, current: string): StorageChange[] {
  const changes: StorageChange[] = [];
  for (const key of RECORD_KEYS) {
    const raw = storage.getItem(key); if (raw === null) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error(`便携记录 ${key} 无法读取，原始数据已保留。`); }
    if (key === SETTINGS_KEY ? !value || typeof value !== "object" || Array.isArray(value) : !Array.isArray(value)) {
      throw new Error(`便携记录 ${key} 格式无效，原始数据已保留。`);
    }
    const nextValue = relocateRecord(value, previous, current);
    if (JSON.stringify(nextValue) !== JSON.stringify(value)) changes.push({ key, previous: raw, next: JSON.stringify(nextValue) });
  }
  // Reading positions include the absolute path in their keys. Copy the key and
  // retain the old entry; a quota failure never erases the previous position.
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key);
  for (const key of keys) {
    if (!key.startsWith(PROGRESS_PREFIX)) continue;
    let parts: unknown;
    try { parts = JSON.parse(key.slice(PROGRESS_PREFIX.length)); } catch { continue; }
    if (!Array.isArray(parts) || typeof parts[0] !== "string") continue;
    const path = relocatePortablePath(parts[0], previous, current); if (path === parts[0]) continue;
    const target = PROGRESS_PREFIX + JSON.stringify([path, ...parts.slice(1)]);
    const raw = storage.getItem(key);
    if (raw !== null && storage.getItem(target) === null) changes.push({ key: target, previous: null, next: raw });
  }
  return changes;
}

export async function preparePortableProfile(storage: PortableStorage, currentRoot: string, relocateDatabase: (previous: string) => Promise<unknown>): Promise<void> {
  const previous = storage.getItem(PORTABLE_ROOT_KEY) ?? inferLegacyPortableRoot(storage.getItem(SETTINGS_KEY));
  if (!previous || normalized(previous).toLowerCase() === normalized(currentRoot).toLowerCase()) {
    storage.setItem(PORTABLE_ROOT_KEY, currentRoot); return;
  }
  if (!/^(?:[A-Za-z]:\\[^\\]|\\\\[^\\]+\\[^\\]+\\)/.test(normalized(previous)) ||
      inside(normalized(previous).toLowerCase(), normalized(currentRoot).toLowerCase()) ||
      inside(normalized(currentRoot).toLowerCase(), normalized(previous).toLowerCase())) {
    throw new Error("原便携资料目录无效或新旧目录互相嵌套。请保留 Data，并将完整便携包移至独立目录后重试。");
  }
  const changes = planPortableStorageRelocation(storage, previous, currentRoot);
  // Keep the old identity until every store succeeds. An interrupted migration
  // is idempotent on retry, including first upgrades from versions without it.
  storage.setItem(PORTABLE_ROOT_KEY, previous);
  await relocateDatabase(previous);
  const applied: StorageChange[] = [];
  try {
    for (const change of changes) { storage.setItem(change.key, change.next); applied.push(change); }
    storage.setItem(PORTABLE_ROOT_KEY, currentRoot);
  } catch (cause) {
    for (const change of applied.reverse()) {
      try { if (change.previous === null) storage.removeItem(change.key); else storage.setItem(change.key, change.previous); } catch { /* Old root marker makes a later retry safe. */ }
    }
    throw new Error("便携路径暂时无法保存，原记录已保留。请检查磁盘空间并重试；本次未启动下载。", { cause });
  }
}

let initialization: Promise<void> | undefined;
export function initializePortableProfile(): Promise<void> {
  initialization ??= (async () => {
    if (!isTauriRuntime()) return;
    const profile = await invoke<{ dataDirectory: string } | null>("get_portable_profile");
    if (!profile) return;
    await preparePortableProfile(localStorage, profile.dataDirectory, (previousRoot) => invoke("relocate_portable_profile", { previousRoot }));
  })().catch((cause) => { initialization = undefined; throw cause; });
  return initialization;
}
