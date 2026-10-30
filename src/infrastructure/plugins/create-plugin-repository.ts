import type { PluginRepository } from "@/application/plugin-ports";
import { createRepository } from "@/infrastructure/database/repository-runtime";
import { LocalStoragePluginRepository, SqlitePluginRepository } from "./plugin-repository";

export function createPluginRepository(): Promise<PluginRepository> {
  return createRepository<PluginRepository>("plugins", () => new SqlitePluginRepository(), () => new LocalStoragePluginRepository());
}
