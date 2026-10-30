import type { DownloadTask } from "./download";
import type { Media } from "./media";
import type { ResourceItem } from "./resource";
import { sanitizeFileName } from "./organization";

export interface CompletedDownloadNameInput {
  task: DownloadTask;
  media?: Media;
  resource?: ResourceItem;
  /** Required for a task containing more than one file. No directory is changed. */
  filePath?: string;
}

export interface CompletedDownloadName {
  filePath: string;
  /** Basename including the original, unchanged extension. Absence means retain the original. */
  newFileName?: string;
  reason?: string;
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".m4v", ".avi", ".mov"]);
const HAN = /\p{Script=Han}/u;

/** Pure naming proposal. Completion checks, conflict handling and file moves belong to the caller. */
export function buildCompletedDownloadName(input: CompletedDownloadNameInput): CompletedDownloadName {
  const { task, media, resource } = input;
  const filePath = input.filePath ?? (task.files.length === 1 ? task.files[0] : "");
  const keep = (reason: string): CompletedDownloadName => ({ filePath, reason });
  if (task.state !== "completed") return keep("下载尚未完成，保留原文件名以免影响续传");
  if (!filePath || /[\\/]$/.test(filePath)) return keep("请为多文件任务指定实际文件路径");
  if (!task.files.some((path) => samePath(path, filePath))) return keep("所选文件未登记在当前下载任务中，保留原名");
  const original = filePath.split(/[\\/]/).pop() ?? "";
  const extension = original.match(/\.[A-Za-z0-9]{1,8}$/)?.[0];
  if (!extension) return keep("文件扩展名不明确，保留原名");
  const lowerExtension = extension.toLowerCase();
  const video = VIDEO_EXTENSIONS.has(lowerExtension);
  if (!video && lowerExtension !== ".cbz" && lowerExtension !== ".txt") return keep("此文件类型不自动改名");
  if (media && task.mediaId && task.mediaId !== media.id) return keep("关联作品与下载任务不一致，保留原名");
  if (resource && task.resourceId && task.resourceId !== resource.id) return keep("关联资源与下载任务不一致，保留原名");
  if (media && resource?.mediaId && media.id !== resource.mediaId) return keep("资源属于其它作品，保留原名");
  const title = preferredTitle(media, resource);
  if (!title) return keep("缺少可靠的作品名称，保留原名");
  const stem = original.slice(0, -extension.length);

  if (video) {
    if (media && media.type !== "anime") return keep("仅对已关联动画的视频生成集数文件名");
    if (!media && !metadataText(resource, "seriesTitle")) return keep("缺少动画作品资料，保留原名");
    if (/(?:^|[^A-Za-z0-9])(?:(?:OVA|OAD|SP)(?:[ ._-]*\d{1,3})?|SPECIAL|NCOP|NCED|PV)(?=$|[^A-Za-z0-9])|特典|特别篇|特別篇|番外|剧场版|劇場版/i.test(stem)) {
      return keep("特典、OVA 或特别篇需要单独确认，不按正篇集数改名");
    }
    if (/(?:\[|【|\b)(?:\d{1,3}\s*[-~～至]\s*\d{1,3})(?:\]|】|\b)|全集|合集|全\s*\d+\s*[话話集]|\b(?:COMPLETE|BATCH|PACK)\b/i.test(stem)) {
      return keep("合集或集数范围不适合自动命名单集");
    }
    const singleFile = task.files.length === 1 && samePath(task.files[0], filePath);
    const episode = singleFile && validNumber(resource?.episode, 0, 999)
      ? resource!.episode! : detectEpisodeNumber(stem);
    if (episode === undefined) return keep("未能可靠识别单集集数，保留原名");
    const fileSeason = detectSeason(stem);
    const resourceSeason = singleFile ? metadataSeason(resource) : undefined;
    if (fileSeason !== undefined && resourceSeason !== undefined && fileSeason !== resourceSeason) return keep("季度标识相互冲突，保留原名");
    const season = resourceSeason ?? fileSeason;
    const suffix = ` - ${season === undefined ? "" : `第${pad(season)}季 `}第${pad(episode)}话`;
    const tags = [resolution(resource, stem), language(resource, stem), codec(stem)].filter((tag): tag is string => Boolean(tag));
    return { filePath, newFileName: compose(title, suffix + tags.map((tag) => ` [${tag}]`).join(""), extension) };
  }

  const expectedType = lowerExtension === ".cbz" ? "manga" : "novel";
  if (media && media.type !== expectedType) return keep("文件类型与关联作品不一致，保留原名");
  const label = lowerExtension === ".cbz"
    ? metadataText(resource, "chapterName") || (validNumber(resource?.chapter, 0, 99_999) ? `第${pad(resource!.chapter!)}话` : "")
    : metadataText(resource, "volumeTitle") || metadataText(resource, "volumeName") || (validNumber(resource?.volume, 1, 9_999) ? `第${pad(resource!.volume!)}卷` : "");
  if (!label || !HAN.test(label) && !/\d/.test(label)) return keep("章节或卷信息不充分，保留已有文件名");
  if (task.files.length !== 1 || !samePath(task.files[0], filePath)) return keep("多文件书籍需要逐个确认章节或卷，保留原名");
  // A chapter/volume label is part of the identity, not disposable title text.
  const cleanLabel = cleanName(label);
  if (!cleanLabel || cleanLabel.length > 120) return keep("章节或卷名称不明确或过长，保留原名");
  return { filePath, newFileName: compose(title, ` - ${cleanLabel}`, extension) };
}

