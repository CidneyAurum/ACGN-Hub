import { RepositoryStorageError } from "./repository-runtime";

export interface ArrayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function initializeStoredArray(storage: ArrayStorage, key: string): void {
  // Empty or damaged text is existing data, not an uninitialized store.
  if (storage.getItem(key) === null) storage.setItem(key, "[]");
}

export function readStoredArray<T>(storage: ArrayStorage, key: string, valid: (item: unknown) => item is T, strict = false): T[] {
  let value: unknown;
  try {
    value = JSON.parse(storage.getItem(key) ?? "[]");
  } catch (cause) {
    throw new RepositoryStorageError(`本地存储 ${key} 无法解析，原始数据已保留。请先导出或修复该数据。`, cause);
  }
  if (!Array.isArray(value)) throw new RepositoryStorageError(`本地存储 ${key} 不是记录列表，原始数据已保留。`);
  const records = value.filter(valid);
  if (strict && records.length !== value.length) {
    throw new RepositoryStorageError(`本地存储 ${key} 含无效记录，本次写入已停止以保留原始数据。`);
  }
  return records;
}

const pendingWrites = new WeakMap<object, Map<string, Promise<unknown>>>();

export function updateStoredArray<T>(
  storage: ArrayStorage, key: string, valid: (item: unknown) => item is T,
  update: (records: T[]) => T[],
): Promise<void> {
  const queues = pendingWrites.get(storage) ?? new Map<string, Promise<unknown>>();
  pendingWrites.set(storage, queues);
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => {
    const records = update(readStoredArray(storage, key, valid, true));
    if (!records.every(valid)) throw new RepositoryStorageError(`拒绝写入无效记录：${key}`);
    // Quota and access errors propagate; setItem is atomic and the old value survives.
    storage.setItem(key, JSON.stringify(records));
  });
  queues.set(key, result);
  const cleanup = () => { if (queues.get(key) === result) queues.delete(key); };
  void result.then(cleanup, cleanup);
  return result;
}

export function assertRecord<T>(value: unknown, valid: (item: unknown) => item is T, label: string): asserts value is T {
  if (!valid(value)) throw new RepositoryStorageError(`${label}记录无效，未写入存储。`);
}
