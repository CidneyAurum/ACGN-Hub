# ACGN Hub 私人搜索下载工具

## AI 可执行产品与技术方案书

版本：1.0  
目标平台：Windows 10/11  
使用范围：私人、本地使用  
默认语言：简体中文  
项目性质：本地桌面应用，不建设公共资源服务

---

## 1. 文档用途

本文件用于直接交给编码 AI，作为项目初始化、架构设计、开发拆分、接口约束和验收依据。

编码 AI 必须按照阶段顺序执行。除非用户明确要求，不得一次性实现全部功能，不得擅自扩展成公共内容平台，也不得自行内置未经授权的资源站点。

每个阶段必须完成以下闭环：

1. 阅读当前仓库和适用的 `AGENTS.md`。
2. 输出本阶段实施计划。
3. 实现最小范围变更。
4. 增加必要测试。
5. 运行类型检查、单元测试和构建。
6. 报告已完成内容、已知限制及下一阶段入口。

---

## 2. 产品目标

开发一个本地运行的 ACGN 内容管理工具，统一处理动画、漫画、小说和 Galgame：

```text
搜索作品
→ 获取标准元数据
→ 搜索一个或多个用户配置的资源来源
→ 合并、去重和筛选结果
→ 用户选择资源并点击下载
→ 调用现成下载引擎
→ 校验、重命名和移动文件
→ 加入本地媒体库
→ 播放、阅读或启动
```

### 2.1 第一优先级

- 能搜索 Bangumi 动画条目。
- 能搜索 VNDB Galgame 条目。
- 能添加 HTTP、Magnet 和 Torrent 下载任务。
- 能显示下载进度、速度和错误。
- 能把下载完成的文件移动到作品目录。
- 能记录本地作品、资源和下载历史。

### 2.2 第二优先级

- RSS 资源搜索与自动追番。
- 动画文件集数识别和自动命名。
- GitHub Releases、WebDAV 和本地目录来源。
- 漫画章节图片下载及 CBZ 打包。
- Galgame 本地安装扫描、存档备份和补丁管理。

### 2.3 后续能力

- Legado 风格小说书源。
- EPUB 生成。
- 外部来源插件系统。
- 来源健康检查与可视化调试器。
- 多来源标题自动匹配。

---

## 3. 非目标

第一版不得实现：

- 用户注册、登录和云端账户。
- 公共资源站索引服务器。
- 文件中转、视频转码或 CDN。
- 支付、订阅和广告。
- 绕过验证码、登录、付费墙或 DRM。
- 自动执行未知 EXE、BAT、PS1 或安装程序。
- 自动从未知地址安装插件。
- 移动端客户端。
- 多人共享媒体库。

---

## 4. 合规与安全边界

程序可处理用户有权访问的公开地址、自有存储、官方资源、开源作品、合法 RSS、Torrent 或用户手动输入的链接。

程序本体不得内置盗版资源站、破解工具、绕过验证逻辑、第三方账号凭据或固定的未经授权资源目录。

第三方来源适配器必须由用户主动安装和启用，并显示：

- 插件名称和版本。
- 请求的域名。
- 是否需要 Cookie。
- 支持的内容类型。
- 最近成功时间。
- 风险提示。

安全要求：

- aria2 RPC 默认仅监听 `127.0.0.1`。
- RPC Secret 使用随机值并保存在系统安全存储或受限配置中。
- 日志不得输出 Cookie、Token、Authorization 或完整签名 URL。
- 所有目标路径必须标准化并防止路径穿越。
- 解压前检查条目数量、声明体积和实际体积。
- 对可执行文件显示来源、哈希和明确确认框。
- 下载未完成文件必须停留在临时目录。
- 文件冲突默认保留两份或要求用户确认，不静默覆盖。

---

## 5. 技术选型

### 5.1 桌面应用

- Tauri 2
- Vue 3
- TypeScript
- Vite
- Pinia
- Vue Router
- Naive UI
- Vitest
- Playwright，仅用于应用端到端测试或用户配置的动态网页来源

### 5.2 本地能力

- Rust/Tauri Commands：进程、文件系统、哈希、移动和安全解压
- SQLite：本地持久化
- SQLx 或 Tauri 兼容的 SQLite 层
- Zod：TypeScript 运行时数据校验
- Pino 或轻量结构化日志库

### 5.3 下载引擎

