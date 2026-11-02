import { timeoutSignal } from "@/shared/abort-signals";
import { z } from "zod";
import type { Media } from "@/domain/media";
import { createJsonFetcher, type JsonFetcher } from "./json-transport";
import { normalizeImageUrl } from "@/infrastructure/media/image-loader";

const calendarSubject = z.object({ id: z.number().int().positive(), name: z.string(), name_cn: z.string().optional(), summary: z.string().nullable().optional(), air_date: z.string().nullable().optional(), images: z.object({ large: z.string().optional(), common: z.string().optional(), medium: z.string().optional() }).nullable().optional(), rating: z.object({ score: z.number().optional(), total: z.number().optional() }).nullable().optional(), collection: z.object({ doing: z.number().optional() }).nullable().optional() }).passthrough();
const calendarSchema = z.array(z.object({ weekday: z.object({ id: z.number().int().min(1).max(7), cn: z.string() }).passthrough(), items: z.array(calendarSubject) }));
export interface DiscoveryDay { id: number; label: string; items: Media[] }
export interface DiscoveryResult { days: DiscoveryDay[]; updatedAt: string; cached: boolean }
const CACHE_KEY = "acgn-hub.discovery-calendar.v1";
let pending: Promise<DiscoveryResult> | undefined;

export async function getDiscoveryCalendar(options: { refresh?: boolean; fetcher?: JsonFetcher } = {}): Promise<DiscoveryResult> {
  const cached = readCache();
  if (!options.refresh && cached && Date.now() - new Date(cached.updatedAt).getTime() < 30 * 60 * 1000) return cached;
  if (pending && !options.fetcher) return pending;
  const load = (async () => {
    try {
      const response = await (options.fetcher ?? createJsonFetcher())("https://api.bgm.tv/calendar", { method: "GET", headers: { Accept: "application/json" }, signal: timeoutSignal(12000), timeoutMs: 12000 });
      if (response.status !== 200) throw new Error("放送表暂时不可用（HTTP " + response.status + "）");
      const parsed = calendarSchema.safeParse(await response.json());
      if (!parsed.success || !parsed.data.length) throw new Error("放送表数据格式发生变化，请稍后重试");
      const result: DiscoveryResult = { days: parsed.data.map((day) => ({ id: day.weekday.id, label: day.weekday.cn, items: day.items.map((subject) => {
        const image = subject.images?.large || subject.images?.common || subject.images?.medium;
        const title = subject.name_cn?.trim() || subject.name;
        return { id: "bangumi:" + subject.id, type: "anime", title, ...(subject.name !== title ? { originalTitle: subject.name } : {}), aliases: [...new Set([subject.name, subject.name_cn].filter((value): value is string => Boolean(value)))], description: subject.summary || undefined, coverUrl: image ? normalizeImageUrl(image) : undefined, releaseYear: subject.air_date && /^\d{4}/.test(subject.air_date) ? Number(subject.air_date.slice(0, 4)) : undefined, externalIds: [{ provider: "bangumi", value: String(subject.id) }], metadata: { date: subject.air_date, airWeekday: day.weekday.id, rating: subject.rating?.score, voteCount: subject.rating?.total, watching: subject.collection?.doing, raw: subject } } satisfies Media;
      }) })), updatedAt: new Date().toISOString(), cached: false };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(result)); } catch { /* Discovery remains usable without disk cache. */ }
      return result;
    } catch (cause) {
      if (cached) return { ...cached, cached: true };
      throw cause;
    }
  })();
  if (!options.fetcher) { pending = load; void load.finally(() => { pending = undefined; }).catch(() => undefined); }
  return load;
}
function readCache(): DiscoveryResult | undefined {
  try { const data: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"); if (!data || typeof data !== "object") return undefined; const cached = data as DiscoveryResult; if (!Array.isArray(cached.days) || typeof cached.updatedAt !== "string" || !Number.isFinite(Date.parse(cached.updatedAt))) return undefined; if (!cached.days.every((day) => typeof day.id === "number" && Array.isArray(day.items) && day.items.every((item) => item && typeof item.id === "string" && typeof item.title === "string"))) return undefined; return cached; }
  catch { return undefined; }
}
