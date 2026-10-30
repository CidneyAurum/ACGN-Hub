export type SourceDiagnosticStage = "health" | "search" | "resolve";

export interface SourceDiagnostic {
  id: string;
  sourceId: string;
  sourceName: string;
  stage: SourceDiagnosticStage;
  message: string;
  checkedAt: string;
  snapshot: Record<string, string>;
}

export function createSourceDiagnostic(input: Omit<SourceDiagnostic, "id" | "message" | "checkedAt" | "snapshot"> & {
  message: string;
  snapshot?: Record<string, unknown>;
  id?: string;
  checkedAt?: string;
}): SourceDiagnostic {
  const snapshot = Object.fromEntries(Object.entries(input.snapshot ?? {}).flatMap(([key, value]) => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return [];
    return [[key, String(value).slice(0, 200)]];
  }));
  return {
    id: input.id ?? `diagnostic-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    stage: input.stage,
    message: input.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    snapshot,
  };
}
