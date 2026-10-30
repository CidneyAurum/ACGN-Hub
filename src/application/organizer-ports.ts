import type { OrganizationPlan, OrganizationResult } from "@/domain/organization";

export interface FileOrganizer {
  listFiles(sourcePath: string, incomingRoot: string): Promise<string[]>;
  organize(plan: OrganizationPlan): Promise<OrganizationResult>;
}
