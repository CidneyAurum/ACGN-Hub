import type { JsonResponse } from "./json-transport";

type ResponseErrorConstructor = new (code: "invalid_response", message: string) => Error;

export async function parseJsonResponse(response: JsonResponse, ErrorType: ResponseErrorConstructor): Promise<unknown> {
  try { return await response.json(); }
  catch (cause) {
    // Only a parsing failure establishes invalid JSON. Response bodies can
    // reject while reading or cancelling, including string errors from IPC;
    // keep those reasons intact for the caller's transport classification.
    if (cause instanceof SyntaxError) throw new ErrorType("invalid_response", "API 返回的内容不是有效 JSON");
    throw cause;
  }
}

export function isTimeoutError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) || /timed?\s*out|timeout|超时/i.test(message);
}

export function isInvalidJsonError(cause: unknown): boolean {
  return /JSON/i.test(cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "");
}
