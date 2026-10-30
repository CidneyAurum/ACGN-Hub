export type OrganizationHistoryStatus = "moved" | "already_present" | "failed";

export interface OrganizationHistoryRecord {
  id: string;
  taskId: string;
  mediaId: string;
  sourcePath: string;
  destinationPath: string;
  status: OrganizationHistoryStatus;
  error?: string;
  createdAt: string;
}