- aria2：HTTP、HTTPS、FTP、Metalink，必要时处理 Torrent
- qBittorrent：Magnet、Torrent、RSS、文件选择和长期任务
- 系统启动器：Steam、浏览器、官方客户端等外部协议

### 5.4 外部元数据

- Bangumi API：动画、漫画、书籍、游戏、角色和中文元数据
- VNDB Kana API：视觉小说、版本、角色、语言和平台
- AniList GraphQL：后续作为动画和漫画国际数据补充
- MangaDex API：后续作为漫画元数据和章节来源之一

---

## 6. 参考 GitHub 项目

AI 可以阅读这些项目学习架构，但必须遵守其许可证，不得直接复制不兼容许可证的代码。

### 6.1 下载与任务管理

- aria2：<https://github.com/aria2/aria2>
- qBittorrent：<https://github.com/qbittorrent/qBittorrent>
- Motrix：<https://github.com/agalwood/Motrix>
- gallery-dl：<https://github.com/mikf/gallery-dl>
- yt-dlp：<https://github.com/yt-dlp/yt-dlp>

### 6.2 动画

- Animeko：<https://github.com/open-ani/animeko>
- AutoBangumi：<https://github.com/EstrellaXD/Auto_Bangumi>
- Aniyomi：<https://github.com/aniyomiorg/aniyomi>
- Consumet：<https://github.com/consumet/api.consumet.org>
- ani-cli：<https://github.com/pystardust/ani-cli>

### 6.3 漫画

- Mihon：<https://github.com/mihonapp/mihon>
- Keiyoushi Extensions：<https://github.com/keiyoushi/extensions-source>
- MangaDex API 文档：<https://api.mangadex.org/docs/>

### 6.4 小说

- Legado：<https://github.com/gedoor/legado>
- Calibre：<https://github.com/kovidgoyal/calibre>
- Crawlee：<https://github.com/apify/crawlee>
- Scrapy：<https://github.com/scrapy/scrapy>
- Playwright：<https://github.com/microsoft/playwright>

### 6.5 Galgame 与游戏管理

- VNDB Kana API：<https://api.vndb.org/kana>
- Lutris：<https://github.com/lutris/lutris>
- Heroic Games Launcher：<https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher>
- Ren'Py：<https://github.com/renpy/renpy>

### 6.6 元数据及映射

- Bangumi API：<https://github.com/bangumi/api>
- AniList 文档：<https://docs.anilist.co/>
- bangumi-data：<https://github.com/bangumi-data/bangumi-data>
- anime-offline-database：<https://github.com/manami-project/anime-offline-database>
- trace.moe：<https://github.com/soruly/trace.moe>

---

## 7. 系统架构

```text
Desktop UI
├── Search                 统一搜索
├── Media Details          作品详情
├── Resources              资源列表
├── Downloads              下载中心
├── Library                本地媒体库
├── Sources                来源管理
└── Settings               设置

Application Core
├── Metadata Service       元数据聚合
├── Source Service         来源调用
├── Matching Service       标题匹配和去重
├── Download Manager       下载任务调度
├── Organizer              文件整理
├── Library Scanner        本地扫描
└── Event Bus              状态事件

Infrastructure
├── SQLite
├── aria2 RPC Client
├── qBittorrent API Client
├── File System Gateway
├── Process Gateway
└── Secure Storage
```

依赖方向必须保持：

```text
UI → Application Core → Domain Interfaces ← Infrastructure
```

业务层不得直接调用 `fetch`、SQLite、Tauri Command 或 Node 文件系统。所有外部能力通过接口注入。

---

## 8. 推荐目录结构

```text
acgn-hub/
├── src/
│   ├── app/
│   │   ├── router/
│   │   └── stores/
│   ├── components/
│   ├── pages/
│   │   ├── SearchPage.vue
│   │   ├── MediaPage.vue
│   │   ├── DownloadsPage.vue
│   │   ├── LibraryPage.vue
│   │   ├── SourcesPage.vue
│   │   └── SettingsPage.vue
│   ├── domain/
│   │   ├── media.ts
│   │   ├── resource.ts
│   │   ├── download.ts
│   │   └── source.ts
│   ├── application/
│   │   ├── search-service.ts
│   │   ├── matching-service.ts
│   │   ├── download-manager.ts
│   │   ├── organizer.ts
│   │   └── library-service.ts
│   ├── infrastructure/
│   │   ├── database/
│   │   ├── metadata/
│   │   │   ├── bangumi-provider.ts
│   │   │   └── vndb-provider.ts
│   │   ├── sources/
│   │   │   ├── direct-link-source.ts
│   │   │   ├── rss-source.ts
│   │   │   └── github-release-source.ts
│   │   └── downloads/
│   │       ├── aria2-client.ts
│   │       └── qbittorrent-client.ts
│   ├── shared/
│   └── tests/
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   ├── filesystem/
│   │   ├── process/
│   │   └── security/
│   └── tauri.conf.json
├── migrations/
├── docs/
├── package.json
└── README.md
```

