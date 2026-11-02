/** Recognized only to retire old saved configurations safely; never offer as active sources. */
export type RetiredSourceConfigType = "weebcentral" | "kuaikan";
export const SOURCE_CONFIG_TYPES = ["rss", "github_release", "kungal", "shinnku", "shionlib", "vndb_release", "itch_freeware", "copymanga", "jmcomic", "mangadex", "mangabz", "archive", "lnovel", "wenku8_epub", "public_video", "weebcentral", "kuaikan"] as const;
export type SourceConfigType = (typeof SOURCE_CONFIG_TYPES)[number];

export function isSourceConfigType(value: unknown): value is SourceConfigType {
  return typeof value === "string" && (SOURCE_CONFIG_TYPES as readonly string[]).includes(value);
}

export function isRetiredSourceType(value: unknown): value is RetiredSourceConfigType {
  return value === "weebcentral" || value === "kuaikan";
}

export interface SourceConfig {
  id: string;
  type: SourceConfigType;
  name: string;
  url: string;
  token?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastHealth?: {
    ok: boolean;
    checkedAt: string;
    message?: string;
  };
}
