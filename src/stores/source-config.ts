import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { isRetiredSourceType, type SourceConfig } from "@/domain/source";
import type { SourceConfigRepository } from "@/application/source-config-ports";
import { createSourceConfigRepository } from "@/infrastructure/database/create-source-config-repository";
import { DEFAULT_RESOURCE_SOURCE_CONFIGS } from "@/infrastructure/sources/default-sources";

const SOURCE_MIGRATION_KEY = "acgn-hub.resource-source-migration.v18";

export const useSourceConfigStore = defineStore("source-config", () => {
  const configs = ref<SourceConfig[]>([]);
  const loading = ref(false);
  const error = ref("");
  let repository: SourceConfigRepository | undefined;
  let initializing: Promise<void> | undefined;

  const activeConfigs = computed(() => configs.value.filter((config) => !isRetiredSourceType(config.type)));
  const enabledConfigs = computed(() => activeConfigs.value.filter((config) => config.enabled));

  async function initialize(): Promise<void> {
    if (repository) return;
    if (initializing) return initializing;
    loading.value = true;
    error.value = "";
    initializing = (async () => {
      try {
        repository = await createSourceConfigRepository();
        configs.value = await repository.list();
        await migrateResourceSources();
      } catch (cause) {
        repository = undefined;
        error.value = cause instanceof Error ? cause.message : "来源配置读取失败";
      } finally {
        loading.value = false;
        initializing = undefined;
      }
    })();
    return initializing;
  }

  async function migrateResourceSources(): Promise<void> {
    if (!repository) return;
    // Only these source configuration rows are retired. Collection items,
    // resource history, download records, media files and all other sources stay.
    // Clean on every initialization so stale legacy rows can never become active.
    for (const config of configs.value.filter((item) => isRetiredSourceType(item.type))) await repository.remove(config.id);
    configs.value = configs.value.filter((config) => !isRetiredSourceType(config.type));
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(SOURCE_MIGRATION_KEY) === "1") return;
      // Existing configuration belongs to the user. Upgrades must not reset
      // addresses, credentials, enablement, or reinsert a removed preset.
      const version16Complete = window.localStorage.getItem("acgn-hub.resource-source-migration.v16") === "1";
      const version17Complete = window.localStorage.getItem("acgn-hub.resource-source-migration.v17") === "1";
      const previouslyInitialized = Array.from({ length: 17 }, (_, index) => index + 1)
        .some((version) => window.localStorage.getItem(`acgn-hub.resource-source-migration.v${version}`) === "1");
      let hasLegacySources = false;
      try {
        const legacy: unknown = JSON.parse(window.localStorage.getItem("acgn-hub.source-configs.v1") ?? "[]");
        hasLegacySources = Array.isArray(legacy) && legacy.length > 0;
      } catch { hasLegacySources = true; }
      if (!previouslyInitialized && !hasLegacySources) {
        const existingIds = new Set(configs.value.map((config) => config.id));
        const existingUrls = new Set(configs.value.map((config) => config.url));
        for (const config of DEFAULT_RESOURCE_SOURCE_CONFIGS.filter((item) => !isRetiredSourceType(item.type))) {
          if (!existingIds.has(config.id) && !existingUrls.has(config.url)) await repository.upsert(config);
        }
      } else if (previouslyInitialized && !hasLegacySources) {
        // v17 already offered MangaBZ. A v18 upgrade must not restore a preset
        // the user removed, while pre-v17 installs may receive that opt-in once.
        const newTypes = version17Complete ? [] : ["mangabz", ...(!version16Complete ? ["public_video"] : [])];
        for (const preset of DEFAULT_RESOURCE_SOURCE_CONFIGS.filter((config) => newTypes.includes(config.type))) {
          if (!configs.value.some((config) => config.id === preset.id || config.type === preset.type || config.url === preset.url)) await repository.upsert(preset);
        }
      }
      configs.value = await repository.list();
      window.localStorage.setItem(SOURCE_MIGRATION_KEY, "1");
    } catch {
      // 来源迁移失败不能阻断用户手动配置来源。
    }
  }

  async function save(config: SourceConfig): Promise<void> {
    if (isRetiredSourceType(config.type)) throw new Error("此来源已撤下，不能重新添加配置；已有文件和下载记录仍保留");
    await initialize();
    if (!repository) throw new Error("来源配置尚未初始化");
    await repository.upsert(config);
    configs.value = [config, ...configs.value.filter((item) => item.id !== config.id)];
  }

  async function remove(id: string): Promise<void> {
    await initialize();
    if (!repository) throw new Error("来源配置尚未初始化");
    await repository.remove(id);
    configs.value = configs.value.filter((item) => item.id !== id);
  }

  return { configs: computed(() => [...activeConfigs.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))), enabledConfigs, loading, error, initialize, save, remove };
});
