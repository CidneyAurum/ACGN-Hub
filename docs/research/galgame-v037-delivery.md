# 0.3.7 Galgame 发现与资源交付记录

记录日期：2026-10-31（Asia/Shanghai）。本轮针对 Galgame 页面内容不足、资源入口不清楚、平台与版本难以区分进行改进。源码修复、回归及最终程序原生验收已经完成，最终身份见文末。早期候选和最终程序的证据分别保留。

## 交付行为

### 真实作品发现

Galgame 发现页从 VNDB 官方公开接口获取作品，提供真实封面、评分、作品详情、收藏、分页与手动刷新。每页 24 部，不再依赖固定推荐样例。

- **中文可用佳作**：按 VNDB 评分排序，至少 50 人评分。
- **近两年新作**：按原作发售日期排序，至少 5 人评分；起止日期随当前日期计算。
- 两种列表都限制原作已经发售，并要求 VNDB 记录存在简体或繁体中文版本。中文可用包含官方与民间翻译，不代表每一条发行资源都有中文。
- “近两年”指原作首发日期，不是汉化更新日期，也不是网站条目修改时间。
- 目录缓存 30 分钟；页面在定时检查、重新获得焦点、恢复联网、恢复可见时判断是否需要更新，跨日重新检查。手动刷新绕过此前缓存。
- 切换排序、返回详情、分页与过时请求使用状态隔离，避免较旧请求覆盖当前列表。刷新失败时保留已经加载的内容，并提供重试与更新时间。

主要实现：`src/components/GalgameDiscovery.vue`、`src/infrastructure/metadata/vndb-provider.ts`、`src/pages/HomePage.vue`。

### 社区资源与官方发行

资源查找分为两种实际用途，均允许先在来源中确认准确作品，再查看对应条目。

**鲲 Galgame**继续使用匿名公开 v1 作品/资源接口，保留游戏本体、补丁、合集、工具、攻略、原声等实际资源类型，以及语言、平台、运行方式、体积和网盘/发布站名称。新增作品 ID、作品页 URL 和更完整的别名匹配；保存的作品 ID 可重新读取资源，不依赖之前搜索留下的内存缓存。

资源目录由固定首 50 条改为有上限的分页读取，最多读取 10 页、500 条目录记录，过滤来源标为失效的条目。分页不完整或达到上限时明确提示。来源标记“有效”只表示目录状态，不代表应用已经验证所有外部文件。

**VNDB · 官方发行与试玩**作为可选新来源，匿名读取作品的官方发行记录，优先显示中文、免费和试玩版本，明确区分：

- 完整发行版。
- 试玩版，仅含体验内容。
- 部分内容发行。
- 补丁，需要对应游戏本体。

每条保留该发行实际支持的语言、平台、免费标记、发行日期和 VNDB 发行记录。官网、Steam、itch.io 等商店入口在浏览器打开，实际价格、地区、授权、安装和获取条件由来源决定。免费标记不会让网页进入文件下载器。

官方发行查询最多检查最新 200 条发行记录，并限制展示数量；达到目录读取上限时提示更早版本需在 VNDB 查看。过滤数据库分析站、百科、社交页面、历史快照和不符合商店域名的伪装链接，避免把它们列成发行下载入口。

主要实现：`src/infrastructure/sources/kungal-source-provider.ts`、`src/infrastructure/sources/vndb-release-source-provider.ts`、`src/pages/ResourceSearchPage.vue`、`src/components/SubjectResourcePanel.vue`。

### 可直接使用的官方入口

Galgame 发现页新增资源指南，提供精准作品入口：

