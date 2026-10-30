import { invoke } from "@tauri-apps/api/core";
import type { LibraryFileScanner } from "@/application/local-file-ports";
import type { ScannedLocalFile } from "@/domain/local-file";
import { isTauriRuntime } from "@/shared/runtime";

interface TauriLibraryFile {
  id?: string;
  path: string;
  sizeBytes: number;
  sha256?: string;
}

export class TauriLibraryFileScanner implements LibraryFileScanner {
  async scan(libraryRoot: string, withHash: boolean): Promise<ScannedLocalFile[]> {
    if (!isTauriRuntime()) throw new Error("本地文件扫描只在桌面端可用");
    const files = await invoke<TauriLibraryFile[]>("scan_library_files", { libraryRoot, withHash });
    return files.map((file) => ({
      id: file.id ?? `path:${file.path}`,
      path: file.path,
      sizeBytes: file.sizeBytes,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    }));
  }
}

export function createLibraryFileScanner(): LibraryFileScanner {
  return new TauriLibraryFileScanner();
}
