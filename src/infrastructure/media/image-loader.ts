import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/shared/runtime";

const pending = new Map<string, Promise<string>>();
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(action: () => Promise<T>): Promise<T> {
  if (running >= 5) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try { return await action(); }
  finally { running -= 1; waiting.shift()?.(); }
}
export function normalizeImageUrl(value: string): string {
  try { const url = new URL(value); if (url.protocol === "http:") url.protocol = "https:"; return url.toString(); }
  catch { return value; }
}
export function loadMediaImage(raw: string, refresh = false): Promise<string> {
  const url = normalizeImageUrl(raw);
  if (!isTauriRuntime()) return Promise.resolve(url);
  if (refresh) pending.delete(url);
  let request = pending.get(url);
  if (!request) {
    request = slot(async () => {
      const result = await invoke<{ cacheKey: string; mimeType: string }>("media_image_request", { url });
      if (!/^[a-f0-9]+$/i.test(result.cacheKey)) throw new Error("封面缓存标识无效");
      return "http://acgn-image.localhost/" + result.cacheKey;
    }).catch((cause) => { pending.delete(url); throw cause; });
    pending.set(url, request);
    if (pending.size > 1000) pending.delete(pending.keys().next().value!);
  }
  return request;
}
