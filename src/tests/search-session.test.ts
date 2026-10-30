import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { SearchCandidate } from "@/application/metadata-ports";
import { useSearchSessionStore } from "@/stores/search-session";

const ENTRY_KEY = "acgn-hub.search-session.v1";
const VIEW_KEY = "acgn-hub.search-view.v1";
const NOW = Date.UTC(2026, 9, 30, 12);
let values: Map<string, string>;

function candidate(id = "bangumi:123"): SearchCandidate {
  return { media: { id, type: "manga", title: "葬送的芙莉莲", aliases: ["Frieren"], externalIds: [{ provider: "bangumi", value: "123" }], metadata: {} }, score: 100, reason: "exact" };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  setActivePinia(createPinia());
  values = new Map();
  vi.stubGlobal("window", { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("search session recovery", () => {
  it("ignores broken candidate records without losing usable detail links", () => {
    const valid = candidate();
    const stored = JSON.stringify({ good: { ...valid, storedAt: NOW }, missing: { storedAt: NOW },
      brokenMedia: { media: { id: "broken", aliases: null }, score: 10, reason: "exact", storedAt: NOW },
      brokenReason: { ...candidate("bad-reason"), reason: { toString: "exact" }, storedAt: NOW }, nullItem: null });
    values.set(ENTRY_KEY, stored);
    const session = useSearchSessionStore();
    expect(session.find(valid.media.id)).toEqual(valid);
    expect(session.find("broken")).toBeUndefined();
    expect(session.find("toString")).toBeUndefined();
    expect(values.get(ENTRY_KEY)).toBe(stored);
  });

  it("filters invalid restored search items while preserving the valid result and query", () => {
    const valid = candidate();
    values.set(VIEW_KEY, JSON.stringify({ keyword: "芙莉莲", type: "manga", storedAt: NOW, candidates: [
      null, { media: {} }, { ...valid, score: "100" }, { ...valid, reason: "unknown" },
      { ...valid, media: { ...valid.media, aliases: [1] } }, { ...valid, media: { ...valid.media, type: "anime" } }, valid,
    ] }));
    expect(useSearchSessionStore().restoreSearch()).toEqual({ keyword: "芙莉莲", type: "manga", candidates: [valid] });
  });

  it.each(["null", "[]", '"text"', "{broken"])("treats invalid entry containers %s as an empty cache", (stored) => {
    values.set(ENTRY_KEY, stored);
    expect(useSearchSessionStore().find("anything")).toBeUndefined();
  });

  it("reads each cache independently when the other JSON is broken", () => {
    values.set(ENTRY_KEY, "{broken");
    values.set(VIEW_KEY, JSON.stringify({ keyword: "芙莉莲", type: "manga", candidates: [candidate()], storedAt: NOW }));
    expect(useSearchSessionStore().restoreSearch()?.candidates).toEqual([candidate()]);
    setActivePinia(createPinia());
    values.set(ENTRY_KEY, JSON.stringify({ good: { ...candidate(), storedAt: NOW } }));
    values.set(VIEW_KEY, "{broken");
    expect(useSearchSessionStore().find(candidate().media.id)).toEqual(candidate());
  });

  it("rejects expired, invalid and far-future timestamps but tolerates a small clock adjustment", () => {
    const times = { expired: NOW - 30 * 60_000 - 1, invalid: "2026-10-30", nullTime: null, negative: -1,
      future: NOW + 60_001, skew: NOW + 30_000, boundary: NOW - 30 * 60_000 };
    values.set(ENTRY_KEY, JSON.stringify(Object.fromEntries(Object.entries(times).map(([id, storedAt]) => [id, { ...candidate(id), storedAt }]))));
    const session = useSearchSessionStore();
    for (const id of ["expired", "invalid", "nullTime", "negative", "future"]) expect(session.find(id)).toBeUndefined();
    expect(session.find("skew")?.media.id).toBe("skew");
    expect(session.find("boundary")?.media.id).toBe("boundary");
    vi.advanceTimersByTime(1);
    expect(session.find("boundary")).toBeUndefined();
  });

  it.each([NOW - 30 * 60_000 - 1, NOW + 60_001, null, "yesterday"])("does not restore a search view with timestamp %s", (storedAt) => {
    values.set(VIEW_KEY, JSON.stringify({ keyword: "芙莉莲", type: "manga", candidates: [candidate()], storedAt }));
    expect(useSearchSessionStore().restoreSearch()).toBeUndefined();
  });

  it("keeps remembered results until the session TTL elapses and clear removes only the view", () => {
    const session = useSearchSessionStore();
    session.rememberSearch(" 芙莉莲 ", "manga", [candidate()]);
    expect(session.restoreSearch()?.keyword).toBe("芙莉莲");
    session.clearSearch();
    expect(session.restoreSearch()).toBeUndefined();
    expect(session.find(candidate().media.id)).toEqual(candidate());
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(session.find(candidate().media.id)).toBeUndefined();
  });
});
