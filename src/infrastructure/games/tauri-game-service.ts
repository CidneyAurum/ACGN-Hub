import { invoke } from "@tauri-apps/api/core";
import type { GameLauncher, GameInstallScanner } from "@/application/game-ports";
import type { GameScanResult } from "@/domain/game";
import { isTauriRuntime } from "@/shared/runtime";

interface TauriGameScanResponse {
  rootPath: string;
  engine: GameScanResult["engine"];
  launchCandidates: string[];
  detectedFiles: string[];
}

export class TauriGameService implements GameInstallScanner, GameLauncher {
  async scan(rootPath: string): Promise<GameScanResult> {
    if (!isTauriRuntime()) throw new Error("Galgame 本地扫描只在桌面端可用");
    return invoke<TauriGameScanResponse>("scan_game_installation", { rootPath });
  }

  async launch(rootPath: string, launchPath: string): Promise<void> {
    if (!isTauriRuntime()) throw new Error("Galgame 启动只在桌面端可用");
    await invoke("launch_game", { rootPath, launchPath });
  }

  async backupSaves(rootPath: string, savePaths: string[], backupRoot: string, backupName: string): Promise<string> {
    if (!isTauriRuntime()) throw new Error("Galgame 存档备份只在桌面端可用");
    return invoke<string>("backup_game_saves", { gameRoot: rootPath, savePaths, backupRoot, backupName });
  }
}

export function createGameService(): TauriGameService {
  return new TauriGameService();
}
