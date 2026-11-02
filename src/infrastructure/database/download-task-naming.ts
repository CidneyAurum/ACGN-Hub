import type { DownloadNaming } from "@/domain/download";

export function readDownloadNaming(raw: string | null | undefined): DownloadNaming | undefined {
  let value: unknown;
  try { value = JSON.parse(raw ?? "{}"); }
  catch (cause) { throw new Error("下载任务的命名记录已损坏，原始记录已保留", { cause }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("下载任务的命名记录格式无效，原始记录已保留");
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).length) return undefined;
  const result = Object.fromEntries(["status", "originalFileName", "originalPath", "currentFileName", "renamedAt", "message"]
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key)).map((key) => [key, record[key]]));
  // Task validation checks the field types. Unknown JSON keys never override paths or task identity.
  return result as unknown as DownloadNaming;
}