function preferredTitle(media?: Media, resource?: ResourceItem): string {
  const saved = media?.title.trim() ?? "";
  const raw = media?.metadata.raw;
  const rawChinese = raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).name_cn === "string"
    ? ((raw as Record<string, unknown>).name_cn as string).trim() : "";
  const series = metadataText(resource, "seriesTitle");
  const chinese = (value: string) => HAN.test(value) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
  return cleanName(chinese(saved) ? saved : chinese(rawChinese) ? rawChinese : chinese(series) ? series : saved || rawChinese || series);
}

function metadataText(resource: ResourceItem | undefined, key: string): string {
  const value = resource?.metadata[key];
  return typeof value === "string" ? value.trim() : "";
}
function validNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function uniqueNumber(values: string[]): number | undefined {
  const parsed = [...new Set(values.map(Number).filter((number) => validNumber(number, 0, 999)))];
  return parsed.length === 1 ? parsed[0] : undefined;
}
function detectEpisodeNumber(stem: string): number | undefined {
  const patterns = [
    /(?:^|[^A-Za-z0-9])S\d{1,2}\s*E(\d{1,3})(?!\d|\.\d)(?=$|[^A-Za-z0-9])/gi,
    /第\s*(\d{1,3})\s*[话話集](?!\d)/gu,
    /(?:^|[^A-Za-z0-9])(?:Episode|EP|E)[ ._-]*(\d{1,3})(?!\d|\.\d)(?=$|[^A-Za-z0-9])/gi,
    /\[\s*(\d{1,3})\s*\]/g,
    /(?:^|\s)-\s*(\d{1,3})(?!\d|\.\d)(?=$|\s|\[|【)/g,
  ];
  for (let index = 0; index < patterns.length; index++) {
    const matches = [...stem.matchAll(patterns[index])].map((match) => match[1]);
    if (!matches.length) continue;
    // Bare numeric release tags could be common resolution/codec identifiers.
    if (index >= 3 && matches.some((value) => [264, 265, 360, 480, 576, 720].includes(Number(value)))) return undefined;
    return uniqueNumber(matches);
  }
  return undefined;
}
function detectSeason(stem: string): number | undefined {
  const values = [...stem.matchAll(/(?:^|[^A-Za-z0-9])S(\d{1,2})(?:\s*E\d{1,3})?(?=$|[^A-Za-z0-9])/gi)].map((match) => match[1]);
  values.push(...[...stem.matchAll(/第\s*(\d{1,2})\s*季/gu)].map((match) => match[1]));
  const seasons = [...new Set(values.map(Number).filter((value) => validNumber(value, 1, 99)))];
  return seasons.length === 1 ? seasons[0] : undefined;
}
function metadataSeason(resource?: ResourceItem): number | undefined {
  for (const key of ["season", "seasonNumber"]) {
    const value = resource?.metadata[key];
    if (validNumber(value, 1, 99)) return value;
  }
  const label = metadataText(resource, "seasonLabel");
  return label ? detectSeason(label) : undefined;
}
function resolution(resource: ResourceItem | undefined, stem: string): string | undefined {
  const source = resource?.resolution?.trim().match(/^(2160|1440|1080|720|576|480|360)p$/i)?.[1];
  const file = [...new Set([...stem.matchAll(/(?:^|[^A-Za-z0-9])(2160|1440|1080|720|576|480|360)p(?=$|[^A-Za-z0-9])/gi)].map((match) => match[1]))];
  if (file.length > 1 || source && file.length && source !== file[0]) return undefined;
  return source || file[0] ? `${source || file[0]}p` : undefined;
}
function language(resource: ResourceItem | undefined, stem: string): string | undefined {
  const value = `${resource?.language ?? ""} ${stem}`;
  const simplified = /(?:^|[^A-Za-z0-9])(?:CHS|GB|zh-CN|zh-Hans)(?=$|[^A-Za-z0-9])|简[体體]?中|简体|簡體/iu.test(value);
  const traditional = /(?:^|[^A-Za-z0-9])(?:CHT|BIG5|zh-TW|zh-HK|zh-Hant)(?=$|[^A-Za-z0-9])|繁[体體]?中|繁体|繁體/iu.test(value);
  return simplified && traditional ? "简繁中" : simplified ? "简中" : traditional ? "繁中" : /^(?:zh|中文|汉语|漢語)$/i.test(resource?.language?.trim() ?? "") ? "中文" : undefined;
}
function codec(stem: string): string | undefined {
  const codecs = [
    ["HEVC", /(?:^|[^A-Za-z0-9])(?:HEVC|H[ ._-]?265|X265)(?=$|[^A-Za-z0-9])/i],
    ["H264", /(?:^|[^A-Za-z0-9])(?:AVC|H[ ._-]?264|X264)(?=$|[^A-Za-z0-9])/i],
    ["AV1", /(?:^|[^A-Za-z0-9])AV1(?=$|[^A-Za-z0-9])/i],
  ] as const;
  const found = codecs.filter(([, pattern]) => pattern.test(stem));
  return found.length === 1 ? found[0][0] : undefined;
}
function cleanName(value: string): string { return sanitizeFileName(value.replace(/\s+/g, " "), ""); }
function pad(value: number): string { return String(value).padStart(2, "0"); }
function samePath(left: string, right: string): boolean { return left.replace(/\//g, "\\").toLowerCase() === right.replace(/\//g, "\\").toLowerCase(); }
function compose(title: string, suffix: string, extension: string): string {
  const available = Math.max(1, 180 - suffix.length - extension.length);
  let shortened = title.slice(0, available);
  // Do not split a UTF-16 surrogate pair while enforcing the full-name limit.
  if (/[\uD800-\uDBFF]$/.test(shortened)) shortened = shortened.slice(0, -1);
  return `${shortened.replace(/[. ]+$/g, "") || "作品"}${suffix}${extension}`;
}
