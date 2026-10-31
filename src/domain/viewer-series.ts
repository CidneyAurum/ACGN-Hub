import type { DownloadTask } from "./download";
import { getCompletedDownloadOutputs } from "./download-output";
import type { LocalDownloadReading, LocalDownloadTask } from "./local-download";
import { getLocalViewerKind, type LocalViewerKind } from "./local-viewer";

export interface ViewerSeriesItem {
  collection: "local" | "engine";
  id: string;
  path: string;
  allowedRoot: string;
  title: string;
  kind: LocalViewerKind;
  unitNumber?: number;
  unitTitle?: string;
  route: { path: string; query?: { file: string } };
}

export interface ViewerSeries {
  title: string;
  items: ViewerSeriesItem[];
  currentIndex: number;
  next?: ViewerSeriesItem;
  previous?: ViewerSeriesItem;
}

export interface ViewerSeriesInput {
  localTasks: readonly LocalDownloadTask[];
  engineTasks: readonly DownloadTask[];
  ownedLocalOutput: (id: string) => string | undefined;
  configuredRoots: readonly string[];
  current: { collection: unknown; id: unknown; file?: unknown };
}

interface Unit { number: number; title: string; kind: "episode" | "chapter" | "volume"; season?: number }
interface Identity { seriesTitle: string; unit: Unit }
interface Candidate {
  item: ViewerSeriesItem;
  mediaId?: string;
  editionId?: string;
  seriesTitle?: string;
  seriesKey?: string;
  unitKind?: Unit["kind"];
  season?: number;
  batchId?: string;
  batchLabel?: string;
  order: number;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000 || /[\u0000-\u001f]/.test(value)) return;
  return value.trim();
}

/** Preserve punctuation, season markers, and simplified/traditional distinctions. */
function titleKey(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
function filename(path: string): string { return path.split(/[\\/]/).pop() ?? path; }
function stem(value: string): string { return value.replace(/\.(?:cbz|txt|mp4|mkv|webm|m4v|mov|avi|ts)$/i, "").trim(); }
function finiteUnit(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000; }

function parseUnit(value: string): Unit | undefined {
  const title = value.normalize("NFKC").trim();
  // A release tag may carry codec/language, but never consume arbitrary trailing
  // words as a title/identity or turn an episode range into a single episode.
  const tags = "(?:\\s*\\[[^\\]\\r\\n]{1,100}\\])*";
  const chinese = title.match(new RegExp("^(?:第\\s*(\\d{1,2})\\s*季\\s*)?第\\s*(\\d{1,5}(?:\\.\\d{1,3})?)\\s*([话話集章节章節卷])(?:\\s*[:：·-]\\s*[^\\[\\]\\r\\n]{1,120})?" + tags + "$", "u"));
  if (chinese) {
    const number = Number(chinese[2]);
    if (!finiteUnit(number)) return;
    const unit = chinese[3];
    return { number, title, kind: unit === "卷" ? "volume" : unit === "集" ? "episode" : "chapter", ...(chinese[1] ? { season: Number(chinese[1]) } : {}) };
  }
  const season = title.match(new RegExp("^S(\\d{1,2})[ ._-]*E(\\d{1,5}(?:\\.\\d{1,3})?)" + tags + "$", "i"));
  if (season) return { number: Number(season[2]), title, kind: "episode", season: Number(season[1]) };
  const english = title.match(new RegExp("^(Episode|EP|E|Chapter|CH|Volume|Vol\\.?)[ ._-]*(\\d{1,5}(?:\\.\\d{1,3})?)" + tags + "$", "i"));
  if (!english) return;
  const number = Number(english[2]);
  if (!finiteUnit(number)) return;
  return { number, title, kind: /^(?:Volume|Vol)/i.test(english[1]) ? "volume" : /^(?:Chapter|CH)$/i.test(english[1]) ? "chapter" : "episode" };
}

function embeddedUnit(value: string, allowBracketNumber = false): Unit | undefined {
  const text = stem(value).normalize("NFKC").trim();
  const seasonEpisode = text.match(/(?:^|[\s._-])S(\d{1,2})[ ._-]*E(\d{1,5})(?:$|[\s._-])/i);
  if (seasonEpisode) return { number: Number(seasonEpisode[2]), title: seasonEpisode[0].trim(), kind: "episode", season: Number(seasonEpisode[1]) };
  const chinese = text.match(/(?:^|[\s._-])第\s*(\d{1,2})\s*季?\s*第\s*(\d{1,5}(?:\.\d{1,3})?)\s*([话話集章节章節卷])(?:$|[\s._-])/u);
  if (chinese) return { number: Number(chinese[2]), title: chinese[0].trim(), kind: chinese[3] === "卷" ? "volume" : chinese[3] === "集" ? "episode" : "chapter", season: Number(chinese[1]) };
  const english = text.match(/(?:^|[\s._-])(Episode|EP|E|Chapter|CH|Volume|Vol\.?)\s*(\d{1,5})(?:$|[\s._-])/i);
  if (english) return { number: Number(english[2]), title: english[0].trim(), kind: /^(?:Volume|Vol)/i.test(english[1]) ? "volume" : /^(?:Chapter|CH)$/i.test(english[1]) ? "chapter" : "episode" };
  if (allowBracketNumber) {
    const bracket = text.match(/[\[【（(]\s*(\d{1,5})\s*[\]】）)](?:$|\s)/);
    if (bracket && ![264, 265, 360, 480, 576, 720, 1080, 2160].includes(Number(bracket[1]))) return { number: Number(bracket[1]), title: bracket[0].trim(), kind: "episode" };
  }
  return;
}

function inferIdentity(value: string): Identity | undefined {
  const title = stem(value);
  // Require a visible series/unit separator. A shared directory, release group,
  // bare number or approximate spelling never grants a shared identity.
  const separators = [...title.matchAll(/\s+(?:-|–|—|·|•|\|)\s+/g)];
  for (let index = separators.length - 1; index >= 0; index--) {
    const match = separators[index];
    const seriesTitle = title.slice(0, match.index).trim();
    const unit = parseUnit(title.slice(match.index! + match[0].length));
    if (seriesTitle.length >= 2 && unit) return { seriesTitle, unit };
  }
  return;
}

function checkedReading(value: unknown): LocalDownloadReading | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const reading = value as Partial<LocalDownloadReading>;
  const seriesTitle = text(reading.seriesTitle);
  if (!seriesTitle || reading.mediaId !== undefined && !text(reading.mediaId)
      || reading.editionId !== undefined && !text(reading.editionId)
      || reading.unitTitle !== undefined && !text(reading.unitTitle)
      || reading.unitNumber !== undefined && !finiteUnit(reading.unitNumber)) return;
  return { seriesTitle, ...(reading.mediaId ? { mediaId: text(reading.mediaId) } : {}),
    ...(reading.editionId ? { editionId: text(reading.editionId) } : {}),
    ...(reading.unitTitle ? { unitTitle: text(reading.unitTitle) } : {}), ...(reading.unitNumber !== undefined ? { unitNumber: reading.unitNumber } : {}) };
}

