import type { MediaType } from "@/domain/media";
import type { SourceConfig } from "@/domain/source";

export interface SourceCapability {
  label: string;
  supportedTypes: MediaType[];
  mode: "torrent" | "manga" | "novel" | "direct" | "index";
  setup: "none" | "optional-token" | "python";
  requiresDesktop: boolean;
  description: string;
}

/** Adapter purpose, separate from the user's live connection/operation results. */
export interface SourceUsage {
  tier: "primary" | "backup" | "index" | "custom" | "optional" | "unsupported";
  label: string;
  format: string;
  language: string;
  requirements: string[];
  description: string;
}

const capabilities: Record<string, SourceCapability> = {
  shinnku: { label: "真红小站", supportedTypes: ["visual_novel"], mode: "direct", setup: "none", requiresDesktop: true, description: "匿名检索原站文件目录，中文 Windows 归档优先；游戏本体与补丁分别标注。文件交给内置下载器，容量与分卷以原站列表为准，下载后需要自行解压。" },
  shionlib: { label: "ShionLib", supportedTypes: ["visual_novel"], mode: "index", setup: "none", requiresDesktop: false, description: "按作品查看完整资源版本、汉化组、语言、平台、容量和原站提供的文件哈希。打开准确资源页，在原站完成验证后获取下载链接；不把验证页作为文件下载。" },
  vndb_release: { label: "VNDB 官方发行参考", supportedTypes: ["visual_novel"], mode: "index", setup: "none", requiresDesktop: false, description: "从 VNDB 实时读取官方发行记录，中文完整版优先。作为官网与商店版本参考，试玩、完整版本和补丁分别标注，购买与地区条件以原站为准。" },
  public_video: { label: "公开投稿", supportedTypes: ["anime"], mode: "direct", setup: "python", requiresDesktop: true, description: "公开投稿可能是解说、片段或合集，先核对上传者、时长与集数。选择匿名可读取的实际画质，最高1080p；标题中的4K不代表下载画质。" },
  rss: { label: "RSS / Atom", supportedTypes: ["anime", "manga", "novel", "visual_novel"], mode: "torrent", setup: "none", requiresDesktop: true, description: "检索公开更新，确认作品与集数后下载；磁力/种子由内置 aria2 或可选 qBittorrent 处理，是否可完成取决于资源节点。" },
  mangadex: { label: "MangaDex", supportedTypes: ["manga"], mode: "manga", setup: "none", requiresDesktop: true, description: "多语漫画备用来源，保留原始章节页图。检索到原作不代表该语言有章节，请核对原作、同人和可下章节。" },
  mangabz: { label: "MangaBZ", supportedTypes: ["manga"], mode: "manga", setup: "none", requiresDesktop: true, description: "中文日漫按原站页序生成CBZ，保留原站页图。不同作品覆盖、更新进度和章节完整性需逐项确认。" },
  copymanga: { label: "拷贝漫画", supportedTypes: ["manga"], mode: "manga", setup: "optional-token", requiresDesktop: true, description: "中文漫画公开检索与公开章节可直接使用，按原站图片生成CBZ。实际图像尺寸取决于原站，受限章节再登录。" },
  lnovel: { label: "LNovel", supportedTypes: ["novel"], mode: "novel", setup: "none", requiresDesktop: true, description: "中文系列目录、分卷与TXT正文，TXT不含插图。首次目录可能较慢，也支持站点作品ID/链接；具体分卷和缺章情况需核对。" },
  archive: { label: "Internet Archive", supportedTypes: ["anime", "novel"], mode: "direct", setup: "none", requiresDesktop: true, description: "公开档案中的视频或书籍文件直链，语言和格式依发布者而异。检索会混入同名内容、片段或测试样片，需核对内容与时长。" },
  kungal: { label: "鲲 Galgame", supportedTypes: ["visual_novel"], mode: "index", setup: "none", requiresDesktop: false, description: "通过公开接口匿名检索Galgame作品和资源目录。条目打开原站分享页面；站外分享页不等于文件直链，链接和访问权限仍需在原站核对。" },
  jmcomic: { label: "JMComic", supportedTypes: ["manga"], mode: "manga", setup: "python", requiresDesktop: true, description: "需要桌面端 Python 与 jmcomic 包。" },
  github_release: { label: "GitHub Releases", supportedTypes: ["anime", "manga", "novel", "visual_novel"], mode: "direct", setup: "none", requiresDesktop: true, description: "软件/公开项目附件，不会自动提供同名影视内容。" },
};

function rssKind(configOrType: SourceConfig | string): "mikan" | "acgnx" | "anime" | "custom" | undefined {
  const type = typeof configOrType === "string" ? configOrType : configOrType.type as string;
  if (type === "nyaa" || type === "anime_garden") return "anime";
  if (type !== "rss") return undefined;
  if (typeof configOrType === "string") return "custom";
  try {
    const host = new URL(configOrType.url).hostname.toLowerCase().replace(/\.$/, "");
    const domain = (name: string) => host === name || host.endsWith("." + name);
    if (domain("mikanani.me")) return "mikan";
    if (domain("acgnx.se")) return "acgnx";
    if (domain("nyaa.si") || domain("nyaa.land") || domain("anime.garden")) return "anime";
  } catch { /* Keep custom addresses visible for correction. */ }
  return "custom";
}

