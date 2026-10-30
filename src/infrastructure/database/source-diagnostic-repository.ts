import { initializeStoredArray, readStoredArray, updateStoredArray, assertRecord } from "@/infrastructure/database/stored-array";
import type Database from "@tauri-apps/plugin-sql";
import { loadDatabase, initializeRepository, executeTransaction, serializeDatabaseWrite } from "@/infrastructure/database/repository-runtime";
import type { SourceDiagnosticRepository } from "@/application/source-diagnostic-ports";
import type { SourceDiagnostic } from "@/domain/source-diagnostic";
import { createSourceDiagnostic } from "@/domain/source-diagnostic";

interface DiagnosticRow {
  id: string;
  source_id: string;
  source_name: string;
  stage: SourceDiagnostic["stage"];
  message: string;
  checked_at: string;
  snapshot_json: string;
}

export class SqliteSourceDiagnosticRepository implements SourceDiagnosticRepository {
  private db?: Database;

  initialize(): Promise<void> {
    return initializeRepository(this, "来源诊断数据库", async () => {
      this.db = await loadDatabase();
      await this.getDb().execute(`
        CREATE TABLE IF NOT EXISTS source_diagnostics (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          source_name TEXT NOT NULL,
          stage TEXT NOT NULL CHECK (stage IN ('health', 'search', 'resolve')),
          message TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL DEFAULT '{}'
        )
      `);
    });
  }

  async list(limit = 50): Promise<SourceDiagnostic[]> {
    const safeLimit = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 50;
    const rows = await this.getDb().select<DiagnosticRow[]>("SELECT * FROM source_diagnostics ORDER BY checked_at DESC LIMIT ?", [safeLimit]);
    return rows.map(fromRow).filter((item): item is SourceDiagnostic => Boolean(item));
  }

  async record(diagnostic: SourceDiagnostic): Promise<void> {
    assertRecord(diagnostic, isDiagnostic, "来源诊断");
    this.getDb();
    const safe = createSourceDiagnostic(diagnostic);
    await serializeDatabaseWrite(() => executeTransaction([
      { sql: `INSERT INTO source_diagnostics (id, source_id, source_name, stage, message, checked_at, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        values: [safe.id, safe.sourceId, safe.sourceName, safe.stage, safe.message, safe.checkedAt, JSON.stringify(safe.snapshot)] },
      { sql: "DELETE FROM source_diagnostics WHERE id NOT IN (SELECT id FROM source_diagnostics ORDER BY checked_at DESC LIMIT 200)", values: [] },
    ]));
  }

  async clear(): Promise<void> {
    await this.getDb().execute("DELETE FROM source_diagnostics");
  }

  private getDb(): Database {
    if (!this.db) throw new Error("来源诊断数据库尚未初始化");
    return this.db;
  }
}

export interface SourceDiagnosticStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DIAGNOSTIC_KEY = "acgn-hub.source-diagnostics.v1";

export class LocalStorageSourceDiagnosticRepository implements SourceDiagnosticRepository {
  constructor(private readonly storage: SourceDiagnosticStorageLike = window.localStorage) {}

  async initialize(): Promise<void> {
    initializeStoredArray(this.storage, DIAGNOSTIC_KEY);
  }

  async list(limit = 50): Promise<SourceDiagnostic[]> {
    const safeLimit = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 50;
    return readStoredArray(this.storage, DIAGNOSTIC_KEY, isDiagnostic).slice(0, safeLimit);
  }

  async record(diagnostic: SourceDiagnostic): Promise<void> {
    assertRecord(diagnostic, isDiagnostic, "来源诊断");
    const sanitized = createSourceDiagnostic(diagnostic);
    await updateStoredArray(this.storage, DIAGNOSTIC_KEY, isDiagnostic, (current) =>
      [sanitized, ...current.filter((item) => item.id !== sanitized.id)].slice(0, 200));
  }

  async clear(): Promise<void> {
    await updateStoredArray(this.storage, DIAGNOSTIC_KEY, isDiagnostic, () => []);
  }
}

function fromRow(row: DiagnosticRow): SourceDiagnostic | undefined {
  try {
    const snapshot = JSON.parse(row.snapshot_json) as unknown;
    return createSourceDiagnostic({
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      stage: row.stage,
      message: row.message,
      checkedAt: row.checked_at,
      snapshot: snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : {},
    });
  } catch {
    return undefined;
  }
}

function isDiagnostic(value: unknown): value is SourceDiagnostic {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SourceDiagnostic>;
  return typeof item.id === "string" && typeof item.sourceId === "string" && typeof item.sourceName === "string" &&
    ["health", "search", "resolve"].includes(item.stage ?? "") && typeof item.message === "string" &&
    typeof item.checkedAt === "string" && typeof item.snapshot === "object" && item.snapshot !== null;
}
