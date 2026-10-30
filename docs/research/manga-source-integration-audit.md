# 漫画来源接入与运行边界审计

审计日期：2026-10-30。只读检查现有源码，普通匿名 HTTP 请求核查候选站点；未运行桌面 GUI、构建或修改产品代码。

## 接入所需的完整改动

| 文件 | 必要内容 |
| --- | --- |
| `src/domain/source.ts` | 新增 `SourceConfigType` 字面量。 |
| `src/infrastructure/sources/<name>-source-provider.ts` | 实现 `SourceProvider`；使用稳定作品/章节标识；提供 `restoreResource` 与 `prepareMangaDownload`。 |
| `src/infrastructure/sources/create-source-provider.ts` | import 与 factory case；factory 会将持久化资源逐条传入 `restoreResource`。 |
| `src/infrastructure/sources/default-sources.ts` | 如需内置来源，增加明确语言/用途的 preset，采用新 ID。 |
| `src/infrastructure/sources/source-catalog.ts` | `supportedTypes:["manga"]`、`mode:"manga"`、桌面限制及真实说明。 |
| `src/infrastructure/sources/source-availability.ts` | 来源管理中的能力/权限说明；不要把搜索健康状态宣称为章节下载成功。 |
| `src/infrastructure/database/source-config-repository.ts:125` | SQLite 和浏览器存储共用的类型 allowlist。遗漏会导致重启后配置报损坏。 |
| `src/infrastructure/database/legacy-storage-migration.ts:62` | 历史导入 schema 的类型 allowlist。 |
| `src/stores/source-config.ts` | 新迁移版本及升级插入逻辑。当前 v16 升级只补 `builtin:public-video`，仅改默认数组不能让已有用户看到新来源。保留用户 URL、凭据、启用状态；同一迁移只执行一次。 |
| `src/pages/SourcesPage.vue` | 来源类型菜单、名字映射、默认 URL/placeholder、URL 验证；注意切换类型不能遗留拷贝 Token。 |
| `src/tests/*-source-provider.test.ts` 等 | 搜索、精确作品、分页、去重、顺序、恢复、权限/失败；配置存储及迁移；真实章节成品另验。 |

资源列表不需扩展数据库结构：`ResourceItem.metadata` 可保存 provider、seriesId、chapterId、seriesTitle、chapterName。必须 `format:"CBZ"`、`metadata.downloadMode:"manga_cbz"`；`targetUrl` 应为公开章节页而非易过期 CDN 图片。下载准备时重新请求图片列表，避免重启后使用失效签名地址。

现有 `MediaPage.vue:435` 和 `TauriMangaChapterService` 支持通用章节描述 `{imageUrls,title,chapter,referer?,cookie?}`；下载中心记录已完成 CBZ 路径。进程退出时未完成漫画任务会恢复为失败并提示重新下载，当前不是逐页断点续传。

## 原生网络与文件权限

HTML 来源可以复用 `src/infrastructure/feeds/text-transport.ts` 的 `createTextFetcher()`，原生 `feed_text_request`（`src-tauri/src/lib.rs:1014`）已提供仅 GET 的公开文本请求。只转发 Accept / User-Agent / Referer，超时 0.5–30 秒，响应最多 16 MiB，UTF-8 解码。无需放宽 `metadata_json_request` 的固定 JSON API 域名白名单，无需新原生插件权限。

底层 `network.rs` 采用系统代理和 DNS，限制 URL 协议、嵌入凭据、本机/私网字面主机、最多五次重定向。此检查不能视为完整 DNS 重绑定防护的证明。新适配器还应校验自己的 base host、作品/章节路径和返回的图片 URL，不执行远端脚本，不读取浏览器 Cookie，不跟随内容中的 arbitrary URL。

通用图片下载限制为每章最多 1000 页、每页 50 MiB、总计 500 MiB；按页顺序下载，有有限重试与取消。临时目录受 ownership marker 约束，CBZ 原子发布，不覆盖既有文件。

**已发现的成品完整性缺口：** `download_manga_images` 当前仅检查 HTTP 成功和字节大小，未验证图片 magic/可解码性；扩展名来自 URL。HTTP 200 HTML 防盗链页可能被打入 CBZ。WeebCentral 实际首图也显示 `.png` URL/`image/png` 响应，却是可解码 JPEG。建议下载时按真实格式识别/拒绝非图像，并用真实图片扩展名入包；验收应解码每一页，不以 ZIP 可打开替代。

## 当前两个漫画来源的质量短板

### MangaDex

