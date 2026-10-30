import { initializeStoredArray, readStoredArray, updateStoredArray, assertRecord } from "@/infrastructure/database/stored-array";
import type Database from "@tauri-apps/plugin-sql";
import { loadDatabase, initializeRepository, ensureColumns, executeTransaction, serializeDatabaseWrite } from "@/infrastructure/database/repository-runtime";
import type { ResourceRepository } from "@/application/resource-ports";
import type { ResourceItem } from "@/domain/resource";

interface ResourceRow {
  id: string;
  source_id: string;
  source_item_id: string;
  media_id: string | null;
  title: string;
  protocol: ResourceItem["protocol"];
  target_url: string;
  metadata_json: string;
  details_json: string;
  created_at: string;
}

export class SqliteResourceRepository implements ResourceRepository {
  private db?: Database;

  initialize(): Promise<void> {
    return initializeRepository(this, "资源数据库", async () => {
      this.db = await loadDatabase();
      await this.getDb().execute(`
        CREATE TABLE IF NOT EXISTS source_items (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          source_item_id TEXT NOT NULL,
          media_id TEXT,
          title TEXT NOT NULL,
          raw_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE (source_id, source_item_id)
        )
      `);
      await this.getDb().execute(`
        CREATE TABLE IF NOT EXISTS resources (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          source_item_id TEXT NOT NULL,
          media_id TEXT,
          title TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK (protocol IN ('http', 'magnet', 'torrent')),
          target_url TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          UNIQUE (source_id, source_item_id, target_url)
        )
      `);
      await ensureColumns(this.getDb(), "resources", { details_json: "TEXT NOT NULL DEFAULT '{}'", media_id: "TEXT" });
      await ensureColumns(this.getDb(), "source_items", { media_id: "TEXT", raw_json: "TEXT NOT NULL DEFAULT '{}'" });
    });
  }

  async upsert(resource: ResourceItem): Promise<void> {
    assertRecord(resource, isResource, "资源");
    this.getDb();
    await serializeDatabaseWrite(() => executeTransaction([
      { sql: `INSERT INTO source_items (id, source_id, source_item_id, media_id, title, raw_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, source_item_id) DO UPDATE SET media_id = excluded.media_id, title = excluded.title, raw_json = excluded.raw_json`,
        values: [`${resource.sourceId}:${resource.sourceItemId}`, resource.sourceId, resource.sourceItemId, resource.mediaId ?? null, resource.title, JSON.stringify(resource.metadata)] },
      { sql: `INSERT INTO resources
        (id, source_id, source_item_id, media_id, title, protocol, target_url, metadata_json, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        media_id = excluded.media_id, title = excluded.title, protocol = excluded.protocol,
        target_url = excluded.target_url, metadata_json = excluded.metadata_json, details_json = excluded.details_json`,
      values: [
        resource.id,
        resource.sourceId,
        resource.sourceItemId,
        resource.mediaId ?? null,
        resource.title,
        resource.protocol,
        resource.targetUrl,
        JSON.stringify(resource.metadata),
        JSON.stringify(resourceDetails(resource)),
        resource.createdAt,
      ] },
    ]));
  }

  async remove(id: string): Promise<void> {
    await this.getDb().execute("DELETE FROM resources WHERE id = ?", [id]);
  }

  async list(): Promise<ResourceItem[]> {
    const rows = await this.getDb().select<ResourceRow[]>("SELECT * FROM resources ORDER BY created_at DESC");
    return rows.map(fromRow);
  }

  async findById(id: string): Promise<ResourceItem | undefined> {
    const rows = await this.getDb().select<ResourceRow[]>("SELECT * FROM resources WHERE id = ?", [id]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  private getDb(): Database {
    if (!this.db) throw new Error("资源数据库尚未初始化");
    return this.db;
  }
}

export interface ResourceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const RESOURCE_KEY = "acgn-hub.resources.v1";

export class LocalStorageResourceRepository implements ResourceRepository {
  constructor(private readonly storage: ResourceStorageLike = window.localStorage) {}

  async initialize(): Promise<void> {
    initializeStoredArray(this.storage, RESOURCE_KEY);
  }

  async list(): Promise<ResourceItem[]> {
    return readStoredArray(this.storage, RESOURCE_KEY, isResource);
  }

  async upsert(resource: ResourceItem): Promise<void> {
    assertRecord(resource, isResource, "ResourceItem");
    await updateStoredArray(this.storage, RESOURCE_KEY, isResource, (current) =>
      [resource, ...current.filter((item) => item.id !== resource.id)]);
  }

  async remove(id: string): Promise<void> {
    await updateStoredArray(this.storage, RESOURCE_KEY, isResource, (current) => current.filter((item) => item.id !== id));
  }

  async findById(id: string): Promise<ResourceItem | undefined> {
    return (await this.list()).find((item) => item.id === id);
  }
}

function fromRow(row: ResourceRow): ResourceItem {
  const metadata = parseRecordJson(row.metadata_json, "资源元数据");
  const details = parseRecordJson(row.details_json ?? "{}", "资源属性");
  const resource = {
    ...details,
    id: row.id,
    sourceId: row.source_id,
    sourceItemId: row.source_item_id,
    ...(row.media_id ? { mediaId: row.media_id } : {}),
    title: row.title,
    protocol: row.protocol,
    targetUrl: row.target_url,
    metadata,
    createdAt: row.created_at,
  };
  assertRecord(resource, isResource, "数据库资源");
  return resource;
}

function resourceDetails(resource: ResourceItem): Record<string, unknown> {
  const { episode, chapter, volume, language, resolution, format, sizeBytes, publishedAt } = resource;
  return { episode, chapter, volume, language, resolution, format, sizeBytes, publishedAt };
}

function parseRecordJson(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Report the damaged row instead of overwriting its JSON with {}. */ }
  throw new Error(`${label}已损坏，原始数据库记录已保留`);
}

function isResource(value: unknown): value is ResourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ResourceItem>;
  return typeof item.id === "string" && typeof item.sourceId === "string" && typeof item.sourceItemId === "string" &&
    typeof item.title === "string" && ["http", "magnet", "torrent"].includes(item.protocol ?? "") &&
    typeof item.targetUrl === "string" && typeof item.createdAt === "string" && typeof item.metadata === "object" && item.metadata !== null && !Array.isArray(item.metadata) &&
    [item.episode, item.chapter, item.volume, item.sizeBytes].every((value) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0)) &&
    [item.language, item.resolution, item.format, item.publishedAt].every((value) => value === undefined || typeof value === "string");
}
