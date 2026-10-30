import { describe, expect, it } from "vitest";
import { createSourceDiagnostic } from "@/domain/source-diagnostic";
import { LocalStorageSourceDiagnosticRepository, type SourceDiagnosticStorageLike } from "@/infrastructure/database/source-diagnostic-repository";

class MemoryStorage implements SourceDiagnosticStorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("source diagnostics", () => {
  it("stores bounded sanitized errors without response bodies", async () => {
    const repository = new LocalStorageSourceDiagnosticRepository(new MemoryStorage());
    await repository.initialize();
    const diagnostic = createSourceDiagnostic({
      sourceId: "source-1",
      sourceName: "Example",
      stage: "search",
      message: `bad\n${"x".repeat(600)}`,
      snapshot: { sourceUrl: "https://example.com/feed.xml", responseBody: { secret: "hidden" } },
    });
    await repository.record(diagnostic);
    const stored = await repository.list();
    expect(stored[0].message.length).toBe(500);
    expect(stored[0].message).not.toContain("\n");
    expect(stored[0].snapshot).toEqual({ sourceUrl: "https://example.com/feed.xml" });
  });
});
