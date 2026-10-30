import { describe, expect, it } from "vitest";
import { LocalStorageGameInstallRepository, type GameInstallStorageLike } from "@/infrastructure/database/game-install-repository";

class MemoryStorage implements GameInstallStorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("game install repository", () => {
  it("persists launch configuration without overwriting another install", async () => {
    const repository = new LocalStorageGameInstallRepository(new MemoryStorage());
    const install = {
      id: "game:d:/games/open-vn",
      path: "D:\\Games\\OpenVN",
      title: "Open VN",
      engine: "renpy" as const,
      launchPath: "D:\\Games\\OpenVN\\OpenVN.exe",
      detectedFiles: ["game/script.rpy"],
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
    await repository.initialize();
    await repository.upsert(install);
    await repository.upsert({ ...install, title: "Open VN Updated", updatedAt: "2026-08-17T01:00:00.000Z" });
    await expect(repository.list()).resolves.toEqual([{ ...install, title: "Open VN Updated", updatedAt: "2026-08-17T01:00:00.000Z" }]);
  });
});
