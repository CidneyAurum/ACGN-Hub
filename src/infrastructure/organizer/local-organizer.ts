import { invoke } from "@tauri-apps/api/core";
import type { FileOrganizer } from "@/application/organizer-ports";
import type { OrganizationPlan, OrganizationResult } from "@/domain/organization";
import { isTauriRuntime } from "@/shared/runtime";

export interface OrganizeFileResponse extends OrganizationResult {}

export class TauriFileOrganizer implements FileOrganizer {
  async listFiles(sourcePath: string, incomingRoot: string): Promise<string[]> {
    if (!isTauriRuntime()) throw new Error("文件发现只在桌面端可用");
    return invoke<string[]>("list_organizable_files", { sourcePath, incomingRoot });
  }

  async organize(plan: OrganizationPlan): Promise<OrganizationResult> {
    if (!isTauriRuntime()) throw new Error("文件整理只在桌面端可用");
    return invoke<OrganizeFileResponse>("organize_file", {
      taskId: plan.taskId,
      sourcePath: plan.sourcePath,
      destinationPath: plan.destinationPath,
      incomingRoot: plan.incomingRoot,
      libraryRoot: plan.libraryRoot,
    });
  }
}

export function createFileOrganizer(): FileOrganizer {
  return new TauriFileOrganizer();
}
