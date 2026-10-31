import { initializeStoredArray, readStoredArray, updateStoredArray, assertRecord } from "@/infrastructure/database/stored-array";
import type Database from "@tauri-apps/plugin-sql";
import { loadDatabase, initializeRepository } from "@/infrastructure/database/repository-runtime";
import type { SourceConfigRepository } from "@/application/source-config-ports";
import { isRetiredSourceType, type RetiredSourceConfigType, type SourceConfig } from "@/domain/source";

interface RetiredSourceRecord {
  id: string;
  type: RetiredSourceConfigType;
  name?: unknown;
  url?: unknown;
  enabled?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}
type StoredSourceConfig = SourceConfig | RetiredSourceRecord;

interface SourceConfigRow {
  source_id: string;
  enabled: number;
  config_json: string;
  updated_at: string;
}

export class SqliteSourceConfigRepository implements SourceConfigRepository {
  private db?: Database;

  initialize(): Promise<void> {
    return initializeRepository(this, "来源配置数据库", async () => {
      this.db = await loadDatabase();
      await this.getDb().execute(`
        CREATE TABLE IF NOT EXISTS source_configs (
          source_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1,
          config_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        )
      `);
    });
  }

  async list(): Promise<SourceConfig[]> {
    const rows = await this.getDb().select<SourceConfigRow[]>("SELECT * FROM source_configs ORDER BY updated_at DESC");
    return rows.flatMap(fromRow);
  }

  async upsert(config: SourceConfig): Promise<void> {
    rejectRetiredSource(config);
    assertRecord(config, isSourceConfig, "来源配置");
    await this.getDb().execute(
      `INSERT INTO source_configs (source_id, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
        enabled = excluded.enabled, config_json = excluded.config_json, updated_at = excluded.updated_at`,
      [config.id, config.enabled ? 1 : 0, JSON.stringify({ type: config.type, name: config.name, url: config.url, token: config.token, createdAt: config.createdAt, lastHealth: config.lastHealth }), config.updatedAt],
    );
  }

  async remove(id: string): Promise<void> {
    await this.getDb().execute("DELETE FROM source_configs WHERE source_id = ?", [id]);
  }

  private getDb(): Database {
    if (!this.db) throw new Error("来源配置数据库尚未初始化");
    return this.db;
  }
}

export interface SourceConfigStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SOURCE_CONFIG_KEY = "acgn-hub.source-configs.v1";

export class LocalStorageSourceConfigRepository implements SourceConfigRepository {
  constructor(private readonly storage: SourceConfigStorageLike = window.localStorage) {}

  async initialize(): Promise<void> {
    initializeStoredArray(this.storage, SOURCE_CONFIG_KEY);
  }

  async list(): Promise<SourceConfig[]> {
    return readStoredArray(this.storage, SOURCE_CONFIG_KEY, isStoredSourceConfig).map((config) =>
      isRetiredSourceType(config.type) ? retiredConfig(config.id, config.type, config, config.enabled === true, typeof config.updatedAt === "string" ? config.updatedAt : "") : config as SourceConfig);
  }

  async upsert(config: SourceConfig): Promise<void> {
    rejectRetiredSource(config);
    assertRecord(config, isSourceConfig, "SourceConfig");
    await updateStoredArray<StoredSourceConfig>(this.storage, SOURCE_CONFIG_KEY, isStoredSourceConfig, (current) =>
      [config, ...current.filter((item) => item.id !== config.id)]);
  }

  async remove(id: string): Promise<void> {
    await updateStoredArray(this.storage, SOURCE_CONFIG_KEY, isStoredSourceConfig, (current) => current.filter((item) => item.id !== id));
  }
}

function fromRow(row: SourceConfigRow): SourceConfig[] {
  try {
    const value = JSON.parse(row.config_json) as Partial<SourceConfig>;
    // Legacy retired rows remain readable for v18 cleanup even if optional
    // fields are obsolete. They must not block the remaining source catalogue.
    if (value && isRetiredSourceType(value.type)) return [retiredConfig(row.source_id, value.type, value, row.enabled === 1, row.updated_at)];
    if (!value || !isSourceType(value.type) || typeof value.name !== "string" || typeof value.url !== "string") throw new Error("来源配置字段无效");
    if ((value.token !== undefined && typeof value.token !== "string") ||
        (value.createdAt !== undefined && typeof value.createdAt !== "string") ||
        (value.lastHealth !== undefined && !isHealth(value.lastHealth))) throw new Error("来源配置包含无效的可选字段");
    return [{
      id: row.source_id,
      type: value.type,
      name: value.name,
      url: value.url,
      enabled: row.enabled === 1,
      ...(typeof value.token === "string" && value.token.trim() ? { token: value.token.trim() } : {}),
      createdAt: typeof value.createdAt === "string" ? value.createdAt : row.updated_at,
      updatedAt: row.updated_at,
      ...(isHealth(value.lastHealth) ? { lastHealth: value.lastHealth } : {}),
    }];
  } catch (cause) {
    throw new Error("来源配置记录已损坏，原始数据已保留，请先修复或导出数据库", { cause });
  }
}

function rejectRetiredSource(config: SourceConfig): void {
  if (isRetiredSourceType(config.type)) throw new Error("此来源已撤下，不再保存其来源配置");
}

function retiredConfig(id: string, type: RetiredSourceConfigType, value: { name?: unknown; url?: unknown; createdAt?: unknown }, enabled: boolean, updatedAt: string): SourceConfig {
  return { id, type, name: typeof value.name === "string" ? value.name : type, url: typeof value.url === "string" ? value.url : "",
    enabled, createdAt: typeof value.createdAt === "string" ? value.createdAt : updatedAt, updatedAt };
}

function isStoredSourceConfig(value: unknown): value is StoredSourceConfig {
  if (isSourceConfig(value)) return true;
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RetiredSourceRecord>;
  return typeof item.id === "string" && isRetiredSourceType(item.type);
}

function isHealth(value: unknown): value is SourceConfig["lastHealth"] {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NonNullable<SourceConfig["lastHealth"]>>;
  return typeof item.ok === "boolean" && typeof item.checkedAt === "string" && (item.message === undefined || typeof item.message === "string");
}

function isSourceConfig(value: unknown): value is SourceConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SourceConfig>;
  return typeof item.id === "string" && isSourceType(item.type) && typeof item.name === "string" &&
    typeof item.url === "string" && typeof item.enabled === "boolean" &&
    (item.token === undefined || typeof item.token === "string") &&
    typeof item.createdAt === "string" && typeof item.updatedAt === "string" &&
    (item.lastHealth === undefined || isHealth(item.lastHealth));
}

function isSourceType(value: unknown): value is SourceConfig["type"] {
  return value === "rss" || value === "github_release" || value === "nyaa" || value === "kungal" || value === "shinnku" || value === "shionlib" || value === "vndb_release" || value === "copymanga" || value === "jmcomic" || value === "mangadex" || value === "mangabz" || value === "weebcentral" || value === "kuaikan" || value === "archive" || value === "anime_garden" || value === "lnovel" || value === "public_video";
}
