export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

let nativePlatform = "";
export function setRuntimePlatform(platform?: string): void { nativePlatform = platform ?? ""; }
export function isAndroidRuntime(): boolean {
  return isTauriRuntime() && (nativePlatform === "android" || (!nativePlatform && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