- `prepareMangaDownload` 使用 `chapter.data` 的 `/data/` 原始图像，并未使用压缩 `data-saver`，图像选择本身符合高质量方向。
- 语言请求固定为 zh / zh-hk / zh-tw / ja / en，中文优先排序；UI 只有通用文本筛选，没有明确语言和翻译组选择。多语言或多组同话会一起显示。
- API 先按卷/话升序请求，随后本地只用数值 chapter 排序，丢失分卷语义；资源排序把无 chapter 的条目作为 0。非数值话号、特别篇、重复话号需稳定排序策略。
- 未展示 scanlation group / 发布时间，用户难以判断翻译版本和重复更新；chapter feed 上限 2000，达到上限未提示截断。
- 已有零页/站外章节跳过、详情恢复、持久化章节 ID 后重取 @Home 地址的正确处理。健康检查只证明搜索接口。

### 拷贝漫画

- 已按章节 index 排序、每组分页、跨页 UUID 去重；分组仅保存 groupWord，未显示分组名，跨组回归排序会混淆番外与正篇。
- chapter 字段是 `index + 1`，不是从真实章节标题解析，不能用它宣称真实话号。章节可包含番外/卷版/多分组。
- URL 升级只匹配 `c800x` 后缀，并不等同于原始扫描质量。真实《脑洞学生会》第1话本次匿名返回 17 页，URL 已是 `.jpg.h1500x.webp`，没有 `words` 数组；此实例不存在需要重排 `words` 的证据。schema 支持 `words` 但实现没有使用，后续有该字段的实样需另验。
- Token 限定发送到用户配置 origin，不做跨备用站隐式转发；恢复使用 pathWord/chapterUuid，未持久化图片链接。公开章节与需登录章节提示有区别。

## 英文备用源实测

### WeebCentral：公开搜索、章节列表及真实图像通过

