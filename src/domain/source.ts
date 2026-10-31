/** Recognized only to retire old saved configurations safely; never offer as active sources. */
export type RetiredSourceConfigType = "weebcentral" | "kuaikan";
export type SourceConfigType = "rss" | "github_release" | "kungal" | "shinnku" | "shionlib" | "vndb_release" | "copymanga" | "jmcomic" | "mangadex" | "mangabz" | "archive" | "lnovel" | "public_video" | RetiredSourceConfigType;

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
