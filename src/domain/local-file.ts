export type LocalFileStatus = "present" | "missing" | "duplicate";

export interface LocalFile {
  id: string;
  path: string;
  sizeBytes: number;
  mediaId?: string;
  sha256?: string;
  status: LocalFileStatus;
  duplicateOf?: string;
  scannedAt: string;
}

export interface ScannedLocalFile {
  id: string;
  path: string;
  sizeBytes: number;
  sha256?: string;
  mediaId?: string;
}

export function reconcileLocalFiles(previous: LocalFile[], scanned: ScannedLocalFile[], scannedAt: string): LocalFile[] {
  const previousByPath = new Map(previous.map((file) => [file.path.toLowerCase(), file]));
  const next = scanned.map<LocalFile>((file) => {
    const old = previousByPath.get(file.path.toLowerCase());
    return {
      id: file.id,
      path: file.path,
      sizeBytes: file.sizeBytes,
      ...(file.mediaId || old?.mediaId ? { mediaId: file.mediaId ?? old?.mediaId } : {}),
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      status: "present",
      scannedAt,
    };
  });
  const scannedPaths = new Set(next.map((file) => file.path.toLowerCase()));
  for (const old of previous) {
    if (!scannedPaths.has(old.path.toLowerCase())) next.push({ ...old, status: "missing", scannedAt });
  }

  const byHash = new Map<string, LocalFile[]>();
  for (const file of next) {
    if (file.status !== "present" || !file.sha256) continue;
    const group = byHash.get(file.sha256) ?? [];
    group.push(file);
    byHash.set(file.sha256, group);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const canonical = group[0].path;
    for (const file of group) {
      file.status = "duplicate";
      if (file.path !== canonical) file.duplicateOf = canonical;
    }
  }
  return next;
}