function candidate(item: ViewerSeriesItem, options: { reading?: LocalDownloadReading; mediaId?: string; sourceTitle?: string; batchId?: string }, order: number): Candidate {
  const fromFile = inferIdentity(filename(item.path));
  const fromTitle = options.sourceTitle ? inferIdentity(options.sourceTitle) : undefined;
  // Conflicting legacy names cannot be resolved by guessing which was renamed.
  const legacy = fromFile && fromTitle && titleKey(fromFile.seriesTitle) !== titleKey(fromTitle.seriesTitle) ? undefined : fromFile ?? fromTitle;
  const reading = options.reading;
  const seriesTitle = reading?.seriesTitle ?? legacy?.seriesTitle;
  const embedded = embeddedUnit(filename(item.path), Boolean(options.batchId));
  const unit = reading?.unitTitle ? parseUnit(reading.unitTitle) : legacy?.unit ?? embedded ?? parseUnit(stem(filename(item.path)));
  const unitNumber = reading?.unitNumber ?? unit?.number;
  const unitTitle = reading?.unitTitle ?? unit?.title;
  const mediaId = reading?.mediaId ?? text(options.mediaId);
  const inferredSeason = unit?.season ?? embedded?.season ?? legacy?.unit.season;
  const batchLabel = unit && options.batchId ? titleKey(stem(filename(item.path)).replace(unit.title, "").replace(/^[\s._-]+|[\s._-]+$/g, "")) : undefined;
  return { item: { ...item, ...(unitNumber !== undefined ? { unitNumber } : {}), ...(unitTitle ? { unitTitle } : {}) },
    ...(mediaId ? { mediaId } : {}), ...(seriesTitle ? { seriesTitle, seriesKey: titleKey(seriesTitle) } : {}),
    ...(reading?.editionId ? { editionId: reading.editionId } : {}),
    ...(unit ? { unitKind: unit.kind } : {}),
    ...(inferredSeason !== undefined ? { season: inferredSeason } : {}),
    ...(options.batchId ? { batchId: options.batchId, batchLabel } : {}), order };
}

function safeLocalOutput(task: LocalDownloadTask, owned: string): { path: string; allowedRoot: string } | undefined {
  // Reuse the same registered-output/root filter as engine downloads. Ownership
  // alone is insufficient if a malformed saved record supplies an outside path.
  return getCompletedDownloadOutputs({ id: task.id, engineId: "local", sourceUrl: "", protocol: "http", state: "completed",
    directory: task.directory, files: [owned], totalBytes: 0, completedBytes: 0, speedBytesPerSecond: 0,
    dedupeKey: task.id, createdAt: task.createdAt, updatedAt: task.updatedAt })[0];
}

