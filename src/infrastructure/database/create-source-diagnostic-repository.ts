import type { SourceDiagnosticRepository } from "@/application/source-diagnostic-ports";
import { createRepository } from "./repository-runtime";
import { LocalStorageSourceDiagnosticRepository, SqliteSourceDiagnosticRepository } from "./source-diagnostic-repository";

export function createSourceDiagnosticRepository(): Promise<SourceDiagnosticRepository> {
  return createRepository<SourceDiagnosticRepository>("source-diagnostics", () => new SqliteSourceDiagnosticRepository(), () => new LocalStorageSourceDiagnosticRepository());
}
