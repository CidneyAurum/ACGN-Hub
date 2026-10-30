import { initializeStoredArray, readStoredArray, updateStoredArray, assertRecord } from "@/infrastructure/database/stored-array";
import type Database from "@tauri-apps/plugin-sql";
import { loadDatabase, initializeRepository } from "@/infrastructure/database/repository-runtime";
import type { PluginRepository } from "@/application/plugin-ports";
import type { PluginRecord } from "@/domain/plugin";
import { validatePluginManifest } from "@/domain/plugin";

interface PluginRow {
  plugin_id: string;
  enabled: number;
  manifest_json: string;
  health_json: string | null;
  updated_at: string;
}

export class SqlitePluginRepository implements PluginRepository {
  private db?: Database;

  initialize(): Promise<void> {
    return initializeRepository(this, "插件数据库", async () => {
      this.db = await loadDatabase();
      await this.getDb().execute(`
        CREATE TABLE IF NOT EXISTS plugin_manifests (
          plugin_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          manifest_json TEXT NOT NULL,
          health_json TEXT,
          updated_at TEXT NOT NULL
        )
      `);
    });
  }

  async list(): Promise<PluginRecord[]> {
    const rows = await this.getDb().select<PluginRow[]>("SELECT * FROM plugin_manifests ORDER BY updated_at DESC");
    return rows.flatMap(fromRow);
  }

  async upsert(record: PluginRecord): Promise<void> {
    assertRecord(record, isPluginRecord, "插件");
    await this.getDb().execute(
      `INSERT INTO plugin_manifests (plugin_id, enabled, manifest_json, health_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, manifest_json = excluded.manifest_json,
        health_json = excluded.health_json, updated_at = excluded.updated_at`,
      [record.manifest.id, record.enabled ? 1 : 0, JSON.stringify(record.manifest), record.lastHealth ? JSON.stringify(record.lastHealth) : null, record.updatedAt],
    );
  }

  async remove(id: string): Promise<void> {
    await this.getDb().execute("DELETE FROM plugin_manifests WHERE plugin_id = ?", [id]);
  }

  private getDb(): Database {
    if (!this.db) throw new Error("插件数据库尚未初始化");
    return this.db;
  }
}

export interface PluginStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PLUGIN_KEY = "acgn-hub.plugins.v1";

export class LocalStoragePluginRepository implements PluginRepository {
  constructor(private readonly storage: PluginStorageLike = window.localStorage) {}

  async initialize(): Promise<void> {
    initializeStoredArray(this.storage, PLUGIN_KEY);
  }

  async list(): Promise<PluginRecord[]> {
    return readStoredArray(this.storage, PLUGIN_KEY, isPluginRecord);
  }

  async upsert(record: PluginRecord): Promise<void> {
    assertRecord(record, isPluginRecord, "PluginRecord");
    await updateStoredArray(this.storage, PLUGIN_KEY, isPluginRecord, (current) =>
      [record, ...current.filter((item) => item.manifest.id !== record.manifest.id)]);
  }

  async remove(id: string): Promise<void> {
    await updateStoredArray(this.storage, PLUGIN_KEY, isPluginRecord, (current) => current.filter((item) => item.manifest.id !== id));
  }
}

function fromRow(row: PluginRow): PluginRecord[] {
  try {
    const manifest = validatePluginManifest(JSON.parse(row.manifest_json));
    const health = row.health_json ? JSON.parse(row.health_json) as PluginRecord["lastHealth"] : undefined;
    if (health && (typeof health.ok !== "boolean" || typeof health.checkedAt !== "string" || (health.message !== undefined && typeof health.message !== "string"))) {
      throw new Error("插件校验结果格式无效");
    }
    return [{ manifest, enabled: row.enabled === 1, ...(health ? { lastHealth: health } : {}), updatedAt: row.updated_at }];
  } catch (cause) {
    throw new Error("插件数据库记录已损坏，原始数据已保留", { cause });
  }
}

function isPluginRecord(value: unknown): value is PluginRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PluginRecord>;
  try {
    validatePluginManifest(item.manifest);
    const health = item.lastHealth;
    return typeof item.enabled === "boolean" && typeof item.updatedAt === "string" &&
      (health === undefined || (!!health && typeof health.ok === "boolean" && typeof health.checkedAt === "string" && (health.message === undefined || typeof health.message === "string")));
  } catch {
    return false;
  }
}
