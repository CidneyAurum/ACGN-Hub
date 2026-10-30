import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { isTauriRuntime, nowIso } from "@/shared/runtime";
import { isMedia } from "@/infrastructure/library/local-storage-media-repository";
import { isDownloadTask } from "./local-storage-task-repository";
import { loadDatabase, serializeDatabaseWrite, type SqlStatement } from "./repository-runtime";
import { createTaskRepository } from "./create-task-repository";
import { createMediaLibraryRepository } from "@/infrastructure/library/create-media-library-repository";
import { createResourceRepository } from "./create-resource-repository";
import { createSourceConfigRepository } from "./create-source-config-repository";
import { createLocalFileRepository } from "./create-local-file-repository";
import { createGameInstallRepository } from "./create-game-install-repository";
import { createOrganizationHistoryRepository } from "./create-organization-history-repository";
import { createSourceDiagnosticRepository } from "./create-source-diagnostic-repository";
import { createPluginRepository } from "@/infrastructure/plugins/create-plugin-repository";
import { validatePluginManifest } from "@/domain/plugin";
import { createSourceDiagnostic } from "@/domain/source-diagnostic";
import { isRetiredSourceType } from "@/domain/source";
import { serializeDownloadDiagnostics } from "./download-task-diagnostics";
import type { DownloadTask } from "@/domain/download";

export const LEGACY_STORAGE_KEYS = {
  media: "acgn-hub.media-library.v1", sources: "acgn-hub.source-configs.v1",
  resources: "acgn-hub.resources.v1", tasks: "acgn-hub.download-tasks.v1",
  files: "acgn-hub.local-files.v1", games: "acgn-hub.game-installs.v1",
  history: "acgn-hub.organization-history.v1", diagnostics: "acgn-hub.source-diagnostics.v1",
  plugins: "acgn-hub.plugins.v1",
} as const;
export type LegacyKind = keyof typeof LEGACY_STORAGE_KEYS;
const kinds = Object.keys(LEGACY_STORAGE_KEYS) as LegacyKind[];
const labels: Record<LegacyKind, string> = { media: "收藏作品", sources: "来源配置", resources: "资源记录", tasks: "下载任务", files: "文件索引", games: "游戏安装", history: "整理历史", diagnostics: "来源诊断", plugins: "插件清单" };
const REVIEWED_KEY = "acgn-hub.legacy-import-reviewed.v1";
type RecordValue = Record<string, unknown>;
export interface LegacyStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface LegacyCategorySummary {
  kind: LegacyKind; label: string; detected: number; valid: number; invalid: number;
  conflicts: number; importable: number; imported: number; issues: string[];
}
export interface LegacyImportPreview { categories: LegacyCategorySummary[]; totalDetected: number; totalImportable: number; pausedTasks: number }
export interface LegacyImportResult extends LegacyImportPreview { totalImported: number }
export interface LegacyExistingRecords {
  media: Array<{ id: string }>;
  externalIds: Array<{ media_id: string; provider: string; external_id: string }>;
  sources: Array<{ source_id: string }>;
  resources: Array<{ id: string; source_id: string; source_item_id: string; target_url: string }>;
  tasks: Array<{ id: string; dedupe_key: string }>;
  files: Array<{ id: string; path: string }>;
  games: Array<{ id: string; path: string }>;
  history: Array<{ id: string }>;
  diagnostics: Array<{ id: string }>;
  plugins: Array<{ plugin_id: string }>;
}
export interface LegacyMigrationDriver {
  initialize(): Promise<void>;
  existing(): Promise<LegacyExistingRecords>;
  transaction(statements: SqlStatement[]): Promise<number[]>;
}
interface PlannedStatement extends SqlStatement { kind: LegacyKind; primary: boolean; paused?: boolean }
interface ImportPlan { preview: LegacyImportPreview; statements: PlannedStatement[]; snapshot: Map<string, string | null> }

