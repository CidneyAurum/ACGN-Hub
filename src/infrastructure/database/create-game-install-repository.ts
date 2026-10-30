import type { GameInstallRepository } from "@/application/game-ports";
import { createRepository } from "./repository-runtime";
import { LocalStorageGameInstallRepository, SqliteGameInstallRepository } from "./game-install-repository";

export function createGameInstallRepository(): Promise<GameInstallRepository> {
  return createRepository<GameInstallRepository>("game-installs", () => new SqliteGameInstallRepository(), () => new LocalStorageGameInstallRepository());
}
