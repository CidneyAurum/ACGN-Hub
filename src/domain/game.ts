export type GameEngineKind = "renpy" | "kirikiri" | "unity" | "unknown";

export interface GameScanResult {
  rootPath: string;
  engine: GameEngineKind;
  launchCandidates: string[];
  detectedFiles: string[];
}

export interface GameInstall {
  id: string;
  path: string;
  title: string;
  mediaId?: string;
  coverUrl?: string;
  engine: GameEngineKind;
  launchPath?: string;
  detectedFiles: string[];
  createdAt: string;
  updatedAt: string;
}