---

## 9. 领域模型

```ts
export type MediaType =
  | "anime"
  | "manga"
  | "novel"
  | "visual_novel";

export interface ExternalId {
  provider: string;
  value: string;
}

export interface Media {
  id: string;
  type: MediaType;
  title: string;
  originalTitle?: string;
  aliases: string[];
  description?: string;
  coverUrl?: string;
  releaseYear?: number;
  externalIds: ExternalId[];
  metadata: Record<string, unknown>;
}

export interface ResourceItem {
  id: string;
  sourceId: string;
  sourceItemId: string;
  mediaId?: string;
  title: string;
  episode?: number;
  chapter?: number;
  volume?: number;
  language?: string;
  resolution?: string;
  codec?: string;
  format?: string;
  sizeBytes?: number;
  publishedAt?: string;
}

export type DownloadProtocol =
  | "http"
  | "torrent"
  | "magnet"
  | "chapter"
  | "external";

export interface DownloadTarget {
  protocol: DownloadProtocol;
  url?: string;
  urls?: string[];
  filename?: string;
  headers?: Record<string, string>;
  expiresAt?: number;
  checksum?: {
    algorithm: "sha256" | "sha1" | "md5";
    value: string;
  };
}
```

不得在数据库持久保存临时 Cookie、短期签名请求头或敏感 Token。必要时保存引用键，并从安全存储按需读取。

---

## 10. 元数据接口

```ts
export interface MetadataSearchQuery {
  keyword: string;
  type?: MediaType;
  page?: number;
}

export interface MetadataProvider {
  id: string;
  supportedTypes: MediaType[];

  search(query: MetadataSearchQuery): Promise<Media[]>;
  getById(externalId: string): Promise<Media>;
}
```

### Bangumi Provider

负责：

- 动画、漫画、小说和游戏的中文元数据。
- 标题、别名、封面、简介和外部关系。
- 必须设置符合 Bangumi 要求的 User-Agent。
- 对 429、5xx 和网络失败实施指数退避。

### VNDB Provider

负责：

- Visual Novel 搜索。
- 标题、别名、平台、语言、发行版本、角色和制作人员。
- 使用 Kana HTTPS API。
- 实施请求速率限制和本地缓存。

---

## 11. 来源接口

```ts
export interface SourceSearchQuery {
  keyword: string;
  aliases: string[];
  mediaType: MediaType;
  page?: number;
}

export interface SourceSearchResult {
  sourceId: string;
  sourceItemId: string;
  title: string;
  coverUrl?: string;
  releaseYear?: number;
  raw?: Record<string, unknown>;
}

export interface SourceProvider {
  id: string;
  name: string;
  supportedTypes: MediaType[];

  search(query: SourceSearchQuery): Promise<SourceSearchResult[]>;
  listResources(sourceItemId: string): Promise<ResourceItem[]>;
  resolve(resourceId: string): Promise<DownloadTarget>;
  healthCheck(): Promise<SourceHealth>;
}
```

`resolve()` 必须在用户点击下载时调用，避免短期下载链接提前失效。

### 第一版来源

1. Direct Link Source：用户粘贴 HTTP、Magnet 或 Torrent URL。
2. Generic RSS Source：读取用户配置 RSS，解析标题和下载链接。
3. GitHub Releases Source：读取公开仓库 Release 资源。
4. Local Folder Source：扫描用户本地目录并匹配媒体。

### 第二版来源

1. WebDAV Source。
2. Manga Chapter Source。
3. Generic HTML Source。
4. Playwright Dynamic Source。
5. Legado 风格 Novel Source。

---

## 12. 下载引擎接口