const text = z.string().min(1);
const optionalText = z.string().optional();
const finiteNumber = z.number().finite().nonnegative();
const health = z.object({ ok: z.boolean(), checkedAt: text, message: optionalText });
const sourceSchema = z.object({ id: text, type: z.enum(["rss", "github_release", "nyaa", "anime_garden", "kungal", "copymanga", "jmcomic", "mangadex", "mangabz", "weebcentral", "kuaikan", "archive", "lnovel", "public_video"]), name: text, url: text, enabled: z.boolean(), createdAt: text, updatedAt: text, token: optionalText, lastHealth: health.optional() }).passthrough();
const resourceSchema = z.object({ id: text, sourceId: text, sourceItemId: text, title: text, protocol: z.enum(["http", "magnet", "torrent"]), targetUrl: text, createdAt: text, metadata: z.record(z.string(), z.unknown()), mediaId: optionalText, episode: finiteNumber.optional(), chapter: finiteNumber.optional(), volume: finiteNumber.optional(), sizeBytes: finiteNumber.optional(), language: optionalText, resolution: optionalText, format: optionalText, publishedAt: optionalText }).passthrough();
const fileSchema = z.object({ id: text, path: text, sizeBytes: finiteNumber, status: z.enum(["present", "missing", "duplicate"]).optional(), scannedAt: text, mediaId: optionalText, sha256: optionalText, duplicateOf: optionalText }).passthrough();
const gameSchema = z.object({ id: text, path: text, title: text, engine: z.enum(["renpy", "kirikiri", "unity", "unknown"]), detectedFiles: z.array(z.string()), createdAt: text, updatedAt: text, mediaId: optionalText, coverUrl: optionalText, launchPath: optionalText }).passthrough();
const historySchema = z.object({ id: text, taskId: text, mediaId: text, sourcePath: text, destinationPath: text, status: z.enum(["moved", "already_present", "failed"]), createdAt: text, error: optionalText }).passthrough();
const diagnosticSchema = z.object({ id: text, sourceId: text, sourceName: text, stage: z.enum(["health", "search", "resolve"]), message: z.string(), checkedAt: text, snapshot: z.record(z.string(), z.unknown()) }).passthrough();
const pluginSchema = z.object({ enabled: z.boolean(), updatedAt: text, lastHealth: health.optional() }).passthrough();

function valid(kind: LegacyKind, value: unknown): value is RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (kind === "media") return isMedia(value) && value.externalIds.length <= 64;
  if (kind === "tasks") return isDownloadTask(value);
  const schema = { sources: sourceSchema, resources: resourceSchema, files: fileSchema, games: gameSchema, history: historySchema, diagnostics: diagnosticSchema, plugins: pluginSchema }[kind];
  if (!schema.safeParse(value).success) return false;
  if (kind === "plugins") { try { validatePluginManifest((value as RecordValue).manifest); } catch { return false; } }
  return true;
}

function snapshots(storage: LegacyStorage): Map<string, string | null> {
  return new Map(kinds.map((kind) => [LEGACY_STORAGE_KEYS[kind], storage.getItem(LEGACY_STORAGE_KEYS[kind])]));
}