| 作品 | 入口性质 | 已确认的语言与平台 |
| --- | --- | --- |
| [ATRI -My Dear Moments- Demo](https://store.steampowered.com/app/1263470/) | 官方免费试玩 | 简体/繁体中文等；Windows |
| [千恋＊万花体验版](https://store.steampowered.com/app/1221010/) | 官方免费试玩 | 简体/繁体中文、日文；Windows |
| [Narcissu 1st & 2nd](https://store.steampowered.com/app/264380/) | 官方免费完整发行 | 英文/日文；Windows、macOS、Linux |
| [Doki Doki Literature Club! 原版](https://store.steampowered.com/app/698780/) | 官方免费原版 | 英文；Windows、macOS |
| [Narcissu 2 旧日文原版](https://stage-nana.sakura.ne.jp/down.htm) | 原作者文件直链 | 日文、旧 Windows 版本、LZH 压缩包 |

这些入口没有被统一标成“中文完整版”。ATRI 和千恋体验版与其付费正式版分别处理；DDLC 原版与付费 Plus 版分别处理。Steam 的免费状态与独立 demo app ID 均经过公开官方接口核对。

Narcissu 原厂文件 `https://stage-nana.sakura.ne.jp/download/naru2.lzh` 可加入内置下载器，设置明确的文件名：

```text
水仙2（Narcissu Side 2nd）- 日文原版.lzh
```

原厂文件约 269 MiB，保留 LZH 扩展名。页面说明需要兼容的解压工具，再将安装目录加入本地游戏管理；不会自动解压执行或声称已安装。显式文件名通过下载存储、DownloadManager 传给引擎，不依赖下载完成后猜测作品标题。

HIKARI FIELD 作为官方中文目录补充入口。其作品页可访问，但本轮匿名请求显示地区限制，因此没有宣称其商店游戏已可直接下载。详情见[来源复核文档](galgame-sources-2026-10.md)。

主要实现：`src/components/GalgameResourceGuide.vue`。

## 本轮发现并修复的问题

### 1. Galgame 资源被首 50 条截断

实测 KUN 官方返回的总数超过单页容量，旧适配器固定只读取第一页，用户无法看到后续仍有效的资源。修复为分页读取、按 ID 去重、过滤失效状态，并在达到上限时提示。

来源审计的实际结果如下，数量会随网站更新变化：

| 作品 | 目录记录数 | 读完分页后来源标记有效的数量 |
| --- | ---: | ---: |
| ATRI（作品 12） | 67 | 58 |
| 夏日口袋（作品 4） | 57 | 53 |
| 千恋＊万花（作品 15） | 122 | 107 |

证据：`.work/galgame-source-audit/final-checks.json`、`pagination-report.json`。这里没有把目录总数当成可下载文件数。

### 2. 同一个官网地址吞掉不同发行版本

VNDB 中的同一个官网地址可能同时关联不同平台、试玩、本体、补丁或实体/数字版。旧逻辑只按 URL 保留首条，会使后续版本消失。例如 DDLC Plus 官网关联 Windows/macOS、Switch、Xbox、PS 等发行；夏日口袋的同一个 Switch 官网同时关联完整发行与补丁。

修复后，VNDB provider 使用“发行记录 ID + URL”保留各版；共享 `resourceDedupeKey` 对带有合法 VNDB 发行 ID 的外链附加版本身份。发现服务和作品详情里的后续去重也使用同一规则，避免修复只在 provider 内生效。普通文件下载仍按原 URL 去重。

对应实现与回归：`src/domain/resource.ts`、`src/application/resource-discovery.ts`、`src/pages/MediaPage.vue`、`src/tests/vndb-release-source-provider.test.ts`、`src/tests/resource-discovery.test.ts`。

### 3. Android 平台字段没有转成可读标签

KUN 实际接口使用 `and`、`native-and`、`kirikiroid2` 等字段，最初标签映射遗漏了这些真实值，导致界面出现 `and` 等缩写，输入“安卓”也可能筛不到。已补齐 Android/安卓、原生运行、吉里吉里等标签及检索词，并增加回归。

来源实测 ATRI 首 50 条中，`and` 出现 24 次、`native-and` 出现 23 次，说明不是只存在于虚构测试的数据。

### 4. 外链混入批量下载

外链的单条操作明确为打开官网、商店、试玩页、补丁页或来源页。勾选框、全选范围、选择数量和批量添加均排除 `downloadMode:external_link`，执行层再次过滤。不会把 HTML 分享页当作游戏文件交给 aria2。

### 5. 自定义来源重复补预设

来源查找优先保留用户已有的配置身份。对于不同自定义 ID 但已配置同类型/同 URL 的来源，不再重复补同一个内置预设。新增 VNDB 来源以可选项提供，用户点击启用并搜索才保存，不通过迁移重写旧配置。

### 6. Galgame 全集/存档被误判成动画跨季合集

原来共用的标题提示会把 Galgame 的“全集”“存档”等文字当作动画跨季资源，显示无关警告。原生候选验证中发现后，已把动画季度/合集标签限定在动画类型，并补充单元回归。最终源码已包含这项修复；发现问题时使用的旧候选程序不能替代修复后二进制验证。

## 验证记录

以下分别记录源码回归、来源在线检查、原生候选操作和数据保留，不能相互替代。

| 验证项目 | 当前已取得的结果 | 证据 / 范围 |
| --- | --- | --- |
| Vitest 全量 | **58 个文件、487 项通过，0 失败** | `.work/v037-final2-vitest.json`；包含最后增加的 Galgame 非动画标题警告回归。报告的 suite 数含嵌套 describe，不等同于文件数 |
| Rust | **86 项通过、2 项默认忽略** | 主任务执行 `src-tauri/scripts/build-desktop.ps1 -Action test` 的结果；未将忽略项当作成功执行 |
| 完整浏览器回归 | **74 项通过** | `.work/e2e/v037-final-full-results/`，`.last-run.json` 为 `passed`、失败列表为空 |
| 最后源相关定向浏览器回归 | **12 项通过** | `.work/e2e/v037-final-context-results/.last-run.json`；Galgame 发现、来源、版本去重及资源导航 |
| 官方目录/来源在线检查 | KUN、VNDB、Steam、原厂网站的代表作品与返回字段经过实际请求 | `.work/galgame-source-audit/`、`.work/vndb-release-live-probe.json`、`.work/vndb-release-production-live-evidence.json` |
| 原厂 LZH 文件检查 | HEAD 200、文件长度 282,478,817 字节、Range GET 206、LHA `-lh5-` 文件头 | `.work/galgame-source-audit/direct-report.json`、`final-checks.json`；有限范围请求，不是完整归档下载 |
| 数据保留检查 | 数据表、用户媒体和旧程序检查均通过，数据库完整性 `ok` | `.work/v037-evidence/data-preservation.json`；检查时间 `2026-10-31T05:46:11Z`，不输出用户数据值 |

### 已完成的原生候选验证

使用正常桌面窗口、Windows UIAutomation、独立新资料目录，未使用 CDP、远程调试或注入 JavaScript。该次候选身份如下：

```text
SHA-256: 85FC42171AA76DAD7F5CC5E79123E05A5B7EEFA98D7868D37D5B7B707A6FA47B
Profile: .work/normal-gal037-profile
```

已观察到的真实操作：

- Galgame 发现页加载真实目录，首批 24 部作品、封面、评分和资源指南出现。
- 官方发行来源搜索 CLANNAD，进入作品后加载 32 个发行入口；输入中文条件后筛选出 1 条对应发行。
- KUN 搜索 ATRI，进入作品后加载 58 个有效目录入口；安卓条件筛选出 28 条。

证据：`.work/v03-evidence/normal-gal037/launch.json`、`.work/v037-evidence/native-gallery.json` / `.png`、`native-official-chinese.json`、`native-official-chinese-visible.json`、`native-kun-all.json`、`native-kun-android.json` / `.png`。

该候选及其 NSIS 安装包已通过当时的静态扫描，防护保持开启、无新增检测事件，记录在 `.work/security-audit/v037-final-scan.json`。随后修复非动画标题误警告并重新构建、复验。上述 hash 和原生操作**只对应旧候选**，最终产物另见下节。安装包没有实际安装。

## 数据与交付约束

既有用户资料继续使用原配置和路径，不清空来源、凭据、作品、下载任务或媒体文件。原生验证使用独立测试资料，保留此前 0.3.6 及更早产物。

工作区升级启动脚本 `START-ACGN-0.3.7.cmd` 设计为沿用既有 `release/v0.3.2/Data`。发布目录中的 `START-PORTABLE.cmd` 使用其自身独立 `Data`，两者用途不同；不把新便携目录覆盖到旧用户数据上。

本轮没有重新验证所有历史下载来源、所有漫画/小说阅读组合或视频编码兼容性；它们的已有回归不等于全站、全作品和所有系统均已实测。

## 当前证据的实际限制

- 没有下载、解压或启动完整 Galgame，也没有通过试玩完成安装/启动验收。
- KUN 外部网盘文件没有全部逐一验证；目录标记有效不保证权限、文件完整性或下载速度。
- Steam、itch.io、官网和 HIKARI FIELD 的入口可达性不等于已取得游戏，地区、账号和购买条件仍以原站为准。
- Narcissu 原厂 LZH 只验证有限字节范围、文件类型和长度，没有以有限 Range 请求冒充整个文件校验。
- 没有绕过登录、付费、访问验证或地区限制；没有读取个人浏览器 Cookie，也没有修改安全软件、系统代理或防火墙。

## 最终产物与复验

| 产物 | 大小（字节） | SHA256 |
| --- | ---: | --- |
| ACGN-Hub-0.3.7.exe | 25,565,696 | `C461B9EB29B7327271FB4F6B85A54529E389588F84889B71BF8955EE7924D781` |
| ACGN-Hub-0.3.7-x64-setup.exe | 7,243,726 | `C729E4A6A586687DEB2897EAC5C5290E51A457746AA9EABA6E450BA8FD09953F` |
| ACGN-Hub-0.3.7-windows-x64.zip | 9,565,661 | `0D5CB459A249814DF553C43B2A7726ED459CF7DEFDA98688541B5F9E1D346EF1` |

最终 exe 的 `normal-gal037-final` session PID 14284 使用同一隔离测试资料复验恢复后的来源记录。ATRI 仍有 58 条、安卓筛选 28 条；CLANNAD 仍有 32 个官方入口、中文筛选 1 条。观察到本体／简体中文／Windows／Android 原生／吉里吉里2等标签，以及明确的“前往商店”按钮；“全集存档”不再触发动画跨季提示，外链没有下载全选。原生证明汇总 `.work/v037-evidence/native-verification.json` 逐项检查全部通过，哈希匹配最终静态扫描；退出后无新增检测事件。

便携 ZIP 通过 10 条目白名单、CRC 和逐项 SHA256 检查，不含用户 Data 或媒体。桌面快捷方式已指向 0.3.7，使用原用户资料；原数据库 9 表、3 个媒体 payload、14 个旧 exe 保留。发布路径为 [私有 GitHub 0.3.7](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.3.7)，远端资产与实际下载回验的最终状态记录在本机 `.work/v037-evidence/`。

本轮来源原始结论和排除项见 [Galgame 来源复核与接入建议](galgame-sources-2026-10.md)，用户使用说明见 [0.3.7 使用说明](../releases/v0.3.7-usage.md)。
