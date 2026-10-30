import type { GameInstall, GameScanResult } from "@/domain/game";

export interface GameInstallScanner {
  scan(rootPath: string): Promise<GameScanResult>;
}

export interface GameLauncher {
  launch(rootPath: string, launchPath: string): Promise<void>;
  backupSaves(rootPath: string, savePaths: string[], backupRoot: string, backupName: string): Promise<string>;
}

export interface GameInstallRepository {
  initialize(): Promise<void>;
  list(): Promise<GameInstall[]>;
  upsert(install: GameInstall): Promise<void>;
}
