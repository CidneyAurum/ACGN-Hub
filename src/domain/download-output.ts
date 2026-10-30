import type { DownloadTask } from "./download";

export interface DownloadOutput {
  path: string;
  allowedRoot: string;
  label: string;
}

const SUPPORTED = /\.(?:mp4|mkv|webm|m4v|mov|avi|ts|cbz|txt|epub|pdf)$/i;

interface ComparablePath { value: string; windows: boolean }
/** Lexical filtering for UI choices only; the native opener checks the real file. */
function comparablePath(path: string): ComparablePath | undefined {
  const value = path.trim();
  if (!value || /[\u0000-\u001f]/.test(value)) return;
  if (value.split(/[\\/]/).some((part) => part === "." || part === "..")) return;
  // Native canonicalization may yield this DOS spelling; never accept device paths.
  const dos = value.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
  if (/^[A-Za-z]:[\\/]/.test(dos)) {
    if (/[<>:"|?*]/.test(dos.slice(2))) return;
    return { value: dos.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase(), windows: true };
  }
  if (/^\\\\[^\\/?]+[\\/][^\\/?]+/.test(dos)) {
    if (/[<>:"|?*]/.test(dos)) return;
    return { value: dos.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase(), windows: true };
  }
  if (value.startsWith("/") && !value.startsWith("//")) return { value: value.replace(/\/+$/, "") || "/", windows: false };
  return;
}

function output(path: string, roots: readonly string[]): DownloadOutput | undefined {
  if (!SUPPORTED.test(path.trim())) return;
  const candidate = comparablePath(path);
  if (!candidate) return;
  const root = roots.find((value) => {
    const checked = comparablePath(value);
    if (!checked || checked.windows !== candidate.windows || candidate.value === checked.value) return false;
    return candidate.value.startsWith(checked.value === "/" ? "/" : checked.value + "/");
  });
  if (!root) return;
  return { path: path.trim(), allowedRoot: root.trim(), label: path.trim().split(/[\\/]/).pop()! };
}

/**
 * Completed engine tasks may expose only their registered files. Once organized,
 * finalPath replaces old engine paths and must stay within an explicit setting
 * root; an arbitrary parent directory is never promoted to an allowed root.
 */
export function getCompletedDownloadOutputs(task: DownloadTask, configuredRoots: readonly string[] = []): DownloadOutput[] {
  if (task.state !== "completed") return [];
  if (task.finalPath) {
    const final = output(task.finalPath, [task.directory, ...configuredRoots]);
    return final ? [final] : [];
  }
  const seen = new Set<string>();
  return task.files.flatMap((path) => {
    const item = output(path, [task.directory]);
    const key = item ? comparablePath(item.path)!.value : "";
    if (!item || seen.has(key)) return [];
    seen.add(key);
    return [item];
  });
}
