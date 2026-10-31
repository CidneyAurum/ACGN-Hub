import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { LocalViewerSession, LocalViewerTarget } from "@/domain/local-viewer";
import { isTauriRuntime } from "@/shared/runtime";

const SESSION_ID = /^[A-Fa-f0-9]{32}$/;

function sessionId(value: unknown): value is string { return typeof value === "string" && SESSION_ID.test(value); }

function parseSession(value: unknown, expected: LocalViewerTarget["kind"]): LocalViewerSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地观看服务返回了无效的文件信息。");
  const item = value as Record<string, unknown>;
  if (!sessionId(item.sessionId) || item.kind !== expected || typeof item.title !== "string" || !item.title.trim()
    || typeof item.sizeBytes !== "number" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
    || typeof item.modifiedAt !== "string" || !item.modifiedAt || item.modifiedAt.length > 128
    || (item.kind === "comic" && (typeof item.pageCount !== "number" || !Number.isSafeInteger(item.pageCount) || item.pageCount < 1))
    || (item.kind === "text" && typeof item.text !== "string")) {
    throw new Error("本地观看服务返回了无效的文件信息，请重试。");
  }
  return {
    sessionId: item.sessionId, kind: expected, title: item.title,
    sizeBytes: item.sizeBytes, modifiedAt: item.modifiedAt,
    ...(item.kind === "comic" ? { pageCount: item.pageCount as number } : {}),
    ...(item.kind === "text" ? { text: item.text as string } : {}),
  };
}

export async function prepareLocalViewer(target: LocalViewerTarget): Promise<LocalViewerSession> {
  if (!isTauriRuntime()) throw new Error("应用内观看本地下载需要使用桌面版。");
  const raw = await invoke<unknown>("prepare_local_viewer", { path: target.path, allowedRoot: target.allowedRoot });
  try { return parseSession(raw, target.kind); }
  catch (cause) {
    const id = raw && typeof raw === "object" ? (raw as Record<string, unknown>).sessionId : undefined;
    if (sessionId(id)) await closeLocalViewer(id).catch(() => undefined);
    throw cause;
  }
}

export function closeLocalViewer(id: string): Promise<void> {
  if (!sessionId(id)) return Promise.reject(new Error("本地观看会话无效。"));
  return invoke<void>("close_local_viewer", { sessionId: id });
}

export function localViewerPageUrl(id: string, index: number): string {
  if (!sessionId(id) || !Number.isSafeInteger(index) || index < 0) throw new Error("漫画页码无效。");
  // Tauri encodes the entire filePath (including /). Convert only the opaque
  // token, then append protocol routing segments as real URL separators.
  return `${convertFileSrc(id, "acgn-local")}/page/${index}`;
}

export function localViewerVideoUrl(id: string): string {
  if (!sessionId(id)) throw new Error("本地观看会话无效。");
  return `${convertFileSrc(id, "acgn-local")}/video`;
}

export async function openLocalViewerWithSystem(target: LocalViewerTarget): Promise<void> {
  if (!isTauriRuntime()) throw new Error("打开本地文件需要使用桌面版。");
  await invoke("open_downloaded_media", { path: target.path, allowedRoot: target.allowedRoot, preferSystem: true });
}