```ts
export interface DownloadOptions {
  directory: string;
  filename?: string;
  category?: string;
  tags?: string[];
}

export interface EngineTask {
  engineId: string;
  engineTaskId: string;
}

export interface DownloadStatus {
  state:
    | "queued"
    | "downloading"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";
  totalBytes: number;
  completedBytes: number;
  speedBytesPerSecond: number;
  files: string[];
  error?: string;
}

export interface DownloadEngine {
  id: string;
  supportedProtocols: DownloadProtocol[];

  add(target: DownloadTarget, options: DownloadOptions): Promise<EngineTask>;
  pause(engineTaskId: string): Promise<void>;
  resume(engineTaskId: string): Promise<void>;
  cancel(engineTaskId: string, deleteFiles: boolean): Promise<void>;
  getStatus(engineTaskId: string): Promise<DownloadStatus>;
}
```

调度规则：

```text
http       → aria2
magnet     → qBittorrent
torrent    → qBittorrent
chapter    → 内置章节下载器
external   → 系统启动器
```

下载引擎不可直接修改本地媒体库。完成事件由 Download Manager 发出，Organizer 接收并处理。

---

## 13. 搜索与匹配

搜索顺序：

1. 元数据服务查询标准作品。
2. 用户选择或确认目标作品。
3. 将标题、原名和别名传递给资源来源。
4. 并行执行启用的来源。
5. 标准化资源标题。
6. 合并、去重和排序。

标题标准化：

- Unicode NFKC。
- 英文字母小写化。
- 全角半角转换。
- 去除无意义标点和多余空格。
- 保留季数、集数、卷数和版本号。
- 不得仅依靠模糊匹配自动下载。

自动匹配优先级：

1. 相同外部数据库 ID。
2. 用户保存的人工映射。
3. 标准标题完全相同。
4. 别名完全相同且年份一致。
5. 模糊匹配仅作为候选，必须用户确认。

---

## 14. 文件整理

下载目录分为：

```text
ACGN/
├── Incoming/
├── Library/
│   ├── Anime/
│   ├── Manga/
│   ├── Novels/
│   └── VisualNovels/
└── Backups/
```

动画命名：

```text
{Title}/Season {season}/{Title} S{season:00}E{episode:00} [{resolution}][{language}].{ext}
```

漫画命名：

```text
{Title}/{Title} - 第{chapter}话.cbz
```

小说命名：

```text
{Title}/{Title} 第{volume}卷.epub
```

Galgame目录：

```text
{Title}/
├── releases/
├── patches/
├── saves/
├── backups/
└── launch.json
```

Organizer 必须具备幂等性：同一个已完成任务重复触发，不得重复移动或覆盖文件。

---

## 15. 数据库结构

至少实现以下迁移：

```sql
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  original_title TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  cover_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE external_ids (
  media_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  PRIMARY KEY (provider, external_id),
  FOREIGN KEY (media_id) REFERENCES media(id)
);

CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  media_id TEXT,
  title TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (source_id, source_item_id)
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  media_id TEXT,
  title TEXT NOT NULL,
  protocol TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE download_tasks (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_task_id TEXT,
  media_id TEXT,
  resource_id TEXT,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  temp_path TEXT,
  final_path TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE local_files (
  id TEXT PRIMARY KEY,
  media_id TEXT,
  path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);

CREATE TABLE source_configs (
  source_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
```

所有数据库写操作必须在事务中处理需要保持一致性的多表更新。

---

## 16. 页面需求

### 16.1 搜索页

- 搜索框。
- 内容类型筛选。
- 元数据来源筛选。
- 搜索状态和错误提示。
- 作品卡片：封面、标题、原名、年份和类型。

### 16.2 作品详情页

- 作品元数据。
- 别名和外部 ID。
- 来源启用选择。
- 资源刷新按钮。
- 资源表格。
- 分辨率、语言、集数和大小筛选。
- 单项下载和批量下载。

### 16.3 下载中心

- 任务状态。
- 进度、速度、大小和剩余时间。
- 暂停、继续、重试和取消。
- 打开临时目录或最终目录。
- 显示下载引擎和来源。
- 删除任务和删除文件必须分别操作。

### 16.4 本地媒体库

- 按动画、漫画、小说和 Galgame 分类。
- 本地文件扫描。
- 打开文件位置。
- 使用系统默认应用打开。
- 手动重新匹配元数据。
- 显示缺失、重复和未匹配文件。

