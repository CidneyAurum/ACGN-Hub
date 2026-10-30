import type { PluginManifest } from "@/domain/plugin";
import { assertPluginUrlAllowed } from "@/domain/plugin";
import type { JsonFetcher, JsonResponse } from "@/infrastructure/metadata/json-transport";

export interface PluginHttpClient {
  fetch(manifest: PluginManifest, url: string, init: RequestInit): Promise<JsonResponse>;
}

export class GuardedPluginHttpClient implements PluginHttpClient {
  constructor(private readonly fetcher: JsonFetcher) {}

  async fetch(manifest: PluginManifest, url: string, init: RequestInit): Promise<JsonResponse> {
    const allowed = assertPluginUrlAllowed(manifest, url);
    return this.fetcher(allowed.toString(), init);
  }
}
