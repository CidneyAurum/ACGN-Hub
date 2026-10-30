import type { ResourceRepository } from "@/application/resource-ports";
import { createRepository } from "./repository-runtime";
import { LocalStorageResourceRepository, SqliteResourceRepository } from "./resource-repository";

export function createResourceRepository(): Promise<ResourceRepository> {
  return createRepository<ResourceRepository>("resources", () => new SqliteResourceRepository(), () => new LocalStorageResourceRepository());
}
