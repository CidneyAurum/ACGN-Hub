import type { SourceDiagnostic } from "@/domain/source-diagnostic";

export interface SourceDiagnosticRepository {
  initialize(): Promise<void>;
  list(limit?: number): Promise<SourceDiagnostic[]>;
  record(diagnostic: SourceDiagnostic): Promise<void>;
  clear(): Promise<void>;
}
