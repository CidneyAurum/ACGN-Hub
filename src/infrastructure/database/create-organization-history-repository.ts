import type { OrganizationHistoryRepository } from "@/application/organization-history-ports";
import { createRepository } from "./repository-runtime";
import { LocalStorageOrganizationHistoryRepository, SqliteOrganizationHistoryRepository } from "./organization-history-repository";

export function createOrganizationHistoryRepository(): Promise<OrganizationHistoryRepository> {
  return createRepository<OrganizationHistoryRepository>("organization-history", () => new SqliteOrganizationHistoryRepository(), () => new LocalStorageOrganizationHistoryRepository());
}
