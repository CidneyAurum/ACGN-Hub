import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createLegacyStorageMigrator, detectLegacyStorageImport, LEGACY_STORAGE_KEYS, type LegacyExistingRecords, type LegacyMigrationDriver, type LegacyStorage } from "@/infrastructure/database/legacy-storage-migration";

const date = "2026-10-29T08:00:00.000Z";
const media = { id: "bangumi:7", type: "anime", title: "测试'); DROP TABLE media; --", aliases: ["Test"], externalIds: [{ provider: "bangumi", value: "7" }], metadata: { score: 8 }, releaseYear: 2026 };
const source = { id: "source-1", type: "rss", name: "来源", url: "https://example.com/feed", enabled: false, token: "fixture-token", createdAt: date, updatedAt: date };
const resource = { id: "resource-1", sourceId: "rss:example", sourceItemId: "entry-1", mediaId: media.id, title: "第1集", protocol: "magnet", targetUrl: "magnet:?xt=urn:btih:fixture", episode: 1, resolution: "1080p", language: "中文", metadata: { group: "Test" }, createdAt: date };
const task = { id: "task-1", engineId: "qbittorrent", engineTaskId: "old-remote-id", mediaId: media.id, resourceId: resource.id, sourceUrl: resource.targetUrl, protocol: "magnet", directory: "C:\\Incoming", state: "downloading", totalBytes: 100, completedBytes: 40, speedBytesPerSecond: 10, files: ["C:\\Incoming\\episode.mkv"], dedupeKey: "magnet:fixture", createdAt: date, updatedAt: date };

