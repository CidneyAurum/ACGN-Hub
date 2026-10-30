import type { SourceConfigRepository } from "@/application/source-config-ports";
import { createRepository } from "./repository-runtime";
import { LocalStorageSourceConfigRepository, SqliteSourceConfigRepository } from "./source-config-repository";

export function createSourceConfigRepository(): Promise<SourceConfigRepository> {
  return createRepository<SourceConfigRepository>("source-configs", () => new SqliteSourceConfigRepository(), () => new LocalStorageSourceConfigRepository());
}
