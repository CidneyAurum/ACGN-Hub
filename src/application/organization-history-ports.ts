import type { OrganizationHistoryRecord } from "@/domain/organization-history";

export interface OrganizationHistoryRepository {
  initialize(): Promise<void>;
  list(): Promise<OrganizationHistoryRecord[]>;
  add(record: OrganizationHistoryRecord): Promise<void>;
}
