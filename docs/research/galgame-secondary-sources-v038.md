# Galgame 第二资源源复核（2026-10-31）

本次只读检查了 TouchGal 与 Shionlib；失落的小站就是 `shinnku.com`，由另一项检查负责。浏览工具返回 503，改用来源官方网站的普通匿名 HTTPS 和官方 GitHub 仓库。没有读取浏览器 Cookie、解验证码、生成下载令牌、下载完整游戏或运行下载文件。

## 可实际增加覆盖的来源：Shionlib

- [官方站](https://shionlib.com/zh)
- [官方源码](https://github.com/Ringyuki/shionlib)
- [官方开放接口说明](https://github.com/Ringyuki/shionlib/blob/main/apps/web/app/features/docs/content/zh/dev/open-api.mdx)
- [官方下载说明](https://github.com/Ringyuki/shionlib/blob/main/apps/web/app/features/docs/content/zh/guides/download-games.mdx)
- [官方 API 合约](https://github.com/Ringyuki/shionlib/blob/main/apps/api/openapi/openapi.json)

这是独立的社区游戏文件归档，实际公开目录含游戏本体、翻译版本、文件大小和哈希，不是只有商店、试玩或磁力条目。仓库本轮读取时最后更新时间为 2026-10-30，AGPL-3.0；接入应依据公开 HTTP 合约自行编写适配器，不直接搬运其实现。

### 匿名接口

```text
GET https://shionlib.com/api/search?q=ATRI&page=1&pageSize=10&resources=required
GET https://shionlib.com/api/search?q=vid%3Av27448&page=1&pageSize=10&resources=required
GET https://shionlib.com/api/game/37/download-source
GET https://shionlib.com/api/game/download-source/2561
```

上述搜索和作品资源列表已真实返回 200 JSON，无需账户或 API Key。搜索结果位于 `data.games.items`，总数位于 `data.games.total`。每项含 `id`、`title_jp`、`title_zh`、`title_en`、`aliases`、封面及 `resources` 摘要；资源列表是 `data` 数组。

`resources=required` 排除没有资源的作品。上游搜索仍会返回近似词：ATRI 首屏还有其他名称含有类似片段的作品，千恋万花返回总数 44，不能把全部结果都当目标作品。应用已有 VNDB ID 时优先使用 `q=vid:v27448`（ATRI）或 `q=v4`（CLANNAD），这两项实测均只返回 1 部准确作品。否则应使用标题、别名再次匹配，再读取有限数量资源列表。

### 本轮实际获取到的中文 Windows 本体目录

| 作品 | 作品 / 资源 / 文件 ID | 文件与大小（字节） | 版本字段 |
| --- | --- | --- | --- |
| CLANNAD | 331 / 2835 / 2826 | `[Key] CLANNAD HD Edition.zip`，4,220,542,579 | `win`；`zh,en,jp`；`official`；`portable` |
| ATRI | 37 / 2561 / 2552 | Steam 版 RAR，3,928,959,761 | `win`；`zh,en,jp`；`official`；`portable` |
| Summer Pockets | 6 / 1352 / 1343 | `[220314][Key] Summer Pockets.7z`，5,026,119,504 | `win`；`zh`；`official`；`portable` |
| Summer Pockets REFLECTION BLUE | 1800 / 2446 / 2437 | 官方中文 7z，9,740,124,223 | `win`；`zh,en,jp`；`official`；`portable` |
| Summer Pockets REFLECTION BLUE | 1800 / 2447 / 2438 | 夏日纯臻汉化组 ZIP，9,286,523,115 | `win`；`zh`；`group`；附既有扫描标记 |
| Summer Pockets REFLECTION BLUE | 1800 / 2448 / 2439 | 枫笛汉化组 ZIP，8,234,850,620 | `win`；`zh`；`group`；附既有扫描标记 |
| 千恋＊万花 | 708 / 440 / 433 | 城彩学园×落樱汉化 7z，9,751,416,271 | `win`；`zh`；`group` |
| 千恋＊万花 | 708 / 1240 / 1231 | 官方中文 7z，11,215,819,022 | `win`；`zh,en,jp`；`official` |

这些是已真实读取的目录和源站所标版本，不代表完整文件已下载、游戏可运行或文件安全已由本工程验证。资源内 `files` 含实际文件名、字节数、`hash_algorithm` / `file_hash` 和部分文件的 `sha256`。多分卷应保留顺序和完整组，不能只选第一个文件。

公开资源页 [ATRI 2561](https://shionlib.com/zh/resource/2561) 已返回 200 HTML，标题为“亚托莉 -我挚爱的时光- Windows 简中 英文 日文 下载 - Shionlib”，并包含对应 RAR 文件。它适合作为准确的“前往下载”入口。

### 下载必须保留原站验证

源站会在 Cap 人机验证通过后签发有时效的文件地址；官方下载菜单支持浏览器下载、复制下载地址以及 aria2 推送。`GET /api/game/download/2552/link` 未带 token 的实测结果为 **HTTP 400 / code 450102 / token 不能为空**。没有伪造或获取验证 token。

[官方签发实现](https://github.com/Ringyuki/shionlib/blob/main/apps/api/internal/download/service_link.go) 先验证 token，再签发文件 URL 并增加下载计数。不能根据公开的存储 key 猜测 CDN 路径，不应将签发 API 或资源 HTML 页面直接交给 aria2。

适合的接入方式：应用内公开目录展示完整资源信息，按钮定位到准确资源页，由用户按原站验证获取文件；用户从原站复制实际时效链接后，可交给现有 HTTP 下载器。没有验证链路时，应明确展示“前往下载”，不冒充软件内一键直下。

两个 SPRB 汉化版本的上游文件有 `is_virus_false_positive:true` 与具体检测记录；这是源站管理员的判定，不等于本工程确认无害。接入不得丢弃已有风险记录或自动执行文件。

### 可选的官方开放 API

```text
GET https://shionlib.com/api/open/v1/games?vid=v27448
Authorization: Bearer <用户自己的 API Key>
```

支持一次按 Shionlib / Hikarinagi / Bangumi / VNDB 的最多 50 个 ID 查询，返回资源与可下载文件元数据，但下载仍定位源站资源页。本轮匿名实测返回 **401 / code 680101 / 请在 Authorization 请求头中附上 API 密钥**。用户没有提供 Key，不能声称该带 Key 接口已实际通过；普通公开目录适配不需要它。

## TouchGal：当前仍不适合启用为可用内置源

[官方域名通知](https://github.com/KunMoe/kun-touchgal-next/blob/main/posts/notice/domaintop.mdx) 于 2026-05-11 指明 `www.touchgal.ink`。旧 README 首页字段仍可能显示 `.com`，不要据此使用旧域名。

本轮对 `.ink` 的普通匿名 HEAD 仍返回 **403**，包含 `Cf-Mitigated: challenge`；旧 `.com` 的请求另遇 TLS 握手失败。已经找到 [官方搜索接口](https://github.com/KunMoe/kun-touchgal-next/blob/main/app/api/search/route.ts)，它是 `POST /api/search`，但源站访问挑战未解决。没有通过改指原站 IP、伪造浏览器验证或读取个人 Cookie 来绕过。

可保留明确的原站外部入口，当前不能把 TouchGal 列为已通过在线验证的稳定聚合源。

## 本地证据

`.work/gal-v038/` 的 Shionlib JSON 记录包含每次请求 URL、状态码及公开元数据；不保存 Cookie、账户资料、签名下载地址或完整游戏文件。主要包括：

- `search-v4.json`、`search-v27448.json`、`search-clannad.json`、`search-atri.json`、`search-senren.json`、`search-summer.json`
- `game-331-resources.json`、`game-37-resources.json`、`game-6-resources.json`、`game-1800-resources.json`、`game-708-resources.json`
- `file-2552-no-token.json`、`open-no-key.json`、`resource-2561-page.json`

不得将目录元数据检查表述为文件下载速度、完整性或运行测试。

## 适配器实现与生产代码在线复核

独立适配器位于 `src/infrastructure/sources/shionlib-source-provider.ts`。仅使用匿名 GET 目录接口，固定官方 origin，`credentials:omit`，不接收 Cookie 或 Key，不调用签发链接接口。每个资源版本使用独立的 `/zh/resource/{id}` 地址；保留汉化组、语言、平台、形态、发行版本、实际文件数、文件清单与严格验证格式后的来源哈希。`hashVerified:false` 明确表示未下载验证，多个文件不拼造整体 SHA。

`src/tests/shionlib-source-provider.test.ts` 已补充完整资源、试玩、独立补丁、存档、原声、画集和混合内容的用户筛选回归；说明文本不被误当游戏本体，“已打补丁”的本体不被误当独立补丁。类型不能确认或混合不同用途时标为待确认，来源的补丁版本字段不被当作独立补丁的证据。最初的 21 项接口测试与后续分类回归均通过；全工程 `npm run typecheck` 通过。

额外使用 Vite 加载实际生产适配器并直连源站，结果保存在 `.work/gal-v038/shionlib-provider-live-smoke.json`：

| 查询 | 适配器保留作品 | 目标作品的实际资源版本 |
| --- | ---: | ---: |
| `v4`（CLANNAD） | 1 | 1 |
| `vid:v27448`（ATRI） | 1 | 1 |
| `Summer Pockets` | 2（原版与 REFLECTION BLUE） | 原版 1 |
| `千恋万花` | 1 | 2 |

冷启动直接读取 ATRI 作品 ID 37 也通过。共 10 个匿名公开 GET，全部 200；没有请求下载签发接口，没有下载文件。这次生产适配器实际过滤了上游千恋万花的 44 个模糊结果，保留准确作品及两个译本。
