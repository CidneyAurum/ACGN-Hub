import type { LocalFileRepository } from "@/application/local-file-ports";
import { createRepository } from "./repository-runtime";
import { LocalStorageLocalFileRepository, SqliteLocalFileRepository } from "./local-file-repository";

export function createLocalFileRepository(): Promise<LocalFileRepository> {
  return createRepository<LocalFileRepository>("local-files", () => new SqliteLocalFileRepository(), () => new LocalStorageLocalFileRepository());
}
