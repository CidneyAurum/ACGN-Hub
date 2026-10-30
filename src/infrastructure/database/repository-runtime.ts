import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/shared/runtime";

export class RepositoryStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RepositoryStorageError";
  }
}

function storageFailureHint(cause: unknown): string {
  const messages: string[] = [];
  let current = cause;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    messages.push(current instanceof Error ? current.message : typeof current === "string" ? current : "");
    current = current instanceof Error ? current.cause : undefined;
  }
  const message = messages.join(" ");
  if (/locked|SQLITE_BUSY|database is busy|被占用/i.test(message)) return "数据库被其他进程占用，请稍后重试。";
  if (/readonly|read.only|permission denied|access denied|拒绝访问/i.test(message)) return "数据库目录不可写，请检查访问权限。";
  if (/disk.*full|no space|空间不足/i.test(message)) return "磁盘空间不足，请释放空间后重试。";
  if (/malformed|corrupt|not a database|已损坏/i.test(message)) return "数据库或记录已损坏，请保留原件并从备份恢复。";
  if (/no such (?:column|table)|duplicate column|schema/i.test(message)) return "数据库结构不兼容，请保留备份后检查迁移。";
  if (/constraint|unique|foreign key/i.test(message)) return "记录存在冲突，事务已停止。";
  return "请检查应用数据目录权限、磁盘空间及数据库占用情况。";
}

let databasePromise: Promise<Database> | undefined;

/** Share a single pool; a failed open may be retried without changing storage. */
export function loadDatabase(): Promise<Database> {
  if (!databasePromise) {
    databasePromise = invoke<string>("get_database_url").then((url) => Database.load(url)).catch((cause) => {
      databasePromise = undefined;
      throw new RepositoryStorageError(`无法打开 acgn-hub.db。${storageFailureHint(cause)}原有数据库保持不变。`, cause);
    });
  }
  return databasePromise;
}

const initializations = new WeakMap<object, Promise<void>>();
let initializationTail: Promise<unknown> = Promise.resolve();

export function initializeRepository(owner: object, label: string, initialize: () => Promise<void>): Promise<void> {
  const existing = initializations.get(owner);
  if (existing) return existing;
  const pending = initializationTail.catch(() => undefined).then(initialize).catch((cause) => {
    initializations.delete(owner);
    throw new RepositoryStorageError(`${label}初始化失败（acgn-hub.db）。${storageFailureHint(cause)}未切换存储。`, cause);
  });
  initializationTail = pending;
  initializations.set(owner, pending);
  return pending;
}

const repositories = new Map<string, Promise<unknown>>();

export function createRepository<T extends { initialize(): Promise<void> }>(
  name: string, desktop: () => T, browser: () => T,
): Promise<T> {
  const key = `${isTauriRuntime() ? "desktop" : "browser"}:${name}`;
  const existing = repositories.get(key);
  if (existing) return existing as Promise<T>;
  const pending = Promise.resolve().then(async () => {
    const repository = isTauriRuntime() ? desktop() : browser();
    await repository.initialize();
    return repository;
  }).catch((cause) => {
    repositories.delete(key);
    throw cause;
  });
  repositories.set(key, pending);
  return pending;
}

export interface SqlStatement {
  sql: string;
  values: unknown[];
}

/** The native command executes all statements on one connection and rolls back on failure. */
export async function executeTransaction(statements: SqlStatement[]): Promise<void> {
  if (!statements.length) return;
  try {
    await invoke("database_transaction", { statements });
  } catch (cause) {
    throw new RepositoryStorageError(`数据库事务未完成，已回滚本次更改。${storageFailureHint(cause)}`, cause);
  }
}

let writeTail: Promise<unknown> = Promise.resolve();

/** Keep a scan's read/reconcile/write together with other local mutations. */
export function serializeDatabaseWrite<T>(action: () => Promise<T>): Promise<T> {
  const result = writeTail.then(action);
  writeTail = result.catch(() => undefined);
  return result;
}

export async function ensureColumns(db: Database, table: string, definitions: Record<string, string>): Promise<void> {
  if (!/^[a-z_]+$/.test(table) || Object.keys(definitions).some((name) => !/^[a-z_]+$/.test(name))) {
    throw new Error("非法数据库迁移标识符");
  }
  const columns = await db.select<Array<{ name: string }>>(`PRAGMA table_info(${table})`);
  const names = new Set(columns.map((column) => column.name));
  for (const [name, definition] of Object.entries(definitions)) {
    if (!names.has(name)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
