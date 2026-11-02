import { invoke } from "@tauri-apps/api/core";
import type { TextFetcher } from "@/application/feed-ports";
import { abortableRequest } from "@/infrastructure/metadata/abortable-request";
import { timeoutSignal, anySignal, disposeAbortSignal } from "@/shared/abort-signals";
import { isTauriRuntime } from "@/shared/runtime";

interface ItchTextResponse { status: number; body: string }

/** Separate from the GET-only feed transport. The native command accepts only
 * the audited authors' public free-download routes, with no cookies or headers. */
export function createItchFreewareFetcher(): TextFetcher {
  if (!isTauriRuntime()) return (url, init) => fetch(url, { ...init, credentials: "omit" });
  return async (url, init) => {
    const requested = (init as (RequestInit & { timeoutMs?: number }) | undefined)?.timeoutMs;
    const timeoutMs = Number.isFinite(requested) ? Math.min(30_000, Math.max(500, requested!)) : 15_000;
    const timedSignal = timeoutSignal(timeoutMs);
    const signal = init?.signal ? anySignal([init.signal, timedSignal]) : timedSignal;
    try {
      const response = await abortableRequest(() => invoke<ItchTextResponse>("itch_freeware_request", {
        url, method: init?.method ?? "GET", body: init?.body === undefined ? null : String(init.body), timeoutMs,
      }), signal);
      return { status: response.status, text: async () => response.body };
    } finally { disposeAbortSignal(signal); disposeAbortSignal(timedSignal); }
  };
}
