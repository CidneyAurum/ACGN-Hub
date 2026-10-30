import type { SourceConfig } from "@/domain/source";

/** Describes adapter capabilities; this is deliberately not a health result. */
export function sourceDescription(config: SourceConfig): string {
  switch (config.type as string) {
    case "public_video": return "公开投稿搜索与 MP4 下载；先核对时长、上传者和集数。仅游客可访问的视频，不读取浏览器账号或 Cookie。";
    case "nyaa":
    case "anime_garden": return "旧版动漫来源配置，现按 RSS / Atom 读取。请先确认地址是可读取的订阅链接，再检查连接。";
    case "rss": return "读取 RSS / Atom 附件；需手动关联作品。直链、磁力及种子以实际条目为准。";
    case "github_release": return "公开仓库的 Release 附件，适合项目资源；不会自动包含同名动漫作品。";
    case "mangadex": return "漫画作品与章节检索；按中文优先显示，桌面端下载为 CBZ。章节图片在下载时检查。";
    case "mangabz": return "中文日漫补充；按原站页序下载为CBZ，使用原站图片。验证码、权限或缺页会明确停止。";
    case "copymanga": return config.token?.trim()
      ? "已保存登录凭据；具体 Token 有效性和章节权限仍需由站点验证。桌面端生成 CBZ。"
      : "支持公开检索；部分章节需要账号登录或 Token。桌面端生成 CBZ。";
    case "lnovel": return "中文轻小说目录、分卷与 TXT。首次加载目录最多等候 35 秒，之后复用缓存；也可用站点作品 ID / 链接直接检索。";
    case "archive": return "Internet Archive 公开条目；附件格式及可访问性取决于原始发布者。";
    case "kungal": return "Galgame 资源索引；站外资源可能需要单独访问，网页链接不等同于文件直链。";
    case "jmcomic": return "可选本地 Python 桥接，需要桌面端和已安装的 jmcomic；生成 CBZ。";
    default: return "自定义来源；启用前请检查地址、来源类型和连接状态。";
  }
}
