import { afterEach, describe, expect, it, vi } from "vitest";
import { getDiscoveryCalendar } from "@/infrastructure/metadata/discovery-provider";
describe("anime discovery calendar", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("shows real API titles, weekday and rating and normalizes insecure image URLs", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const fetcher = vi.fn(async () => ({ status: 200, json: async () => [{ weekday: { id: 4, cn: "星期四" }, items: [{ id: 400602, name: "葬送のフリーレン", name_cn: "葬送的芙莉莲", images: { large: "http://lain.bgm.tv/cover.jpg" }, air_date: "2023-09-29", rating: { score: 8.5, total: 30000 } }] }] }));
    const result = await getDiscoveryCalendar({ fetcher });
    expect(result.days[0].items[0]).toMatchObject({ id: "bangumi:400602", title: "葬送的芙莉莲", coverUrl: "https://lain.bgm.tv/cover.jpg", metadata: { airWeekday: 4, rating: 8.5 } });
    const fallback = await getDiscoveryCalendar({ refresh: true, fetcher: async () => { throw new Error("offline"); } });
    expect(fallback.cached).toBe(true);
    expect(fallback.days[0].items).toHaveLength(1);
  });
});
