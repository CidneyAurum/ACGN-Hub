import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneMetadata } from "@/infrastructure/metadata/clone-metadata";
import { MemoryCache } from "@/infrastructure/metadata/memory-cache";

afterEach(() => vi.unstubAllGlobals());

describe("legacy metadata cloning", () => {
  it("keeps native clone semantics for data outside the legacy JSON contract", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const graph: { date: Date; self?: unknown } = { date };
    graph.self = graph;
    const copied = cloneMetadata(graph);
    expect(copied).not.toBe(graph);
    expect(copied.self).toBe(copied);
    expect(copied.date).toBeInstanceOf(Date);
    expect(copied.date.getTime()).toBe(date.getTime());
  });

  it("clones nested JSON and optional undefined fields without mutation or prototype setters", () => {
    vi.stubGlobal("structuredClone", undefined);
    const input = JSON.parse('{"nested":{"items":[{"title":"original"}]},"__proto__":{"polluted":true}}');
    input.optional = undefined;
    input.nested.items.push(undefined);
    const copied = cloneMetadata(input);
    copied.nested.items[0].title = "changed";
    expect(input.nested.items[0].title).toBe("original");
    expect(Object.prototype.hasOwnProperty.call(copied, "optional")).toBe(true);
    expect(copied.optional).toBeUndefined();
    expect(copied.nested.items[1]).toBeUndefined();
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(copied, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(cloneMetadata(undefined)).toBeUndefined();
  });

  it("rejects unsupported legacy Date and circular graphs instead of changing their data", () => {
    vi.stubGlobal("structuredClone", undefined);
    expect(() => cloneMetadata(new Date())).toThrow("plain JSON objects");
    const graph: { self?: unknown } = {};
    graph.self = graph;
    expect(() => cloneMetadata(graph)).toThrow("Circular metadata");
  });

  it("protects coalesced and cached nested results in legacy WebViews and accepts undefined", async () => {
    vi.stubGlobal("structuredClone", undefined);
    const cache = new MemoryCache();
    const source = { aliases: ["original"], raw: { optional: undefined } };
    const load = vi.fn(async () => source);
    const [first, second] = await Promise.all([cache.getOrLoad("work", 10000, load), cache.getOrLoad("work", 10000, load)]);
    first.aliases.push("caller");
    source.aliases.push("source caller");
    expect(second.aliases).toEqual(["original"]);
    expect(cache.get<typeof source>("work")?.aliases).toEqual(["original"]);
    expect(cache.get<typeof source>("work")?.raw).toHaveProperty("optional", undefined);
    expect(load).toHaveBeenCalledOnce();
    cache.set("empty", undefined, 10000);
    expect(cache.get("empty")).toBeUndefined();
    await expect(cache.getOrLoad("empty", 10000, async () => undefined)).resolves.toBeUndefined();
  });
});