function collect(input: ViewerSeriesInput): Candidate[] {
  const results: Candidate[] = [];
  for (const task of input.localTasks) {
    if (task.stage !== "completed") continue;
    let owned: string | undefined;
    try { owned = input.ownedLocalOutput(task.id); } catch { continue; }
    if (!owned || owned !== task.outputPath) continue;
    const output = safeLocalOutput(task, owned);
    const kind = output ? getLocalViewerKind(output.path) : undefined;
    if (!output || !kind || kind !== ({ manga: "comic", novel: "text", video: "video" } as const)[task.kind]) continue;
    results.push(candidate({ collection: "local", id: task.id, path: output.path, allowedRoot: output.allowedRoot, title: task.title, kind,
      route: { path: "/viewer/local/" + encodeURIComponent(task.id) } }, { reading: checkedReading(task.reading), sourceTitle: task.title }, results.length));
  }
  for (const task of input.engineTasks) {
    const outputs = getCompletedDownloadOutputs(task, input.configuredRoots);
    for (const output of outputs) {
      const kind = getLocalViewerKind(output.path);
      if (!kind) continue;
      results.push(candidate({ collection: "engine", id: task.id, path: output.path, allowedRoot: output.allowedRoot, title: output.label, kind,
        route: { path: "/viewer/engine/" + encodeURIComponent(task.id), query: { file: output.path } } },
      { mediaId: task.mediaId, ...(outputs.length === 1 ? { sourceTitle: task.filename } : {}), ...(outputs.length > 1 ? { batchId: task.id } : {}) }, results.length));
    }
  }
  return results;
}

function compatible(left: Candidate, right: Candidate): boolean {
  if (left.item.kind !== right.item.kind) return false;
  if (left.unitKind && right.unitKind && (left.unitKind === "volume") !== (right.unitKind === "volume")) return false;
  if ((left.editionId || right.editionId) && (!left.editionId || left.editionId !== right.editionId)) return false;
  // Never use a same-name/no-ID item as a bridge between distinct works/seasons.
  if (left.mediaId || right.mediaId) return Boolean(left.mediaId && right.mediaId && left.mediaId === right.mediaId && left.season === right.season);
  if (left.season !== right.season) return false;
  if (left.seriesKey && right.seriesKey) return left.seriesKey === right.seriesKey;
  // Bare EP01/EP02 in one registered batch is explicit enough for that task
  // only. Untitled files from separate tasks/directories are never grouped.
  return Boolean(left.batchId && left.batchId === right.batchId && !left.seriesKey && !right.seriesKey
    && left.item.unitNumber !== undefined && right.item.unitNumber !== undefined && left.unitKind === right.unitKind
    && left.batchLabel === right.batchLabel);
}

function naturalCompare(left: string, right: string): number {
  const a = left.normalize("NFKC").toLowerCase().match(/\d+|\D+/g) ?? [];
  const b = right.normalize("NFKC").toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] === b[index]) continue;
    const numeric = /^\d+$/.test(a[index]) && /^\d+$/.test(b[index]);
    if (numeric) {
      const x = a[index].replace(/^0+/, "") || "0";
      const y = b[index].replace(/^0+/, "") || "0";
      if (x.length !== y.length) return x.length - y.length;
      if (x !== y) return x < y ? -1 : 1;
    }
    return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

/** Pure grouping of current completed allowlisted outputs; no filesystem reads. */
export function buildViewerSeries(input: ViewerSeriesInput): ViewerSeries {
  const empty: ViewerSeries = { title: "本地观看", items: [], currentIndex: -1 };
  if ((input.current.collection !== "local" && input.current.collection !== "engine") || typeof input.current.id !== "string" || !input.current.id) return empty;
  if (input.current.collection === "local" && input.current.file !== undefined && input.current.file !== null) return empty;
  if (input.current.file !== undefined && input.current.file !== null && typeof input.current.file !== "string") return empty;
  const all = collect(input);
  const matching = all.filter((value) => value.item.collection === input.current.collection && value.item.id === input.current.id);
  const current = typeof input.current.file === "string" ? matching.find((value) => value.item.path === input.current.file)
    : matching.length === 1 ? matching[0] : undefined;
  if (!current) return empty;
  const group = all.filter((value) => value === current || compatible(current, value));
  group.sort((left, right) => {
    const a = left.item.unitNumber;
    const b = right.item.unitNumber;
    if (a !== undefined && b !== undefined && a !== b) return a - b;
    if (a !== undefined && b === undefined) return -1;
    if (a === undefined && b !== undefined) return 1;
    return naturalCompare(filename(left.item.path), filename(right.item.path)) || left.order - right.order;
  });
  const currentIndex = group.indexOf(current);
  const items = group.map((value) => value.item);
  return { title: current.seriesTitle ?? current.item.title, items, currentIndex,
    ...(items[currentIndex + 1] ? { next: items[currentIndex + 1] } : {}), ...(items[currentIndex - 1] ? { previous: items[currentIndex - 1] } : {}) };
}