### 16.5 设置页

- 媒体库根目录。
- aria2 路径、地址和 RPC Secret。
- qBittorrent 地址和认证。
- 默认下载引擎。
- 并发数、速度限制和轮询间隔。
- 来源配置。
- 日志目录和诊断导出。

---

## 17. 开发阶段与验收

### 阶段 0：项目骨架

任务：

- 初始化 Tauri 2、Vue 3 和 TypeScript。
- 配置 Router、Pinia、Naive UI、Vitest。
- 建立领域层、应用层和基础设施层目录。
- 增加 ESLint/格式化，但只使用项目已有或主流最小配置。
- 增加基础 CI，可选。

验收：

- `npm run dev` 可以启动。
- `npm run build` 成功。
- `npm run test` 成功。
- 首页可以导航到六个主要页面。

### 阶段 1：下载核心

任务：

- 实现下载领域模型。
- 实现 aria2 JSON-RPC 客户端。
- 实现 qBittorrent Web API 客户端。
- 实现手动链接添加界面。
- 实现下载任务持久化和恢复。
- 实现下载状态轮询。

验收：

- HTTP 测试文件可通过 aria2 保存到指定目录。
- Magnet/Torrent 可发送给 qBittorrent。
- 关闭应用后重新打开仍能显示任务。
- 暂停、继续和取消行为正确。
- 错误不会导致界面崩溃。

### 阶段 2：元数据与作品库

任务：

- 实现 Bangumi Provider。
- 实现 VNDB Provider。
- 实现作品搜索、详情和本地保存。
- 实现本地缓存和请求限速。

验收：

- 可搜索至少一个动画和一个 Visual Novel。
- 可进入详情页。
- 重启后已收藏作品仍存在。
- 网络失败有明确提示。

### 阶段 3：RSS和一键下载

任务：

- 实现通用 RSS Source。
- 解析标题、发布时间和下载地址。
- 支持 Magnet、Torrent URL 和 HTTP URL。
- 在作品详情页显示资源。
- 一键创建下载任务。

验收：

- 用户可添加合法 RSS 地址。
- RSS 条目可与作品手动关联。
- 点击下载后进入下载中心。
- 重复资源不会重复创建任务。

### 阶段 4：自动整理

任务：

- 实现 Incoming 和 Library 目录。
- 实现文件名安全处理。
- 实现下载完成事件。
- 实现动画集数识别和手动修正。
- 实现幂等移动及冲突处理。

验收：

- 完成文件能从 Incoming 移至作品目录。
- 重复触发不会生成重复文件。
- 无法识别的文件进入 `Unmatched`。
- 不静默覆盖已有文件。

### 阶段 5：漫画

任务：

- 实现 Manga Source 接口。
- 实现章节图片队列。
- 支持 Header、Referer、Cookie引用和重试。
- 实现 CBZ 生成和页码检查。

验收：

- 测试来源的公开章节可保存为 CBZ。
- 图片缺失时任务标记失败或部分完成。
- CBZ 可被常见阅读器打开。

### 阶段 6：Galgame 本地管理

任务：

- 扩展 VNDB 元数据。
- 实现 GitHub Releases Source。
- 实现本地安装目录扫描。
- 识别 Ren'Py、Kirikiri和Unity基本特征。
- 实现启动配置和存档备份。

验收：

- 可搜索 VNDB 游戏。
- 可下载测试用开源视觉小说 Release。
- 可记录本地安装路径并启动。
- 存档备份不会覆盖旧备份。

### 阶段 7：来源插件化

任务：

- 定义插件 Manifest。
- 实现域名权限和配置校验。
- 实现插件启用、停用和健康检查。
- 实现解析器日志和失败快照。

验收：

- 损坏插件不会导致主程序崩溃。
- 插件不能请求未声明域名。
- 用户可以禁用异常来源。

---

## 18. 测试策略

### 单元测试

- 标题标准化。
- 集数、季数和卷数解析。
- 下载引擎选择。
- 文件名安全处理。
- 目标路径计算。
- 去重逻辑。
- RSS 解析。

### 集成测试

- 使用 aria2 测试实例下载本地 HTTP 测试文件。
- 使用 qBittorrent 测试实例验证添加任务请求。
- 使用固定 HTML/RSS Fixture 测试来源解析。
- 使用临时目录验证 Organizer。
- 使用测试 SQLite 验证迁移和事务。