读取的开源适配器：[Keiyoushi WeebCentral.kt](https://github.com/keiyoushi/extensions-source/blob/main/src/en/weebcentral/src/eu/kanade/tachiyomi/extension/en/weebcentral/WeebCentral.kt)。它使用公开 HTML，站点请求约每两秒一次，避免并发扫站；此节只借鉴接口，不复制实现。

1. 匿名 GET `https://weebcentral.com/search/data?text=Frieren&limit=32&offset=0&display_mode=Full%20Display` 返回精确芙莉莲及封面，作品 URL `https://weebcentral.com/series/01J76XYDGDQERFSK333582BNBZ/Sousou-no-Frieren`。
2. `/series/01J76XYDGDQERFSK333582BNBZ/full-chapter-list` 返回 147 个章节链接，原站为降序；第1章 ID `01J76XZ3VG696B7Y02NABJ0XA3`。
3. `/chapters/01J76XZ3VG696B7Y02NABJ0XA3/images?is_prev=False&reading_style=long_strip` 返回 39 页，顺序为 001 到 039。
4. 首图 `https://official.lowee.us/manga/Sousou-no-Frieren/0001-001.png` 普通 HTTP 200，384180 字节，Pillow 读取并完整解码为 **1067×1600 JPEG**。URL 与 Content-Type 的 PNG 标示不准确。
5. 请求仅普通应用 UA + `Referer: https://weebcentral.com/`，没有 Cookie、Token、登录或验证绕过。

它适合标明英语的补充源，不能冒充中文全覆盖。系列和章节均采用稳定 ULID；公开搜索页默认32个、请求 `limit` 可能不生效；章节列表原站降序，反转后保留真实章节名和发布日期。

后续实施（同日）：已新增 `weebcentral-source-provider.ts` 和专属测试文件，复用公开文本 transport，无新增依赖或原生权限。现有 `fast-xml-parser` 按 HTML void tags 生成保序惰性树；script/style/template/noscript 不进入遍历，不执行网页脚本。22 条专属单元测试和 `npm run typecheck` 通过，覆盖真实页面结构、英文字段、精确链接/ID、恶意 URL、分页、分卷与番外顺序、去重、保存后恢复与 CDN 重新请求、验证/登录限制、空图/无效图、页数限制。

同一 provider 经 Vite `ssrLoadModule` 在 Node 直接调用真实公开 GET 的结果：搜索精确芙莉莲；完整列表147章，第1章到第147章的阅读顺序正确；第1章准备39个原始图片URL，首尾为001/039，Referer为主站。**该验证尚不等于全章 CBZ、factory/UI 接线或桌面运行验收**，须由整体验收补齐。

### MangaPill：当前不推荐自动接入

[Keiyoushi MangaPill.kt](https://github.com/keiyoushi/extensions-source/blob/main/src/en/mangapill/src/eu/kanade/tachiyomi/extension/en/mangapill/MangaPill.kt) 接口简单（`/search?q=` → `/manga/` → `/chapters/`），但本机普通匿名 GET 搜索返回 Cloudflare “Sorry, you have been blocked”。当前不能作为已验证可用来源，不应展示为默认可下载，也不应为此加入绕验证逻辑。

## 验收建议

先以两个语言明确的准确作品检索，确认作品封面/详情可开；获取全部章节而非首30/40条；首章每页下载并解码，生成完整 CBZ、核对页数和实际最小/最大尺寸。然后重新创建 provider，从保存的 resource 单独准备章节，再在现有便携程序正常重启后核对完成任务与打开文件。模拟单测证明解析/恢复/拒绝行为，真实网络和成品证据单独记录。保持 Defender 开启，遵循现有桌面运行边界。

## 浏览器 UI 回归（2026-10-30）

新增 `tests/e2e/manga-sources.spec.ts`，外站仅固定结构响应，未使用原生 GUI、CDP 或真实下载。4 个新增场景通过后完整 Playwright **21/21 通过**（1.2 分钟）：

- 三种新来源类型提供正确网站地址标签/默认值，分别启用后刷新仍保留各自类型和状态。
- MangaBZ 封面点击可进入已确认作品；45 章正序，首屏40章、尾页5章，中文/CBZ/页数标示正确；刷新保留作品/source，直接按7020读取目录，不再关键词搜索。
- WeebCentral 标示英文，三个章节阅读顺序正确；刷新后通过稳定ULID读取目录，不请求章节图片。
- 快看仅列出权限明确的两个免费章节，付费及未知权限条目均未显示；刷新保留作品/source及相同边界。

首轮新增测试4条失败已单独保留：一个是测试的 label 定位不匹配 select 的完整标签，三个是错误假设“仅浏览目录就会将所有资源行落盘”。源码实际在加入下载时才保存资源，已修正测试为验证作品/source持久化和按ID重新读取目录，没有修改产品行为。修正后的定向回归4/4通过（27.3秒），再跑完整21/21通过。首轮证据 `.work/e2e/test-results/`，定向修正回执 `.work/e2e/manga-retry.log` 和 `manga-retry-results/`，完整回执 `.work/e2e/full-manga-regression.log` 和 `full-manga-regression-results/`；成功截图在同目录下的 `mangabz-reloaded.png`、`weebcentral-reloaded.png`、`kuaikan-public-free-reloaded.png`。此回归不能作为真实站点可用率或原生CBZ成品证据。

## 最终原生验收发现的 WeebCentral 详情误判

实际桌面“搜索 Frieren → 选择作品”暴露：页面进入详情时会创建新 provider，未命中搜索实例中的系列标题缓存，需要额外请求 `/series/ID`。此前同实例搜索后准备章节的真实验证未覆盖这个细节。该详情请求实际为 HTTP200、完整作品正文、正确 Frieren title/h1；站点在页尾附加 Cloudflare **被动** JS detection `/cdn-cgi/challenge-platform/scripts/jsd/main.js`。原先针对 HTML 全文 `challenge-platform/` 的规则将正常正文误判为需验证；带或不带 slug 均有同样情况。

限定修复已经将被动脚本与主动拦截区分：继续拒绝错误标题、真正 `challenge-form` / `challenge-stage` 等容器、`_cf_chl_opt` 配置和 `orchestrate/chl_page` 主动挑战；普通带 jsd 脚本且正文完整的页面正常解析，不执行脚本。新增“完全新 provider 直接 listResources(ID) → 含被动脚本的详情”回归以及3种真正挑战拒绝回归，Weeb 专属测试26/26通过。浏览器 Weeb 详情 fixture 也加入同一被动脚本结构，避免切页时的实例变化再次漏测；相关4个UI场景再次全部通过（32.2秒），回执 `.work/e2e/weeb-jsd-regression.log` 与 `weeb-jsd-regression-results/`。此前完整21/21回归保留，没有重复跑整套。

修复后同一生产 provider 的真实 Node/Vite SSR验证：**先新建实例，完全不调用 search**，依次读取 `/series/01J76XYDGDQERFSK333582BNBZ`（HTTP200，77593字符，含被动jsd，不含主动挑战）、`full-chapter-list`（HTTP200，147章）、第1章 `images`（HTTP200，39页001至039）。新的便携程序仍需重新构建、扫描及普通桌面流程复核；这里不据此声称已验收新的原生二进制。