function fingerprint(snapshot: Map<string, string | null>): string {
  let hash = 2166136261;
  for (const [key, value] of snapshot) for (const char of `${key}:${value ?? ""}\n`) {
    hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Detects old records without initializing repositories or modifying any key. */
export function detectLegacyStorageImport(storage: LegacyStorage = window.localStorage): boolean {
  const snapshot = snapshots(storage);
  const hasRecords = [...snapshot.values()].some((raw) => {
    if (raw === null) return false;
    try { const parsed: unknown = JSON.parse(raw); return !Array.isArray(parsed) || parsed.length > 0; } catch { return true; }
  });
  return hasRecords && storage.getItem(REVIEWED_KEY) !== fingerprint(snapshot);
}

function planImport(storage: LegacyStorage, existing: LegacyExistingRecords): ImportPlan {
  const snapshot = snapshots(storage);
  const categories = kinds.map<LegacyCategorySummary>((kind) => ({ kind, label: labels[kind], detected: 0, valid: 0, invalid: 0, conflicts: 0, importable: 0, imported: 0, issues: [] }));
  const statements: PlannedStatement[] = [];
  let pausedTasks = 0;
  const now = nowIso();
  const externalOwners = new Map(existing.externalIds.map((row) => [JSON.stringify([row.provider, row.external_id]), row.media_id]));
  const ids: Record<LegacyKind, Set<string>> = {
    media: new Set(existing.media.map((row) => row.id)), sources: new Set(existing.sources.map((row) => row.source_id)),
    resources: new Set(existing.resources.map((row) => row.id)), tasks: new Set(existing.tasks.map((row) => row.id)),
    files: new Set(existing.files.map((row) => row.id)), games: new Set(existing.games.map((row) => row.id)),
    history: new Set(existing.history.map((row) => row.id)), diagnostics: new Set(existing.diagnostics.map((row) => row.id)), plugins: new Set(existing.plugins.map((row) => row.plugin_id)),
  };
  const uniqueKeys = {
    resources: new Set(existing.resources.map((row) => JSON.stringify([row.source_id, row.source_item_id, row.target_url]))),
    tasks: new Set(existing.tasks.map((row) => row.dedupe_key)),
    files: new Set(existing.files.map((row) => row.path.toLowerCase())), games: new Set(existing.games.map((row) => row.path.toLowerCase())),
  };
  const insert = (kind: LegacyKind, table: string, columns: string[], values: unknown[], primary = true, paused = false) => {
    statements.push({ kind, primary, paused, sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`, values });
  };

  for (const category of categories) {
    const { kind } = category;
    const raw = snapshot.get(LEGACY_STORAGE_KEYS[kind]);
    if (raw === null || raw === undefined) continue;
    let records: unknown;
    try { records = JSON.parse(raw); } catch { records = undefined; }
    if (!Array.isArray(records)) {
      category.detected = 1; category.invalid = 1;
      category.issues.push("原记录不是有效的 JSON 列表，原始文本保持不变。"); continue;
    }
    category.detected = records.length;
    for (const [index, value] of records.entries()) {
      if (kind === "sources" && value && typeof value === "object" && isRetiredSourceType((value as RecordValue).type)) {
        category.invalid += 1;
        if (category.issues.length < 3) category.issues.push(`第 ${index + 1} 条来源已撤下，不再导入配置；原始旧存储和已有下载文件保留。`);
        continue;
      }
      if (!valid(kind, value)) {
        category.invalid += 1;
        if (category.issues.length < 3) category.issues.push(`第 ${index + 1} 条字段无效，保留在旧存储中。`);
        continue;
      }
      category.valid += 1;
      const row = value;
      const id = kind === "plugins" ? String((row.manifest as RecordValue).id) : String(row.id);
      let conflict = ids[kind].has(id);
      let secondary: string | undefined;
      if (kind === "media") {
        for (const external of row.externalIds as Array<{ provider: string; value: string }>) {
          const owner = externalOwners.get(JSON.stringify([external.provider, external.value]));
          if (owner !== undefined && owner !== id) conflict = true;
        }
      } else if (kind === "resources") secondary = JSON.stringify([row.sourceId, row.sourceItemId, row.targetUrl]);
      else if (kind === "tasks") secondary = String(row.dedupeKey);
      else if (kind === "files" || kind === "games") secondary = String(row.path).toLowerCase();
      if (secondary !== undefined && uniqueKeys[kind as keyof typeof uniqueKeys].has(secondary)) conflict = true;
      if (conflict) { category.conflicts += 1; continue; }
      ids[kind].add(id);
      if (secondary !== undefined) uniqueKeys[kind as keyof typeof uniqueKeys].add(secondary);
      category.importable += 1;

      if (kind === "media") {
        const externalIds = [...new Map((row.externalIds as Array<{ provider: string; value: string }>).map((external) => [JSON.stringify([external.provider, external.value]), external])).values()];
        for (const external of externalIds) externalOwners.set(JSON.stringify([external.provider, external.value]), id);
        const values: unknown[] = [id, row.type, row.title, row.originalTitle ?? null, JSON.stringify(row.aliases), row.coverUrl ?? null, row.description ?? null, row.releaseYear ?? null, JSON.stringify(row.metadata), now, now];
        const guards = externalIds.map(() => "(provider = ? AND external_id = ?)");
        // Recheck mappings inside the same native write transaction, then use
        // changes() so external IDs are added only for a newly inserted work.
        const guard = guards.length ? ` WHERE NOT EXISTS (SELECT 1 FROM external_ids WHERE ${guards.join(" OR ")})` : " WHERE 1";
        statements.push({ kind, primary: true, sql: `INSERT INTO media (id, type, title, original_title, aliases_json, cover_url, description, release_year, metadata_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${guard} ON CONFLICT DO NOTHING`, values: [...values, ...externalIds.flatMap((external) => [external.provider, external.value])] });
        for (const external of externalIds) statements.push({ kind, primary: false, sql: "INSERT INTO external_ids (media_id, provider, external_id) SELECT ?, ?, ? WHERE changes() > 0 ON CONFLICT DO NOTHING", values: [id, external.provider, external.value] });
      } else if (kind === "sources") {
        insert(kind, "source_configs", ["source_id", "enabled", "config_json", "updated_at"], [id, row.enabled ? 1 : 0, JSON.stringify(row), row.updatedAt]);
      } else if (kind === "resources") {
        insert(kind, "source_items", ["id", "source_id", "source_item_id", "media_id", "title", "raw_json"], [`${row.sourceId}:${row.sourceItemId}`, row.sourceId, row.sourceItemId, row.mediaId ?? null, row.title, JSON.stringify(row.metadata)], false);
        const details = Object.fromEntries(["episode", "chapter", "volume", "language", "resolution", "format", "sizeBytes", "publishedAt"].filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
        insert(kind, "resources", ["id", "source_id", "source_item_id", "media_id", "title", "protocol", "target_url", "metadata_json", "details_json", "created_at"], [id, row.sourceId, row.sourceItemId, row.mediaId ?? null, row.title, row.protocol, row.targetUrl, JSON.stringify(row.metadata), JSON.stringify(details), row.createdAt]);
      } else if (kind === "tasks") {
        const active = ["queued", "downloading", "paused"].includes(String(row.state));
        if (active) pausedTasks += 1;
        insert(kind, "download_tasks", ["id", "engine_id", "engine_endpoint", "engine_task_id", "media_id", "resource_id", "source_name", "source_url", "protocol", "directory", "filename", "state", "total_bytes", "completed_bytes", "speed_bytes_per_second", "connections", "seeders", "error_code", "files_json", "temp_path", "final_path", "error", "dedupe_key", "created_at", "updated_at", "diagnostics_json", "naming_json"], [id, row.engineId, row.engineEndpoint ?? null, active ? null : row.engineTaskId ?? null, row.mediaId ?? null, row.resourceId ?? null, row.sourceName ?? null, row.sourceUrl, row.protocol, row.directory, row.filename ?? null, active ? "paused" : row.state, row.totalBytes, row.completedBytes, active ? 0 : row.speedBytesPerSecond, row.connections ?? null, row.seeders ?? null, active ? "LEGACY_IMPORTED_PAUSED" : row.errorCode ?? null, JSON.stringify(row.files), row.tempPath ?? null, row.finalPath ?? null, active ? "旧版任务已导入，请确认目录和引擎后继续" : row.error ?? null, row.dedupeKey, row.createdAt, active ? now : row.updatedAt, serializeDownloadDiagnostics(row as unknown as DownloadTask), JSON.stringify(row.naming ?? {})], true, active);
      } else if (kind === "files") {
        insert(kind, "local_files", ["id", "media_id", "path", "size_bytes", "sha256", "status", "duplicate_of", "created_at", "scanned_at"], [id, row.mediaId ?? null, row.path, row.sizeBytes, row.sha256 ?? null, row.status ?? "present", row.duplicateOf ?? null, row.scannedAt, row.scannedAt]);
      } else if (kind === "games") {
        insert(kind, "game_installs", ["id", "path", "title", "media_id", "cover_url", "engine", "launch_path", "detected_files_json", "created_at", "updated_at"], [id, row.path, row.title, row.mediaId ?? null, row.coverUrl ?? null, row.engine, row.launchPath ?? null, JSON.stringify(row.detectedFiles), row.createdAt, row.updatedAt]);
      } else if (kind === "history") {
        insert(kind, "organization_history", ["id", "task_id", "media_id", "source_path", "destination_path", "status", "error", "created_at"], [id, row.taskId, row.mediaId, row.sourcePath, row.destinationPath, row.status, row.error ?? null, row.createdAt]);
      } else if (kind === "diagnostics") {
        const safe = createSourceDiagnostic(row as unknown as Parameters<typeof createSourceDiagnostic>[0]);
        insert(kind, "source_diagnostics", ["id", "source_id", "source_name", "stage", "message", "checked_at", "snapshot_json"], [id, safe.sourceId, safe.sourceName, safe.stage, safe.message, safe.checkedAt, JSON.stringify(safe.snapshot)]);
      } else {
        insert(kind, "plugin_manifests", ["plugin_id", "enabled", "manifest_json", "health_json", "updated_at"], [id, row.enabled ? 1 : 0, JSON.stringify(row.manifest), row.lastHealth ? JSON.stringify(row.lastHealth) : null, row.updatedAt]);
      }
    }
  }
  if (statements.length > 25_000) throw new Error("旧记录超过单次安全导入上限，请先分批整理备份；原始记录未改动。");
  return { statements, snapshot, preview: { categories, totalDetected: categories.reduce((sum, item) => sum + item.detected, 0), totalImportable: categories.reduce((sum, item) => sum + item.importable, 0), pausedTasks } };
}

/** Dependency-injected driver keeps tests on isolated in-memory SQLite only. */
export function createLegacyStorageMigrator(storage: LegacyStorage, driver: LegacyMigrationDriver) {
  const previews = new WeakMap<LegacyImportPreview, Map<string, string | null>>();
  return {
    async preview(): Promise<LegacyImportPreview> {
      await driver.initialize();
      const plan = planImport(storage, await driver.existing());
      previews.set(plan.preview, plan.snapshot);
      return plan.preview;
    },
    async import(preview: LegacyImportPreview): Promise<LegacyImportResult> {
      const snapshot = previews.get(preview);
      if (!snapshot || [...snapshot].some(([key, raw]) => storage.getItem(key) !== raw)) throw new Error("旧存储在预览后发生变化，请重新预览后导入。");
      const plan = planImport(storage, await driver.existing());
      const affected = plan.statements.length ? await driver.transaction(plan.statements.map(({ sql, values }) => ({ sql, values }))) : [];
      if (!Array.isArray(affected) || affected.length !== plan.statements.length || affected.some((count) => !Number.isInteger(count) || count < 0)) throw new Error("导入事务的回执格式不正确，请刷新后检查；旧存储始终保留。");
      let actualPaused = 0;
      for (const [index, statement] of plan.statements.entries()) if (statement.primary && affected[index] > 0) {
        plan.preview.categories.find((category) => category.kind === statement.kind)!.imported += 1;
        if (statement.paused) actualPaused += 1;
      }
      for (const category of plan.preview.categories) category.conflicts = category.valid - category.imported;
      // This marker records review only. Every original record key stays intact.
      try { storage.setItem(REVIEWED_KEY, fingerprint(plan.snapshot)); } catch { /* A full browser quota must not invalidate a committed import. */ }
      return { ...plan.preview, pausedTasks: actualPaused, totalImported: plan.preview.categories.reduce((sum, item) => sum + item.imported, 0) };
    },
  };
}

const nativeDriver: LegacyMigrationDriver = {
  async initialize() {
    if (!isTauriRuntime()) throw new Error("旧版记录导入只在桌面端提供；浏览器记录保持原样。");
    await Promise.all([createMediaLibraryRepository(), createSourceConfigRepository(), createResourceRepository(), createTaskRepository(), createLocalFileRepository(), createGameInstallRepository(), createOrganizationHistoryRepository(), createSourceDiagnosticRepository(), createPluginRepository()]);
  },
  async existing() {
    const db = await loadDatabase();
    const [media, externalIds, sources, resources, tasks, files, games, history, diagnostics, plugins] = await Promise.all([
      db.select<LegacyExistingRecords["media"]>("SELECT id FROM media"), db.select<LegacyExistingRecords["externalIds"]>("SELECT media_id, provider, external_id FROM external_ids"),
      db.select<LegacyExistingRecords["sources"]>("SELECT source_id FROM source_configs"), db.select<LegacyExistingRecords["resources"]>("SELECT id, source_id, source_item_id, target_url FROM resources"),
      db.select<LegacyExistingRecords["tasks"]>("SELECT id, dedupe_key FROM download_tasks"), db.select<LegacyExistingRecords["files"]>("SELECT id, path FROM local_files"),
      db.select<LegacyExistingRecords["games"]>("SELECT id, path FROM game_installs"), db.select<LegacyExistingRecords["history"]>("SELECT id FROM organization_history"),
      db.select<LegacyExistingRecords["diagnostics"]>("SELECT id FROM source_diagnostics"), db.select<LegacyExistingRecords["plugins"]>("SELECT plugin_id FROM plugin_manifests"),
    ]);
    return { media, externalIds, sources, resources, tasks, files, games, history, diagnostics, plugins };
  },
  transaction: (statements) => invoke<number[]>("database_transaction", { statements }),
};
let defaultMigrator: ReturnType<typeof createLegacyStorageMigrator> | undefined;
function migrator() { return defaultMigrator ??= createLegacyStorageMigrator(window.localStorage, nativeDriver); }
export function previewLegacyStorageImport(): Promise<LegacyImportPreview> { return migrator().preview(); }
export function importLegacyStorage(preview: LegacyImportPreview): Promise<LegacyImportResult> {
  return serializeDatabaseWrite(() => migrator().import(preview));
}
