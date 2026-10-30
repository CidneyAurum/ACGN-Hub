import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/shared/runtime";
import type { TextFetcher, TextResponse } from "@/application/feed-ports";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";

export interface TauriTextResponse {
  status: number;
  body: string;
}

export const browserTextFetcher: TextFetcher = (url, init) => fetch(url, init);

export const tauriTextFetcher: TextFetcher = async (url, init) => {
  const timeout = (init as (RequestInit & { timeoutMs?: number }) | undefined)?.timeoutMs;
  const response = await abortableRequest(() => invoke<TauriTextResponse>("feed_text_request", {
    url,
    method: init?.method ?? "GET",
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    timeoutMs: Number.isFinite(timeout) ? Math.min(30_000, Math.max(500, timeout!)) : 10_000,
  }), init?.signal);
  const result: TextResponse = {
    status: response.status,
    text: async () => response.body,
  };
  return result;
};

export function createTextFetcher(): TextFetcher {
  return isTauriRuntime() ? tauriTextFetcher : browserTextFetcher;
}
