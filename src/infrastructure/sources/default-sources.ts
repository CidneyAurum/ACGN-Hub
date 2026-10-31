import type { SourceConfig } from "@/domain/source";

export interface DefaultGithubSourcePreset {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

/**
 * 旧版本错误预置的项目 Release，仅用于升级时清理。
 */
export const DEFAULT_GITHUB_SOURCE_PRESETS: readonly DefaultGithubSourcePreset[] = [
  { id: "github:open-ani/animeko", name: "Animeko Release", url: "https://github.com/open-ani/animeko", enabled: true },
  { id: "github:EstrellaXD/Auto_Bangumi", name: "AutoBangumi Release", url: "https://github.com/EstrellaXD/Auto_Bangumi", enabled: true },
  { id: "github:mihonapp/mihon", name: "Mihon Release", url: "https://github.com/mihonapp/mihon", enabled: true },
  { id: "github:aniyomiorg/aniyomi", name: "Aniyomi Release", url: "https://github.com/aniyomiorg/aniyomi", enabled: true },
  { id: "github:Suwayomi/Suwayomi-Server", name: "Suwayomi Server Release", url: "https://github.com/Suwayomi/Suwayomi-Server", enabled: true },
  { id: "github:ShokoAnime/ShokoServer", name: "Shoko Server Release", url: "https://github.com/ShokoAnime/ShokoServer", enabled: true },
  { id: "github:mayswind/AriaNg", name: "AriaNg Release", url: "https://github.com/mayswind/AriaNg", enabled: true },
  { id: "github:yt-dlp/yt-dlp", name: "yt-dlp Release", url: "https://github.com/yt-dlp/yt-dlp", enabled: true },
  { id: "github:bangumi/Archive", name: "Bangumi Archive Release", url: "https://github.com/bangumi/Archive", enabled: true },
];

const DEFAULT_SOURCE_TIMESTAMP = "2026-08-17T00:00:00.000Z";

export const DEFAULT_RESOURCE_SOURCE_CONFIGS: readonly SourceConfig[] = [
  { id: "builtin:mangabz", type: "mangabz", name: "MangaBZ · 中文日漫", url: "https://mangabz.com", enabled: false, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" },
  {
    id: "builtin:public-video",
    type: "public_video",
    name: "B站公开投稿",
    url: "https://www.bilibili.com",
    enabled: false,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
  },
  {
    id: "builtin:mikan",
    type: "rss",
    name: "蜜柑计划 · 动漫 RSS",
    url: "https://mikanani.me/RSS/Classic",
    enabled: false,
    createdAt: DEFAULT_SOURCE_TIMESTAMP,
    updatedAt: DEFAULT_SOURCE_TIMESTAMP,
  },
  {
    id: "builtin:acgnx",
    type: "rss",
    name: "AcgnX · 动漫 RSS",
    url: "https://share.acgnx.se/rss.xml",
    enabled: false,
    createdAt: DEFAULT_SOURCE_TIMESTAMP,
    updatedAt: DEFAULT_SOURCE_TIMESTAMP,
  },
  {
    id: "builtin:kungal",
    type: "kungal",
    name: "鲲 Galgame 资源",
    url: "https://www.kungal.com",
    enabled: false,
    createdAt: DEFAULT_SOURCE_TIMESTAMP,
    updatedAt: DEFAULT_SOURCE_TIMESTAMP,
  },
  {
    id: "builtin:vndb-releases",
    type: "vndb_release",
    name: "VNDB · 官方发行与试玩",
    url: "https://api.vndb.org/kana",
    enabled: false,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  },
  {
    id: "builtin:mangadex",
    type: "mangadex",
    name: "MangaDex 漫画",
    url: "https://api.mangadex.org",
    enabled: false,
    createdAt: DEFAULT_SOURCE_TIMESTAMP,
    updatedAt: DEFAULT_SOURCE_TIMESTAMP,
  },
  {
    id: "builtin:copymanga",
    type: "copymanga",
    name: "拷贝漫画",
    url: "https://mapi.hotmangasg.com",
    enabled: false,
    createdAt: DEFAULT_SOURCE_TIMESTAMP,
    updatedAt: DEFAULT_SOURCE_TIMESTAMP,
  },
  {
    id: "builtin:jmcomic",
    type: "jmcomic",
    name: "JMComic 漫画（可选）",
    url: "python://jmcomic",
    enabled: false,
    createdAt: DEFAULT_SOURCE_TIMESTAMP,
    updatedAt: DEFAULT_SOURCE_TIMESTAMP,
  },
  {
    id: "builtin:archive",
    type: "archive",
    name: "Internet Archive 动漫/轻小说",
    url: "https://archive.org",
    enabled: false,
    createdAt: DEFAULT_SOURCE_TIMESTAMP,
    updatedAt: DEFAULT_SOURCE_TIMESTAMP,
  },
  {
    id: "builtin:lnovel",
    type: "lnovel",
    name: "LNovel 中文轻小说",
    url: "https://lnovel.animes.garden",
    enabled: false,
    createdAt: DEFAULT_SOURCE_TIMESTAMP,
    updatedAt: DEFAULT_SOURCE_TIMESTAMP,
  },
];
