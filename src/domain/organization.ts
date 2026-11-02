import type { Media } from "@/domain/media";

export type OrganizationMediaType = "anime" | "manga" | "novel" | "visual_novel";

export interface OrganizationInput {
  taskId: string;
  sourcePath: string;
  incomingRoot: string;
  libraryRoot: string;
  media: Media;
  episodeOverride?: { season: number; episode: number };
}

export interface OrganizationPlan {
  taskId: string;
  mediaId: string;
  sourcePath: string;
  destinationPath: string;
  incomingRoot: string;
  libraryRoot: string;
  warning?: "episode_unresolved";
}

export type OrganizationResultStatus = "moved" | "already_present" | "conflict";

export interface OrganizationResult {
  status: OrganizationResultStatus;
  sourcePath: string;
  destinationPath: string;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function buildOrganizationPlan(input: OrganizationInput): OrganizationPlan {
  const incomingRoot = normalizeAbsoluteWindowsPath(input.incomingRoot, "Incoming 根目录");
  const libraryRoot = normalizeAbsoluteWindowsPath(input.libraryRoot, "Library 根目录");
  const sourcePath = normalizeAbsoluteWindowsPath(input.sourcePath, "源文件路径");
  if (!isPathInside(incomingRoot, sourcePath)) {
    throw new Error("源文件不在 Incoming 根目录内，已拒绝整理");
  }

  const sourceName = basename(sourcePath);
  const extension = fileExtension(sourceName);
  const safeTitle = sanitizeFileName(input.media.title, "未命名作品");
  const detectedEpisode = input.media.type === "anime" ? detectEpisode(sourceName) : undefined;
  const episode = input.episodeOverride ?? detectedEpisode;
  if (episode && (!Number.isInteger(episode.season) || episode.season < 1 || episode.season > 99 ||
    !Number.isInteger(episode.episode) || episode.episode < 0 || episode.episode > 999)) {
    throw new Error("手动集数必须是有效的季数和集数");
  }
  const typeFolder = input.media.type === "anime" && !episode ? "Unmatched" : mediaFolder(input.media.type);
  const safeSourceName = sanitizeFileName(stripExtension(sourceName), "未命名文件");
  const outputName = episode
    ? `${safeTitle} S${pad(episode.season)}E${pad(episode.episode)}${resolutionSuffix(sourceName)}${extension}`
    : `${safeSourceName}${extension}`;
  const seasonFolder = episode ? `Season ${pad(episode.season)}` : undefined;
  const relativeSegments = [typeFolder, safeTitle, ...(seasonFolder ? [seasonFolder] : []), outputName];
  const destinationPath = joinWindowsPath(libraryRoot, ...relativeSegments);
  if (!isPathInside(libraryRoot, destinationPath)) {
    throw new Error("整理目标越出 Library 根目录，已拒绝整理");
  }

  return {
    taskId: input.taskId,
    mediaId: input.media.id,
    sourcePath,
    destinationPath,
    incomingRoot,
    libraryRoot,
    ...(input.media.type === "anime" && !episode ? { warning: "episode_unresolved" } : {}),
  };
}

export function sanitizeFileName(value: string, fallback = "未命名"): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!normalized || normalized === "." || normalized === "..") return fallback;
  if (RESERVED_NAMES.test(normalized)) return `_${normalized}`;
  return normalized.slice(0, 180);
}

