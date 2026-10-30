import type { SourceConfig } from "@/domain/source";

export interface SourceConfigRepository {
  initialize(): Promise<void>;
  list(): Promise<SourceConfig[]>;
  upsert(config: SourceConfig): Promise<void>;
  remove(id: string): Promise<void>;
}
