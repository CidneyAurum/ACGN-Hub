import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/shared/runtime";
import { abortableRequest } from "./abortable-request";

export interface JsonResponse {
  status: number;
  json(): Promise<unknown>;
}

export type JsonRequestInit = RequestInit & { timeoutMs?: number };
export type JsonFetcher = (url: string, init: JsonRequestInit) => Promise<JsonResponse>;

export interface TauriJsonResponse {
  status: number;
  body: unknown;
}

export const browserJsonFetcher: JsonFetcher = (url, init) => fetch(url, init);

export const tauriJsonFetcher: JsonFetcher = async (url, init) => {
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const response = await abortableRequest(() => invoke<TauriJsonResponse>("metadata_json_request", {
    url,
    method: init.method ?? "GET",
    body: body ?? null,
    headers,
    timeoutMs: Number.isFinite(init.timeoutMs) ? Math.min(35_000, Math.max(500, init.timeoutMs!)) : 10_000,
  }), init.signal);
  return {
    status: response.status,
    json: async () => response.body,
  };
};

export function createJsonFetcher(): JsonFetcher {
  return isTauriRuntime() ? tauriJsonFetcher : browserJsonFetcher;
}
