import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { OrganizationHistoryRecord } from "@/domain/organization-history";
import type { OrganizationHistoryRepository } from "@/application/organization-history-ports";
import { createOrganizationHistoryRepository } from "@/infrastructure/database/create-organization-history-repository";

export const useOrganizationHistoryStore = defineStore("organization-history", () => {
  const records = ref<OrganizationHistoryRecord[]>([]);
  const error = ref("");
  let repository: OrganizationHistoryRepository | undefined;

  async function initialize(): Promise<void> {
    if (repository) return;
    try {
      repository = await createOrganizationHistoryRepository();
      records.value = await repository.list();
      error.value = "";
    } catch (cause) {
      repository = undefined;
      error.value = cause instanceof Error ? cause.message : "整理历史读取失败";
    }
  }

  async function add(record: OrganizationHistoryRecord): Promise<void> {
    await initialize();
    if (!repository) throw new Error("整理历史尚未初始化");
    await repository.add(record);
    records.value = [record, ...records.value].slice(0, 500);
  }

  return { records: computed(() => records.value), error, initialize, add };
});
