import type Database from "@tauri-apps/plugin-sql";
import { loadDatabase, initializeRepository } from "@/infrastructure/database/repository-runtime";
import type { TaskRepository } from "@/application/ports";
import type { DownloadTask } from "@/domain/download";
import { isDownloadTask } from "./local-storage-task-repository";
import { assertRecord } from "./stored-array";
import { readDownloadDiagnostics, serializeDownloadDiagnostics } from "./download-task-diagnostics";
import { readDownloadNaming } from "./download-task-naming";

interface TaskRow {
  id: string;
  engine_id: string;
  engine_endpoint: string | null;
  engine_task_id: string | null;
  media_id: string | null;
  resource_id: string | null;
  source_name: string | null;
  source_url: string;
  protocol: DownloadTask["protocol"];
  directory: string;
  filename: string | null;
  state: DownloadTask["state"];
  total_bytes: number;
  completed_bytes: number;
  speed_bytes_per_second: number;
  connections: number | null;
  seeders: number | null;
  error_code: string | null;
  files_json: string;
  temp_path: string | null;
  final_path: string | null;
  error: string | null;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
  diagnostics_json?: string | null;
  naming_json?: string | null;
}

function fromRow(row: TaskRow): DownloadTask {
  let files: unknown;
  try { files = JSON.parse(row.files_json); }
  catch (cause) { throw new Error("下载任务的文件列表已损坏，原始记录已保留", { cause }); }
  const naming = readDownloadNaming(row.naming_json);
  const task = {
    ...readDownloadDiagnostics(row.diagnostics_json),
    ...(naming ? { naming } : {}),
    id: row.id,
    engineId: row.engine_id,
    ...(row.engine_endpoint ? { engineEndpoint: row.engine_endpoint } : {}),
    ...(row.engine_task_id ? { engineTaskId: row.engine_task_id } : {}),
    ...(row.media_id ? { mediaId: row.media_id } : {}),
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    ...(row.source_name ? { sourceName: row.source_name } : {}),
    sourceUrl: row.source_url,
    protocol: row.protocol,
    directory: row.directory,
    ...(row.filename ? { filename: row.filename } : {}),
    state: row.state,
    totalBytes: row.total_bytes,
    completedBytes: row.completed_bytes,
    speedBytesPerSecond: row.speed_bytes_per_second,
    ...(row.connections !== null ? { connections: row.connections } : {}),
    ...(row.seeders !== null ? { seeders: row.seeders } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    files,
    ...(row.temp_path ? { tempPath: row.temp_path } : {}),
    ...(row.final_path ? { finalPath: row.final_path } : {}),
    ...(row.error ? { error: row.error } : {}),
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  assertRecord(task, isDownloadTask, "数据库下载任务");
  return task;
}

export class SqliteTaskRepository implements TaskRepository {
  private db?: Database;

  initialize(): Promise<void> {
    return initializeRepository(this, "下载任务数据库", async () => {
      this.db = await loadDatabase();
      await this.db.execute(`
        CREATE TABLE IF NOT EXISTS download_tasks (
          id TEXT PRIMARY KEY,
          engine_id TEXT NOT NULL,
          engine_endpoint TEXT,
          engine_task_id TEXT,
          media_id TEXT,
          resource_id TEXT,
          source_name TEXT,
          source_url TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK (protocol IN ('http', 'magnet', 'torrent')),
          directory TEXT NOT NULL,
          filename TEXT,
          state TEXT NOT NULL,
          total_bytes INTEGER NOT NULL DEFAULT 0,
          completed_bytes INTEGER NOT NULL DEFAULT 0,
          speed_bytes_per_second INTEGER NOT NULL DEFAULT 0,
          connections INTEGER,
          seeders INTEGER,
          error_code TEXT,
          files_json TEXT NOT NULL DEFAULT '[]',
          temp_path TEXT,
          final_path TEXT,
          error TEXT,
          dedupe_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          diagnostics_json TEXT NOT NULL DEFAULT '{}',
          naming_json TEXT NOT NULL DEFAULT '{}'
        )
      `);
      await this.ensureColumn("media_id", "TEXT");
      await this.ensureColumn("engine_endpoint", "TEXT");
      await this.ensureColumn("resource_id", "TEXT");
      await this.ensureColumn("source_name", "TEXT");
      await this.ensureColumn("temp_path", "TEXT");
      await this.ensureColumn("final_path", "TEXT");
      await this.ensureColumn("connections", "INTEGER");
      await this.ensureColumn("seeders", "INTEGER");
      await this.ensureColumn("error_code", "TEXT");
      await this.ensureColumn("diagnostics_json", "TEXT NOT NULL DEFAULT '{}'");
      await this.ensureColumn("naming_json", "TEXT NOT NULL DEFAULT '{}'");
    });
  }

  async list(): Promise<DownloadTask[]> {
    const rows = await this.getDb().select<TaskRow[]>(
      "SELECT * FROM download_tasks ORDER BY created_at DESC",
    );
    return rows.map(fromRow);
  }

  async insert(task: DownloadTask): Promise<void> {
    assertRecord(task, isDownloadTask, "下载任务");
    await this.getDb().execute(
      `INSERT INTO download_tasks
        (id, engine_id, engine_endpoint, engine_task_id, media_id, resource_id, source_name, source_url, protocol, directory, filename, state,
         total_bytes, completed_bytes, speed_bytes_per_second, connections, seeders, error_code, files_json, temp_path, final_path, error,
         dedupe_key, created_at, updated_at, diagnostics_json, naming_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.engineId,
        task.engineEndpoint ?? null,
        task.engineTaskId ?? null,
        task.mediaId ?? null,
        task.resourceId ?? null,
        task.sourceName ?? null,
        task.sourceUrl,
        task.protocol,
        task.directory,
        task.filename ?? null,
        task.state,
        task.totalBytes,
        task.completedBytes,
        task.speedBytesPerSecond,
        task.connections ?? null,
        task.seeders ?? null,
        task.errorCode ?? null,
        JSON.stringify(task.files),
        task.tempPath ?? null,
        task.finalPath ?? null,
        task.error ?? null,
        task.dedupeKey,
        task.createdAt,
        task.updatedAt,
        serializeDownloadDiagnostics(task),
        JSON.stringify(task.naming ?? {}),
      ],
    );
  }

  async update(task: DownloadTask): Promise<void> {
    assertRecord(task, isDownloadTask, "下载任务");
    const result = await this.getDb().execute(
      `UPDATE download_tasks SET
        engine_id = ?, engine_endpoint = ?, engine_task_id = ?, media_id = ?, resource_id = ?, source_name = ?, source_url = ?, protocol = ?,
        directory = ?, filename = ?, state = ?, total_bytes = ?, completed_bytes = ?,
        speed_bytes_per_second = ?, connections = ?, seeders = ?, error_code = ?, files_json = ?, temp_path = ?, final_path = ?,
        error = ?, updated_at = ?, dedupe_key = ?, diagnostics_json = ?, naming_json = ?
       WHERE id = ?`,
      [
        task.engineId,
        task.engineEndpoint ?? null,
        task.engineTaskId ?? null,
        task.mediaId ?? null,
        task.resourceId ?? null,
        task.sourceName ?? null,
        task.sourceUrl,
        task.protocol,
        task.directory,
        task.filename ?? null,
        task.state,
        task.totalBytes,
        task.completedBytes,
        task.speedBytesPerSecond,
        task.connections ?? null,
        task.seeders ?? null,
        task.errorCode ?? null,
        JSON.stringify(task.files),
        task.tempPath ?? null,
        task.finalPath ?? null,
        task.error ?? null,
        task.updatedAt,
        task.dedupeKey,
        serializeDownloadDiagnostics(task),
        JSON.stringify(task.naming ?? {}),
        task.id,
      ],
    );
    if (result.rowsAffected === 0) throw new Error("需要更新的下载任务不存在");
  }

  async findById(id: string): Promise<DownloadTask | undefined> {
    const rows = await this.getDb().select<TaskRow[]>("SELECT * FROM download_tasks WHERE id = ?", [id]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async remove(id: string): Promise<void> {
    await this.getDb().execute("DELETE FROM download_tasks WHERE id = ?", [id]);
  }

  private getDb(): Database {
    if (!this.db) {
      throw new Error("任务数据库尚未初始化");
    }
    return this.db;
  }

  private async ensureColumn(name: string, type: string): Promise<void> {
    const columns = await this.getDb().select<Array<{ name: string }>>("PRAGMA table_info(download_tasks)");
    if (!columns.some((column) => column.name === name)) {
      await this.getDb().execute(`ALTER TABLE download_tasks ADD COLUMN ${name} ${type}`);
    }
  }
}