### 端到端测试

至少覆盖：

```text
搜索作品
→ 保存作品
→ 添加测试资源
→ 创建下载任务
→ 模拟完成
→ 整理入库
→ 本地库显示文件
```

测试不得依赖不稳定的真实资源站。所有解析测试必须使用仓库内 Fixture；真实 API 只保留可选的手动冒烟测试。

---

## 19. AI 开发约束

编码 AI 必须遵守：

- 不重新实现 HTTP 或 BT 协议。
- 不把全部模块写进单个文件。
- 不在 Vue 组件中直接调用下载引擎。
- 不用字符串拼接生成不可信文件路径。
- 不把 Cookie、Token 或密码提交到仓库。
- 不硬编码本机绝对路径。
- 不在没有迁移的情况下直接修改数据库结构。
- 不为未来功能提前设计复杂微服务。
- 不擅自加入 Docker、云数据库或公共后端。
- 不修复与当前阶段无关的问题。
- 所有外部响应必须经过运行时校验。
- 所有网络请求必须有超时、错误映射和取消能力。
- 所有危险文件操作必须可恢复或由用户确认。

---

## 20. 第一轮交给 AI 的执行提示词

将以下内容与本方案书一起交给编码 AI：

```text
请阅读《ACGN Hub AI 可执行产品与技术方案书》，先完成阶段0和阶段1，不要实现后续阶段。

要求：
1. 先检查当前目录和所有适用的 AGENTS.md。
2. 输出简洁实施计划后再修改文件。
3. 使用 Tauri 2 + Vue 3 + TypeScript。
4. 建立清晰的 domain/application/infrastructure 分层。
5. 下载层只实现 aria2 JSON-RPC 和 qBittorrent Web API 客户端。
6. 提供手动添加 HTTP、Magnet、Torrent URL 的界面。
7. 使用 SQLite 保存下载任务。
8. 不实现任何资源站爬虫，不实现插件系统，不实现媒体整理。
9. 为下载引擎选择、任务状态转换和URL校验增加单元测试。
10. 完成后运行测试、类型检查和构建，报告结果。

如果仓库为空，请初始化项目；如果已有项目，请保持现有技术栈和代码风格，并只做本阶段范围内的修改。
```

---

## 21. 第二轮交给 AI 的执行提示词

阶段 0 和阶段 1 验收通过后使用：

```text
请按照方案书完成阶段2和阶段3：Bangumi、VNDB、作品库、通用RSS来源和一键下载。

要求：
1. 不改变已稳定的下载引擎接口。
2. Bangumi和VNDB必须分别实现MetadataProvider。
3. RSS必须实现SourceProvider。
4. 外部响应使用Zod校验。
5. 增加本地缓存、超时、速率限制和错误提示。
6. 资源解析只支持HTTP、Magnet和Torrent URL。
7. 用户必须先确认作品与RSS条目的匹配关系。
8. 增加Fixture测试，不让自动测试依赖真实网络。
9. 运行测试、类型检查和构建。
```

---

## 22. 完成定义

项目第一版完成需同时满足：

- Windows 上可安装和启动。
- Bangumi 和 VNDB 搜索可用。
- 用户可配置 RSS 或手动输入资源链接。
- HTTP、Magnet 和 Torrent 可一键进入下载任务。
- 下载进度、速度、暂停、继续和错误可见。
- 下载完成文件可安全整理到本地媒体库。
- 重启应用后任务、作品和本地文件索引不丢失。
- 所有路径和敏感配置符合安全要求。
- 测试、类型检查和生产构建通过。
- README 包含安装、配置、启动和故障排查说明。

---

## 23. 推荐实施结论

第一版不要同时实现动画、漫画、小说和 Galgame 的全部来源。应先构建稳定的公共底座：

```text
Tauri桌面端
+ SQLite
+ Bangumi/VNDB元数据
+ RSS/手动链接
+ aria2/qBittorrent
+ 下载任务中心
+ 本地整理器
```

底座稳定后，再分别借鉴 Animeko、AutoBangumi、Mihon、Keiyoushi、Legado、Lutris 和 Heroic 的结构扩展内容类型。资源来源始终通过统一接口接入，任何来源失效都不应影响下载内核和本地媒体库。
