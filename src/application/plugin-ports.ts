import type { PluginRecord } from "@/domain/plugin";

export interface PluginRepository {
  initialize(): Promise<void>;
  list(): Promise<PluginRecord[]>;
  upsert(record: PluginRecord): Promise<void>;
  remove(id: string): Promise<void>;
}
