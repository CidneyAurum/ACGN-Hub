import { initializeStoredArray, readStoredArray, updateStoredArray, assertRecord } from "@/infrastructure/database/stored-array";
import type Database from "@tauri-apps/plugin-sql";
import { loadDatabase, initializeRepository, executeTransaction, serializeDatabaseWrite } from "@/infrastructure/database/repository-runtime";
import type { LocalFileRepository } from "@/application/local-file-ports";
import { reconcileLocalFiles, type LocalFile, type ScannedLocalFile } from "@/domain/local-file";

interface LocalFileRow {
  id: string;
  media_id: string | null;
  path: string;
  size_bytes: number;
  sha256: string | null;
  status: LocalFile["status"];
  duplicate_of: string | null;
  scanned_at: string;
}

export class SqliteLocalFileRepository implements LocalFileRepository {
  private db?: Database;

  initialize(): Promise<void> {
    return initializeRepository(this, "本地文件数据库", async () => {
      this.db = await loadDatabase();
      await this.getDb().execute(`
        CREATE TABLE IF NOT EXISTS local_files (
          id TEXT PRIMARY KEY,
          media_id TEXT,
          path TEXT NOT NULL UNIQUE,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          sha256 TEXT,
          status TEXT NOT NULL DEFAULT 'present',
          duplicate_of TEXT,
          created_at TEXT NOT NULL,
          scanned_at TEXT NOT NULL
        )
      `);
      await this.ensureColumn("status", "TEXT NOT NULL DEFAULT 'present'");
      await this.ensureColumn("duplicate_of", "TEXT");
    });
  }

  async list(): Promise<LocalFile[]> {
    const rows = await this.getDb().select<LocalFileRow[]>("SELECT * FROM local_files ORDER BY path COLLATE NOCASE");
    return rows.map((row) => {
      const file = {
      id: row.id,
      ...(row.media_id ? { mediaId: row.media_id } : {}),
      path: row.path,
      sizeBytes: row.size_bytes,
      ...(row.sha256 ? { sha256: row.sha256 } : {}),
      status: row.status,
      ...(row.duplicate_of ? { duplicateOf: row.duplicate_of } : {}),
      scannedAt: row.scanned_at,
      };
      assertRecord(file, isLocalFile, "数据库本地文件");
      return file;
    });
  }

  async replaceScan(files: ScannedLocalFile[]): Promise<void> {
    validateScan(files);
    await serializeDatabaseWrite(async () => {
      const scannedAt = new Date().toISOString();
      const reconciled = reconcileLocalFiles(await this.list(), files, scannedAt);
      await executeTransaction([
        { sql: "DELETE FROM local_files", values: [] },
        ...reconciled.map((file) => ({
          sql: `INSERT INTO local_files (id, media_id, path, size_bytes, sha256, status, duplicate_of, created_at, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [file.id, file.mediaId ?? null, file.path, file.sizeBytes, file.sha256 ?? null, file.status, file.duplicateOf ?? null, file.scannedAt, file.scannedAt],
        })),
      ]);
    });
  }

  async assignMedia(fileId: string, mediaId?: string): Promise<void> {
    const result = await serializeDatabaseWrite(() => this.getDb().execute(
      "UPDATE local_files SET media_id = ? WHERE id = ?",
      [mediaId ?? null, fileId],
    ));
    if (result.rowsAffected === 0) throw new Error("找不到需要匹配的本地文件");
  }

  private getDb(): Database {
    if (!this.db) throw new Error("本地文件数据库尚未初始化");
    return this.db;
  }

  private async ensureColumn(name: string, definition: string): Promise<void> {
    const columns = await this.getDb().select<Array<{ name: string }>>("PRAGMA table_info(local_files)");
    if (!columns.some((column) => column.name === name)) await this.getDb().execute(`ALTER TABLE local_files ADD COLUMN ${name} ${definition}`);
  }
}

export interface LocalFileStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LOCAL_FILE_KEY = "acgn-hub.local-files.v1";

export class LocalStorageLocalFileRepository implements LocalFileRepository {
  constructor(private readonly storage: LocalFileStorageLike = window.localStorage) {}

  async initialize(): Promise<void> {
    initializeStoredArray(this.storage, LOCAL_FILE_KEY);
  }

  async list(): Promise<LocalFile[]> {
    return readStoredArray(this.storage, LOCAL_FILE_KEY, isLocalFile).map((item) => ({ ...item, status: item.status ?? "present" as const }));
  }

  async replaceScan(files: ScannedLocalFile[]): Promise<void> {
    validateScan(files);
    const scannedAt = new Date().toISOString();
    await updateStoredArray(this.storage, LOCAL_FILE_KEY, isLocalFile, (current) => reconcileLocalFiles(current, files, scannedAt));
  }

  async assignMedia(fileId: string, mediaId?: string): Promise<void> {
    await updateStoredArray(this.storage, LOCAL_FILE_KEY, isLocalFile, (current) => {
      if (!current.some((item) => item.id === fileId)) throw new Error("找不到需要匹配的本地文件");
      return current.map((item) => item.id === fileId ? { ...item, mediaId } : item);
    });
  }
}

function isLocalFile(value: unknown): value is LocalFile {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalFile>;
  return typeof item.id === "string" && typeof item.path === "string" && typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0 &&
    (item.status === undefined || ["present", "missing", "duplicate"].includes(item.status)) && typeof item.scannedAt === "string";
}

function validateScan(files: ScannedLocalFile[]): void {
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.id !== "string" || !file.id || typeof file.path !== "string" || !file.path ||
        !Number.isFinite(file.sizeBytes) || file.sizeBytes < 0 || (file.sha256 !== undefined && typeof file.sha256 !== "string")) {
      throw new Error("扫描结果含无效文件，原有索引保持不变");
    }
    const path = file.path.toLowerCase();
    if (paths.has(path) || ids.has(file.id)) throw new Error("扫描结果含重复路径或 ID，原有索引保持不变");
    paths.add(path);
    ids.add(file.id);
  }
}