describe("legacy storage migration on isolated SQLite", () => {
  let db: DatabaseSync;
  let values: Map<string, string>;
  let storage: LegacyStorage;
  let driver: LegacyMigrationDriver;
  let transactionCalls: number;
  let failAtResource: boolean;
  let beforeTransaction: (() => void) | undefined;
  const all = <T>(sql: string): T => db.prepare(sql).all() as unknown as T;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE media (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, original_title TEXT, aliases_json TEXT, cover_url TEXT, description TEXT, release_year INTEGER, metadata_json TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE external_ids (media_id TEXT REFERENCES media(id), provider TEXT, external_id TEXT, PRIMARY KEY(provider, external_id));
      CREATE TABLE source_configs (source_id TEXT PRIMARY KEY, enabled INTEGER, config_json TEXT, updated_at TEXT);
      CREATE TABLE source_items (id TEXT PRIMARY KEY, source_id TEXT, source_item_id TEXT, media_id TEXT, title TEXT, raw_json TEXT, UNIQUE(source_id, source_item_id));
      CREATE TABLE resources (id TEXT PRIMARY KEY, source_id TEXT, source_item_id TEXT, media_id TEXT REFERENCES media(id), title TEXT, protocol TEXT, target_url TEXT, metadata_json TEXT, details_json TEXT, created_at TEXT, UNIQUE(source_id, source_item_id, target_url));
      CREATE TABLE download_tasks (id TEXT PRIMARY KEY, engine_id TEXT, engine_endpoint TEXT, engine_task_id TEXT, media_id TEXT REFERENCES media(id), resource_id TEXT REFERENCES resources(id), source_name TEXT, source_url TEXT, protocol TEXT, directory TEXT, filename TEXT, state TEXT, total_bytes INTEGER, completed_bytes INTEGER, speed_bytes_per_second INTEGER, connections INTEGER, seeders INTEGER, error_code TEXT, files_json TEXT, temp_path TEXT, final_path TEXT, error TEXT, dedupe_key TEXT UNIQUE, created_at TEXT, updated_at TEXT, diagnostics_json TEXT NOT NULL DEFAULT '{}', naming_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE local_files (id TEXT PRIMARY KEY, media_id TEXT, path TEXT UNIQUE, size_bytes INTEGER, sha256 TEXT, status TEXT, duplicate_of TEXT, created_at TEXT, scanned_at TEXT);
      CREATE TABLE game_installs (id TEXT PRIMARY KEY, path TEXT UNIQUE, title TEXT, media_id TEXT, cover_url TEXT, engine TEXT, launch_path TEXT, detected_files_json TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE organization_history (id TEXT PRIMARY KEY, task_id TEXT, media_id TEXT, source_path TEXT, destination_path TEXT, status TEXT, error TEXT, created_at TEXT);
      CREATE TABLE source_diagnostics (id TEXT PRIMARY KEY, source_id TEXT, source_name TEXT, stage TEXT, message TEXT, checked_at TEXT, snapshot_json TEXT);
      CREATE TABLE plugin_manifests (plugin_id TEXT PRIMARY KEY, enabled INTEGER, manifest_json TEXT, health_json TEXT, updated_at TEXT)`);
    values = new Map();
    storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
    transactionCalls = 0;
    failAtResource = false;
    beforeTransaction = undefined;
    driver = {
      initialize: async () => undefined,
      existing: async () => ({
        media: all("SELECT id FROM media"), externalIds: all("SELECT media_id, provider, external_id FROM external_ids"), sources: all("SELECT source_id FROM source_configs"), resources: all("SELECT id, source_id, source_item_id, target_url FROM resources"), tasks: all("SELECT id, dedupe_key FROM download_tasks"), files: all("SELECT id, path FROM local_files"), games: all("SELECT id, path FROM game_installs"), history: all("SELECT id FROM organization_history"), diagnostics: all("SELECT id FROM source_diagnostics"), plugins: all("SELECT plugin_id FROM plugin_manifests"),
      } satisfies LegacyExistingRecords),
      transaction: async (statements) => {
        transactionCalls += 1;
        beforeTransaction?.();
        db.exec("BEGIN");
        try {
          const counts = statements.map((statement) => {
            if (failAtResource && statement.sql.startsWith("INSERT INTO resources")) throw new Error("injected write failure");
            return Number(db.prepare(statement.sql).run(...statement.values as SQLInputValue[]).changes);
          });
          db.exec("COMMIT"); return counts;
        } catch (cause) { db.exec("ROLLBACK"); throw cause; }
      },
    };
  });
  afterEach(() => db.close());

  function storeCoreRecords(): Map<string, string> {
    storage.setItem(LEGACY_STORAGE_KEYS.media, JSON.stringify([media]));
    storage.setItem(LEGACY_STORAGE_KEYS.sources, JSON.stringify([source]));
    storage.setItem(LEGACY_STORAGE_KEYS.resources, JSON.stringify([resource]));
    storage.setItem(LEGACY_STORAGE_KEYS.tasks, JSON.stringify([task]));
    return new Map(values);
  }

  it("previews without writes, then imports all core records once and preserves every original key", async () => {
    const originals = storeCoreRecords();
    const migrator = createLegacyStorageMigrator(storage, driver);
    const preview = await migrator.preview();
    expect(preview.totalImportable).toBe(4);
    expect(preview.pausedTasks).toBe(1);
    expect(transactionCalls).toBe(0);
    expect(all("SELECT * FROM media")).toEqual([]);
    const result = await migrator.import(preview);
    expect(result.totalImported).toBe(4);
    expect(transactionCalls).toBe(1);
    expect(all<Array<{ title: string }>>("SELECT title FROM media")[0].title).toBe(media.title);
    expect(all<Array<{ state: string; engine_task_id: string | null; completed_bytes: number; files_json: string }>>("SELECT state, engine_task_id, completed_bytes, files_json FROM download_tasks")[0]).toEqual({ state: "paused", engine_task_id: null, completed_bytes: 40, files_json: JSON.stringify(task.files) });
    expect(JSON.parse(all<Array<{ details_json: string }>>("SELECT details_json FROM resources")[0].details_json)).toMatchObject({ episode: 1, resolution: "1080p", language: "中文" });
    for (const [key, raw] of originals) expect(storage.getItem(key)).toBe(raw);
    expect(detectLegacyStorageImport(storage)).toBe(false);
    const again = await migrator.import(await migrator.preview());
    expect(again.totalImported).toBe(0);
    expect(again.categories.reduce((sum, item) => sum + item.conflicts, 0)).toBe(4);
  });

  it("skips an entire media record when an external ID belongs to another work", async () => {
    storage.setItem(LEGACY_STORAGE_KEYS.media, JSON.stringify([media]));
    db.prepare("INSERT INTO media (id, type, title) VALUES (?, ?, ?)").run("existing", "anime", "原有作品");
    db.prepare("INSERT INTO external_ids VALUES (?, ?, ?)").run("existing", "bangumi", "7");
    const migrator = createLegacyStorageMigrator(storage, driver);
    const preview = await migrator.preview();
    expect(preview.categories[0]).toMatchObject({ valid: 1, conflicts: 1, importable: 0 });
    expect((await migrator.import(preview)).totalImported).toBe(0);
    expect(all("SELECT media_id FROM external_ids")).toEqual([{ media_id: "existing" }]);
    expect(all("SELECT id FROM media")).toEqual([{ id: "existing" }]);
  });

  it("rechecks external-ID conflicts inside the transaction and reports actual inserted counts", async () => {
    storage.setItem(LEGACY_STORAGE_KEYS.media, JSON.stringify([media]));
    const migrator = createLegacyStorageMigrator(storage, driver);
    const preview = await migrator.preview();
    beforeTransaction = () => {
      db.prepare("INSERT INTO media (id, type, title) VALUES (?, ?, ?)").run("concurrent", "anime", "并发作品");
      db.prepare("INSERT INTO external_ids VALUES (?, ?, ?)").run("concurrent", "bangumi", "7");
    };
    const result = await migrator.import(preview);
    expect(result.totalImported).toBe(0);
    expect(result.categories[0].conflicts).toBe(1);
    expect(all("SELECT id FROM media")).toEqual([{ id: "concurrent" }]);
    expect(all("SELECT media_id FROM external_ids")).toEqual([{ media_id: "concurrent" }]);
  });

  it("rolls back earlier media and source writes if a later resource write fails", async () => {
    const originals = storeCoreRecords();
    const migrator = createLegacyStorageMigrator(storage, driver);
    const preview = await migrator.preview();
    failAtResource = true;
    await expect(migrator.import(preview)).rejects.toThrow("injected write failure");
    expect(all("SELECT id FROM media")).toEqual([]);
    expect(all("SELECT source_id FROM source_configs")).toEqual([]);
    expect(all("SELECT media_id FROM external_ids")).toEqual([]);
    expect(values).toEqual(originals);
  });

  it("keeps malformed records and rejects a source snapshot that changes after preview", async () => {
    storage.setItem(LEGACY_STORAGE_KEYS.media, "broken JSON");
    storage.setItem(LEGACY_STORAGE_KEYS.tasks, JSON.stringify([task, { id: "invalid" }]));
    const migrator = createLegacyStorageMigrator(storage, driver);
    const preview = await migrator.preview();
    expect(preview.categories.find((item) => item.kind === "media")?.invalid).toBe(1);
    expect(preview.categories.find((item) => item.kind === "tasks")).toMatchObject({ valid: 1, invalid: 1 });
    storage.setItem(LEGACY_STORAGE_KEYS.tasks, "[]");
    await expect(migrator.import(preview)).rejects.toThrow("预览后发生变化");
    expect(transactionCalls).toBe(0);
    expect(storage.getItem(LEGACY_STORAGE_KEYS.media)).toBe("broken JSON");
  });

  it("preserves file hashes, game launch data, history, diagnostics and plugin manifests", async () => {
    const manifest = { apiVersion: 1, id: "test-source", name: "Test", version: "1.0.0", kind: "source", entry: "index.js", permissions: { domains: ["example.com"] }, config: {} };
    storage.setItem(LEGACY_STORAGE_KEYS.files, JSON.stringify([{ id: "file", path: "C:\\Library\\file.mkv", sizeBytes: 42, sha256: "abc", status: "duplicate", duplicateOf: "other", scannedAt: date }]));
    storage.setItem(LEGACY_STORAGE_KEYS.games, JSON.stringify([{ id: "game", title: "游戏", path: "C:\\Games\\Test", engine: "renpy", detectedFiles: ["renpy"], launchPath: "game.exe", createdAt: date, updatedAt: date }]));
    storage.setItem(LEGACY_STORAGE_KEYS.history, JSON.stringify([{ id: "history", taskId: "task", mediaId: "work", sourcePath: "C:\\Incoming\\file", destinationPath: "C:\\Library\\file", status: "moved", createdAt: date }]));
    storage.setItem(LEGACY_STORAGE_KEYS.diagnostics, JSON.stringify([{ id: "diagnostic", sourceId: "source", sourceName: "来源", stage: "health", message: "HTTP 503", checkedAt: date, snapshot: { sourceType: "rss" } }]));
    storage.setItem(LEGACY_STORAGE_KEYS.plugins, JSON.stringify([{ manifest, enabled: false, updatedAt: date }]));
    const migrator = createLegacyStorageMigrator(storage, driver);
    expect((await migrator.import(await migrator.preview())).totalImported).toBe(5);
    expect(all("SELECT sha256, status, duplicate_of FROM local_files")).toEqual([{ sha256: "abc", status: "duplicate", duplicate_of: "other" }]);
    expect(all("SELECT launch_path, detected_files_json FROM game_installs")).toEqual([{ launch_path: "game.exe", detected_files_json: '["renpy"]' }]);
    expect(JSON.parse(all<Array<{ manifest_json: string }>>("SELECT manifest_json FROM plugin_manifests")[0].manifest_json)).toEqual(manifest);
  });

  it("never reimports retired source configs while preserving their media, resources, completed downloads and original storage", async () => {
    const sources = [source,
      { ...source, id: "retired-weeb", type: "weebcentral", enabled: true },
      { ...source, id: "retired-kuaikan", type: "kuaikan", enabled: true }];
    const retiredResource = { ...resource, sourceId: "weebcentral:https://weebcentral.com", protocol: "http", targetUrl: "https://weebcentral.com/chapters/saved", format: "CBZ" };
    const completed = { ...task, engineId: "aria2", state: "completed", protocol: "http", sourceUrl: retiredResource.targetUrl, files: ["D:\\Library\\existing.cbz"], totalBytes: 42, completedBytes: 42, speedBytesPerSecond: 0 };
    storage.setItem(LEGACY_STORAGE_KEYS.sources, JSON.stringify(sources));
    storage.setItem(LEGACY_STORAGE_KEYS.media, JSON.stringify([media]));
    storage.setItem(LEGACY_STORAGE_KEYS.resources, JSON.stringify([retiredResource]));
    storage.setItem(LEGACY_STORAGE_KEYS.tasks, JSON.stringify([completed]));
    storage.setItem(LEGACY_STORAGE_KEYS.files, JSON.stringify([{ id: "file", path: "D:\\Library\\existing.cbz", sizeBytes: 42, status: "present", scannedAt: date }]));
    const originals = new Map(values);
    const migrator = createLegacyStorageMigrator(storage, driver);
    const preview = await migrator.preview();
    const sourcePreview = preview.categories.find((item) => item.kind === "sources")!;
    expect(sourcePreview).toMatchObject({ detected: 3, valid: 1, invalid: 2, importable: 1 });
    expect(sourcePreview.issues.join(" ")).toContain("来源已撤下");
    const result = await migrator.import(preview);
    expect(result.totalImported).toBe(5);
    expect(all("SELECT source_id FROM source_configs")).toEqual([{ source_id: source.id }]);
    expect(JSON.parse(all<Array<{ config_json: string }>>("SELECT config_json FROM source_configs")[0].config_json)).toEqual(source);
    expect(all("SELECT id FROM media")).toEqual([{ id: media.id }]);
    expect(all("SELECT id, source_id FROM resources")).toEqual([{ id: resource.id, source_id: retiredResource.sourceId }]);
    expect(all("SELECT state, files_json FROM download_tasks")).toEqual([{ state: "completed", files_json: JSON.stringify(completed.files) }]);
    expect(all("SELECT path FROM local_files")).toEqual([{ path: "D:\\Library\\existing.cbz" }]);
    for (const [key, raw] of originals) expect(storage.getItem(key)).toBe(raw);
  });
});
