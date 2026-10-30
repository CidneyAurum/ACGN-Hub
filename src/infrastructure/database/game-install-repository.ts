import { initializeStoredArray, readStoredArray, updateStoredArray, assertRecord } from "@/infrastructure/database/stored-array";
import type Database from "@tauri-apps/plugin-sql";
import { loadDatabase, initializeRepository, ensureColumns } from "@/infrastructure/database/repository-runtime";
import type { GameInstallRepository } from "@/application/game-ports";
import type { GameEngineKind, GameInstall } from "@/domain/game";

interface GameInstallRow {
  id: string;
  path: string;
  title: string;
  media_id: string | null;
  cover_url: string | null;
  engine: GameEngineKind;
  launch_path: string | null;
  detected_files_json: string;
  created_at: string;
  updated_at: string;
}

export class SqliteGameInstallRepository implements GameInstallRepository {
  private db?: Database;

  initialize(): Promise<void> {
    return initializeRepository(this, "游戏安装数据库", async () => {
      this.db = await loadDatabase();
      await this.getDb().execute(`
        CREATE TABLE IF NOT EXISTS game_installs (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          media_id TEXT,
          cover_url TEXT,
          engine TEXT NOT NULL,
          launch_path TEXT,
          detected_files_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      await this.addColumnIfMissing("media_id", "TEXT");
      await this.addColumnIfMissing("cover_url", "TEXT");
    });
  }

  async list(): Promise<GameInstall[]> {
    const rows = await this.getDb().select<GameInstallRow[]>("SELECT * FROM game_installs ORDER BY updated_at DESC");
    return rows.map(fromRow);
  }

  async upsert(install: GameInstall): Promise<void> {
    assertRecord(install, isGameInstall, "游戏安装");
    await this.getDb().execute(
      `INSERT INTO game_installs (id, path, title, media_id, cover_url, engine, launch_path, detected_files_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, title = excluded.title, media_id = excluded.media_id,
        cover_url = excluded.cover_url, engine = excluded.engine,
        launch_path = excluded.launch_path, detected_files_json = excluded.detected_files_json, updated_at = excluded.updated_at`,
      [install.id, install.path, install.title, install.mediaId ?? null, install.coverUrl ?? null, install.engine, install.launchPath ?? null, JSON.stringify(install.detectedFiles), install.createdAt, install.updatedAt],
    );
  }

  private async addColumnIfMissing(name: "media_id" | "cover_url", definition: string): Promise<void> {
    await ensureColumns(this.getDb(), "game_installs", { [name]: definition });
  }

  private getDb(): Database {
    if (!this.db) throw new Error("Galgame 安装记录数据库尚未初始化");
    return this.db;
  }
}

export interface GameInstallStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const GAME_INSTALL_KEY = "acgn-hub.game-installs.v1";

export class LocalStorageGameInstallRepository implements GameInstallRepository {
  constructor(private readonly storage: GameInstallStorageLike = window.localStorage) {}

  async initialize(): Promise<void> {
    initializeStoredArray(this.storage, GAME_INSTALL_KEY);
  }

  async list(): Promise<GameInstall[]> {
    return readStoredArray(this.storage, GAME_INSTALL_KEY, isGameInstall);
  }

  async upsert(install: GameInstall): Promise<void> {
    assertRecord(install, isGameInstall, "GameInstall");
    await updateStoredArray(this.storage, GAME_INSTALL_KEY, isGameInstall, (current) =>
      [install, ...current.filter((item) => item.id !== install.id)]);
  }
}

function fromRow(row: GameInstallRow): GameInstall {
  let detectedFiles: string[] = [];
  try {
    const parsed = JSON.parse(row.detected_files_json) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw new Error("文件列表不是字符串数组");
    detectedFiles = parsed;
  } catch (cause) {
    throw new Error("游戏安装记录包含损坏的文件列表，原始记录已保留", { cause });
  }
  const install = {
    id: row.id,
    path: row.path,
    title: row.title,
    ...(row.media_id ? { mediaId: row.media_id } : {}),
    ...(row.cover_url ? { coverUrl: row.cover_url } : {}),
    engine: row.engine,
    ...(row.launch_path ? { launchPath: row.launch_path } : {}),
    detectedFiles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  assertRecord(install, isGameInstall, "数据库游戏安装");
  return install;
}

function isGameInstall(value: unknown): value is GameInstall {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GameInstall>;
  return typeof item.id === "string" && typeof item.path === "string" && typeof item.title === "string" &&
    ["renpy", "kirikiri", "unity", "unknown"].includes(item.engine ?? "") && Array.isArray(item.detectedFiles) && item.detectedFiles.every((file) => typeof file === "string") &&
    (item.mediaId === undefined || typeof item.mediaId === "string") &&
    (item.coverUrl === undefined || typeof item.coverUrl === "string") &&
    typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}
