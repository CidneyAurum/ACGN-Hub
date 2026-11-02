import type { DownloadTask } from "@/domain/download";

const fields = ["stage", "peers", "infoHash", "verifiedBytes", "verifyIntegrityPending"] as const;
type DownloadDiagnostics = Partial<Pick<DownloadTask, typeof fields[number]>>;

export function serializeDownloadDiagnostics(task: DownloadDiagnostics): string {
  return JSON.stringify(Object.fromEntries(fields.filter((key) => task[key] !== undefined).map((key) => [key, task[key]])));
}

/** Copy only diagnostic fields; stored JSON must never override task identity or paths. */
export function readDownloadDiagnostics(raw: string | null | undefined): DownloadDiagnostics {
  let value: unknown;
  try { value = JSON.parse(raw ?? "{}"); }
  catch (cause) { throw new Error("下载任务的连接诊断已损坏，原始记录已保留", { cause }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("下载任务的连接诊断格式无效，原始记录已保留");
  const record = value as Record<string, unknown>;
  return Object.fromEntries(fields.filter((key) => Object.prototype.hasOwnProperty.call(record, key)).map((key) => [key, record[key]])) as DownloadDiagnostics;
}
