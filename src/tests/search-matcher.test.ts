import { describe, expect, it } from "vitest";
import type { Media } from "@/domain/media";
import { rankMedia } from "@/infrastructure/metadata/search-matcher";

function media(overrides: Partial<Media>): Media {
  return {
    id: overrides.id ?? "test:1",
    type: overrides.type ?? "anime",
    title: overrides.title ?? "",
    aliases: overrides.aliases ?? [],
    externalIds: overrides.externalIds ?? [],
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

describe("search matcher", () => {
  it("prefers a Chinese exact title over a foreign alias", () => {
    const result = rankMedia("葬送的芙莉莲", [
      media({ id: "a", title: "Sousou no Frieren", aliases: ["葬送的芙莉莲"] }),
      media({ id: "b", title: "葬送的芙莉莲", originalTitle: "葬送のフリーレン" }),
    ]);

    expect(result[0].media.id).toBe("b");
    expect(result[0].reason).toBe("exact");
  });

  it("matches Chinese pinyin and a small typo", () => {
    const item = media({ id: "a", title: "葬送的芙莉莲" });

    expect(rankMedia("zangsongdefulilian", [item])[0]?.reason).toBe("pinyin");
    expect(rankMedia("Frierex", [media({ id: "b", title: "Frieren" })])[0]?.reason).toBe("fuzzy");
  });

  it("does not rank another media type", () => {
    const result = rankMedia("同名作品", [
      media({ id: "anime", type: "anime", title: "同名作品" }),
      media({ id: "novel", type: "novel", title: "同名作品" }),
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.media.type)).toEqual(["anime", "novel"]);
  });
});