/** Android/ext4 counts UTF-8 bytes, whereas Windows counts UTF-16 characters. */
export function sanitizeMobileFileName(value: string, fallback = "未命名"): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
  const name = (!cleaned || cleaned === "." || cleaned === ".." ? fallback
    : RESERVED_NAMES.test(cleaned) || cleaned.startsWith(".") ? `_${cleaned}` : cleaned).replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(name);
  if (bytes.length <= 220) return name;
  // Preserve split archive suffixes as well as reader file extensions. A stable
  // digest keeps two titles differing beyond the cut from claiming one output.
  const suffix = name.match(/(?:\.part\d{1,8}\.rar|\.(?:7z|zip)\.\d{3,8}|\.tar\.(?:gz|xz|bz2)|\.[a-z\d]{1,12})$/i)?.[0] ?? "";
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(stem)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  const tail = `~${hash.toString(16).padStart(8, "0")}${suffix}`;
  // Reserve the same suffix space for .001/.002 and .part09/.part10 so their
  // shared archive stem is shortened identically and remains extractable.
  const budget = 220 - 9 - Math.max(24, encoder.encode(suffix).length);
  let used = 0; let prefix = "";
  for (const character of stem) {
    const length = encoder.encode(character).length;
    if (used + length > budget) break;
    prefix += character; used += length;
  }
  return prefix.replace(/[. ]+$/g, "") + tail;
}

export function detectEpisode(value: string): { season: number; episode: number } | undefined {
  const patterns = [
    /\bS(\d{1,2})\s*E(\d{1,3})\b/i,
    /\b(\d{1,2})x(\d{1,3})\b/i,
    /\b(?:EP|Episode|E)[ ._-]*(\d{1,3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    if (match.length === 3) return { season: Number(match[1]), episode: Number(match[2]) };
    return { season: 1, episode: Number(match[1]) };
  }
  return undefined;
}

export function isPathInside(root: string, target: string): boolean {
  if (root.startsWith("/") && !root.startsWith("//")) {
    const base = root.replace(/\/+$/, "") || "/";
    if (!target.startsWith("/") || target.includes("\\") || target.split("/").some((part) => part === "." || part === "..")) return false;
    return target === base || target.startsWith(base === "/" ? "/" : base + "/");
  }
  const normalizedRoot = normalizeForComparison(root);
  const normalizedTarget = normalizeForComparison(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`);
}

export function joinWindowsPath(root: string, ...segments: string[]): string {
  const posix = root.startsWith("/") && !root.startsWith("//");
  const safeSegments = segments.map((segment) => {
    const safe = posix ? sanitizeMobileFileName(segment) : sanitizeFileName(segment);
    if (safe.includes("\\") || safe.includes("/")) throw new Error("整理路径片段无效");
    return safe;
  });
  return [root.replace(/[\\/]+$/g, ""), ...safeSegments].join(posix ? "/" : "\\");
}

function normalizeAbsoluteWindowsPath(value: string, label: string): string {
  const slashes = normalizeWindowsSlashes(value.trim());
  if (slashes.split("\\").some((segment) => segment === "..")) throw new Error(`${label}不能包含 .. 父目录片段`);
  const normalized = /^[A-Za-z]:\\$/.test(slashes) ? slashes : slashes.replace(/\\+$/g, "");
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(normalized)) throw new Error(`${label}必须是 Windows 绝对路径`);
  if (normalized.split("\\").some((segment) => segment === "..")) throw new Error(`${label}不能包含 .. 父目录片段`);
  return normalized;
}

function normalizeForComparison(value: string): string {
  return normalizeWindowsSlashes(value).replace(/[\\.]+$/g, "").toLowerCase();
}

function normalizeWindowsSlashes(value: string): string {
  const slashes = value.replace(/\//g, "\\");
  const collapsed = slashes.replace(/\\+/g, "\\");
  return slashes.startsWith("\\\\") ? "\\" + collapsed : collapsed;
}

function mediaFolder(type: OrganizationMediaType): string {
  return { anime: "Anime", manga: "Manga", novel: "Novels", visual_novel: "VisualNovels" }[type];
}

function basename(value: string): string {
  return value.split("\\").pop() ?? value;
}

function fileExtension(value: string): string {
  const match = value.match(/(\.[^.]+)$/);
  return match?.[1].toLowerCase() ?? "";
}

function stripExtension(value: string): string {
  return value.replace(/\.[^.]+$/, "");
}

function resolutionSuffix(value: string): string {
  const match = value.match(/\b(2160p|1440p|1080p|720p|480p)\b/i);
  return match ? ` [${match[1].toLowerCase()}]` : "";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