export function getSourceCapability(configOrType: SourceConfig | string): SourceCapability {
  const type = typeof configOrType === "string" ? configOrType : configOrType.type;
  const key = type === "nyaa" || type === "anime_garden" ? "rss" : type;
  const result = Object.prototype.hasOwnProperty.call(capabilities, key) ? capabilities[key] : undefined;
  const feed = rssKind(configOrType);
  if (result === capabilities.rss && feed && feed !== "custom") {
    return { ...result, supportedTypes: ["anime"], ...(feed === "mikan" ? { label: "蜜柑计划" } : feed === "acgnx" ? { label: "AcgnX" } : {}) };
  }
  return result ?? { label: "未支持的来源", supportedTypes: [], mode: "index", setup: "none", requiresDesktop: false, description: "此来源类型尚未接入。" };
}

export function sourceSupportsType(config: SourceConfig, type: MediaType): boolean {
  return getSourceCapability(config).supportedTypes.includes(type);
}

/** Filter the view only; retain every custom/unsupported configuration in All. */
export function filterSourcesByType(configs: readonly SourceConfig[], type?: MediaType): SourceConfig[] {
  return configs.filter((config) => type === undefined || sourceSupportsType(config, type));
}

/** Smaller numbers sort first. This is a purpose preference, never a health claim. */
export function getSourcePriority(config: SourceConfig, mediaType?: MediaType): number {
  if (!getSourceCapability(config).supportedTypes.length || mediaType && !sourceSupportsType(config, mediaType)) return 1000;
  const feed = rssKind(config);
  if (feed) return feed === "mikan" ? 10 : feed === "acgnx" ? 20 : feed === "anime" ? 30 : 40;
  const priorities: Record<string, number> = { mangabz: 10, copymanga: 20, lnovel: 10, shinnku: 5, shionlib: 10, kungal: 20, vndb_release: 100, mangadex: 60, public_video: 70, archive: 80, jmcomic: 90, github_release: 300 };
  return priorities[config.type] ?? 1000;
}

export function getSourceUsage(config: SourceConfig): SourceUsage {
  const capability = getSourceCapability(config);
  const requirements = capability.requiresDesktop ? ["桌面端"] : [];
  if (capability.setup === "python") requirements.push(config.type === "public_video" ? "Python · yt-dlp · FFmpeg" : "Python · jmcomic");
  if (config.type === "copymanga") requirements.push(config.token?.trim() ? "Token已保存，权限需原站验证" : "公开章节无需Token，受限时再登录");
  if (config.type === "kungal") requirements.push("公开检索无需账号；部分外链需原站登录或访问权限");
  const common = { requirements, description: capability.description };
  const feed = rssKind(config);
  if (feed) return { ...common, tier: feed === "custom" ? "custom" : "primary", label: feed === "custom" ? "自定义订阅" : "动画主源", format: feed === "custom" ? "附件 / 磁力 / Torrent" : "磁力 / Torrent", language: feed === "custom" ? "语言由订阅内容决定" : "字幕组发布 · 核对字幕语言" };
  switch (config.type) {
    case "shinnku": return { ...common, tier: "primary", label: "游戏文件", format: "HTTP 游戏归档", language: "中文目录优先 · 版本依原站标注" };
    case "shionlib": return { ...common, tier: "index", label: "多版本资源库", format: "完整资源页 · 原站验证", language: "汉化版本 / 语言 / 平台可选" };
    case "mangabz": return { ...common, tier: "primary", label: "中文漫画", format: "原站页图 · CBZ", language: "中文" };
    case "copymanga": return { ...common, tier: "primary", label: "中文漫画", format: "原站图片 · CBZ", language: "中文" };
    case "lnovel": return { ...common, tier: "primary", label: "中文轻小说", format: "分卷正文 · TXT", language: "中文" };
    case "mangadex": return { ...common, tier: "backup", label: "多语备用", format: "原始页图 · CBZ", language: "多语 · 章节依作品而异" };
    case "public_video": return { ...common, tier: "backup", label: "公开投稿备用", format: "公开投稿 · MP4", language: "语言依投稿而异" };
    case "archive": return { ...common, tier: "backup", label: "公开档案备用", format: "档案文件直链", language: "多语 · 格式依附件而异" };
    case "kungal": return { ...common, tier: "index", label: "Galgame索引", format: "站外资源索引", language: "中文社区 · 外链需核对" };
    case "vndb_release": return { ...common, tier: "index", label: "官方发行", format: "官网 / 商店入口", language: "中文优先 · 原版 / 试玩 / 补丁" };
    case "jmcomic": return { ...common, tier: "optional", label: "可选本地桥接", format: "章节图片 · CBZ", language: "依原站章节而异" };
    case "github_release": return { ...common, tier: "optional", label: "项目附件", format: "Release文件直链", language: "依项目附件而异" };
    default: return { ...common, tier: "unsupported", label: "待确认类型", format: "未接入适配器", language: "未确定" };
  }
}
