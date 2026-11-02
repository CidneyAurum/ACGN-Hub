import { describe, expect, it } from "vitest";
import { parseJsonResponse } from "@/infrastructure/metadata/response-errors";

class InvalidResponse extends Error {
  constructor(readonly code: "invalid_response", message: string) { super(message); }
}

describe("metadata response failures", () => {
  it("preserves a native transport failure rejected during response reading", async () => {
    const cause = "[NETWORK_TLS] HTTPS certificate or handshake failed";
    await expect(parseJsonResponse({ status: 200, json: async () => { throw cause; } }, InvalidResponse)).rejects.toBe(cause);
  });

  it.each([
    new TypeError("Failed to fetch while reading response"),
    new Error("response stream closed"),
    new DOMException("cancelled", "AbortError"),
    new DOMException("timed out", "TimeoutError"),
    "native connection closed",
    { code: "CALLER_CANCELLED" },
  ])("keeps a non-syntax body failure intact: %s", async (cause) => {
    await expect(parseJsonResponse({ status: 200, json: async () => { throw cause; } }, InvalidResponse)).rejects.toBe(cause);
  });

  it("reports a real JSON syntax failure with the provider's invalid-response error", async () => {
    await expect(parseJsonResponse({ status: 200, json: async () => JSON.parse("{broken") }, InvalidResponse))
      .rejects.toMatchObject({ code: "invalid_response", message: "API 返回的内容不是有效 JSON" });
  });

  it("returns parsed response data unchanged", async () => {
    const body = { results: [{ title: "valid" }] };
    await expect(parseJsonResponse({ status: 200, json: async () => body }, InvalidResponse)).resolves.toBe(body);
  });
});
