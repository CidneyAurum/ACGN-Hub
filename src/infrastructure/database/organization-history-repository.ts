import { initializeStoredArray, readStoredArray, updateStoredArray, assertRecord } from "@/infrastructure/database/stored-array";
import type Database from "@tauri-apps/plugin-sql";
import { loadDatabase, initializeRepository } from "@/infrastructure/database/repository-runtime";
import type { OrganizationHistoryRepository } from "@/application/organization-history-ports";
import type { OrganizationHistoryRecord } from "@/domain/organization-history";

interface HistoryRow {
  id: string;
  task_id: string;
  media_id: string;
  source_path: string;
  destination_path: string;
  status: OrganizationHistoryRecord["status"];
  error: string | null;
  created_at: string;
}

export class SqliteOrganizationHistoryRepository implements OrganizationHistoryRepository {
  private db?: Database;

  initialize(): Promise<void> {
    return initializeRepository(this, "整理历史数据库", async () => {
      this.db = await loadDatabase();
      await this.getDb().execute(`
        CREATE TABLE IF NOT EXISTS organization_history (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          media_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          destination_path TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('moved', 'already_present', 'failed')),
          error TEXT,
          created_at TEXT NOT NULL
        )
      `);
    });
  }

  async list(): Promise<OrganizationHistoryRecord[]> {
    const rows = await this.getDb().select<HistoryRow[]>("SELECT * FROM organization_history ORDER BY created_at DESC LIMIT 500");
    return rows.map(fromRow);
  }

  async add(record: OrganizationHistoryRecord): Promise<void> {
    assertRecord(record, isHistory, "整理历史");
    await this.getDb().execute(
      `INSERT INTO organization_history
        (id, task_id, media_id, source_path, destination_path, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.taskId, record.mediaId, record.sourcePath, record.destinationPath, record.status, record.error ?? null, record.createdAt],
    );
  }

  private getDb(): Database {
    if (!this.db) throw new Error("整理历史数据库尚未初始化");
    return this.db;
  }
}

export interface OrganizationHistoryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const HISTORY_KEY = "acgn-hub.organization-history.v1";

export class LocalStorageOrganizationHistoryRepository implements OrganizationHistoryRepository {
  constructor(private readonly storage: OrganizationHistoryStorageLike = window.localStorage) {}

  async initialize(): Promise<void> {
    initializeStoredArray(this.storage, HISTORY_KEY);
  }

  async list(): Promise<OrganizationHistoryRecord[]> {
    return readStoredArray(this.storage, HISTORY_KEY, isHistory);
  }

  async add(record: OrganizationHistoryRecord): Promise<void> {
    assertRecord(record, isHistory, "OrganizationHistoryRecord");
    await updateStoredArray(this.storage, HISTORY_KEY, isHistory, (current) =>
      [record, ...current.filter((item) => item.id !== record.id)]);
  }
}

function fromRow(row: HistoryRow): OrganizationHistoryRecord {
  const record = {
    id: row.id,
    taskId: row.task_id,
    mediaId: row.media_id,
    sourcePath: row.source_path,
    destinationPath: row.destination_path,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
  };
  assertRecord(record, isHistory, "数据库整理历史");
  return record;
}

function isHistory(value: unknown): value is OrganizationHistoryRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OrganizationHistoryRecord>;
  return typeof item.id === "string" && typeof item.taskId === "string" && typeof item.mediaId === "string" &&
    typeof item.sourcePath === "string" && typeof item.destinationPath === "string" &&
    ["moved", "already_present", "failed"].includes(item.status ?? "") && typeof item.createdAt === "string";
}
