import { cloneMetadata } from "./clone-metadata";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private generation = 0;

  constructor(private readonly maxEntries = 256) {}

  get<T>(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return cloneMetadata(entry.value) as T;
  }

  set<T>(key: string, value: T, ttlMs: number, now = Date.now()): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || this.maxEntries <= 0) return;
    for (const [cachedKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(cachedKey);
    }
    this.entries.delete(key);
    this.entries.set(key, { value: cloneMetadata(value), expiresAt: now + ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    let pending = this.pending.get(key) as Promise<T> | undefined;
    if (!pending) {
      const generation = this.generation;
      pending = Promise.resolve().then(load).then((value) => {
        if (generation === this.generation) this.set(key, value, ttlMs);
        return value;
      });
      this.pending.set(key, pending);
      const completed = () => { if (this.pending.get(key) === pending) this.pending.delete(key); };
      void pending.then(completed, completed);
    }
    return cloneMetadata(await pending);
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.generation += 1;
  }
}
