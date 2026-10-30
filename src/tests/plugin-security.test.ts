import { describe, expect, it, vi } from "vitest";
import { assertPluginUrlAllowed, validatePluginConfiguration, validatePluginManifest, type PluginManifest } from "@/domain/plugin";
import { GuardedPluginHttpClient } from "@/infrastructure/plugins/guarded-plugin-http-client";
import { LocalStoragePluginRepository, type PluginStorageLike } from "@/infrastructure/plugins/plugin-repository";

const manifest: PluginManifest = {
  apiVersion: 1,
  id: "example-source",
  name: "Example Source",
  version: "1.0.0",
  kind: "source",
  entry: "index.js",
  permissions: { domains: ["example.com", "*.github.com"] },
  config: { token: { type: "string", required: true } },
};

class MemoryStorage implements PluginStorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("plugin manifest and domain guard", () => {
  it("rejects malformed manifests and private permissions", () => {
    expect(() => validatePluginManifest({ ...manifest, entry: "../index.js" })).toThrow();
    expect(() => validatePluginManifest({ ...manifest, permissions: { domains: ["127.0.0.1"] } })).toThrow();
  });

  it("allows declared domains and rejects undeclared or private URLs", () => {
    expect(assertPluginUrlAllowed(manifest, "https://example.com/feed").hostname).toBe("example.com");
    expect(assertPluginUrlAllowed(manifest, "https://api.github.com/releases").hostname).toBe("api.github.com");
    expect(() => assertPluginUrlAllowed(manifest, "https://other.example.net/feed")).toThrow("未声明域名");
    expect(() => assertPluginUrlAllowed(manifest, "http://127.0.0.1:1420/feed")).toThrow("私有网络");
    expect(() => assertPluginUrlAllowed(manifest, "https://user:pass@example.com/feed")).toThrow("认证");
  });

  it("validates declared plugin configuration and guards the HTTP client", async () => {
    expect(validatePluginConfiguration(manifest, { token: "session" })).toEqual({ token: "session" });
    expect(() => validatePluginConfiguration(manifest, {})).toThrow("缺少");
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
    const client = new GuardedPluginHttpClient(fetcher);
    await client.fetch(manifest, "https://example.com/data", { method: "GET" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.fetch(manifest, "https://not-allowed.example/data", { method: "GET" })).rejects.toThrow("未声明域名");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores a damaged stored plugin instead of breaking the registry", async () => {
    const storage = new MemoryStorage();
    const repository = new LocalStoragePluginRepository(storage);
    await repository.initialize();
    storage.setItem("acgn-hub.plugins.v1", JSON.stringify([{ manifest: { id: "broken" }, enabled: true }]));
    await expect(repository.list()).resolves.toEqual([]);
  });
});
