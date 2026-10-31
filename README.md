# ACGN Hub

为喜欢的故事留一个位置。面向 Windows 的动画、漫画、轻小说与 Galgame 收藏工作台，将作品发现、资源检索、下载整理和离线阅读放在一起。

**[下载 Windows 版本](https://github.com/CidneyAurum/ACGN-Hub/releases/latest)** · [0.4.0 使用指南](docs/releases/v0.4.0-usage.md) · [English](README.en.md)

## 发现、收藏，再慢慢看

- **跟随季度的番剧首页**：按本地年月切换 1 / 4 / 7 / 10 月新番，支持往季、放送表与分页。漫画、轻小说和 Galgame 也有独立封面书架。
- **作品与作者一起搜**：输入作品名或作者名，直接查看相关作品。Bangumi 与 VNDB 提供作品资料；资源检索可以独立使用。
- **清楚的资源选择**：显示来源、语言、平台、版本与获取方式，区分本体、补丁、试玩、原声、网页入口和文件直链。
- **下载与整理**：内置 aria2 处理 HTTP / HTTPS、磁力和 Torrent；支持暂停、续传、限速、完成后命名及按作品整理。qBittorrent 可选。
- **下载后在应用内看**：CBZ 漫画支持长条滚动、单页与全屏；TXT 小说支持目录、字号、行距和纸色；保存进度，并可接续同作品已下载的下一话、卷或集。
- **带着收藏搬家**：便携包将资料保存在自己的 `Data` 中。关闭程序后移动完整目录，内部已登记路径和阅读进度随新位置更新。

暖粉紫电视图标与真实作品封面贯穿界面；没有生成的 AI 角色素材。

## 界面预览

以下四图为 v0.3.9 正式桌面程序的真实界面，使用独立资料库及公开作品资料。0.4.0 延续这一视觉方向。

| 动画 · 季度发现 | 漫画 · 封面书架 |
| --- | --- |
| ![动画季度发现页](docs/screenshots/01-anime.png) | ![漫画发现页](docs/screenshots/02-manga.png) |
| 轻小说 · 作品发现 | Galgame · 作品发现 |
| ![轻小说发现页](docs/screenshots/03-novel.png) | ![Galgame 发现页](docs/screenshots/04-galgame.png) |

## 下载与首次启动

在 [Releases](https://github.com/CidneyAurum/ACGN-Hub/releases/latest) 下载 **Windows x64 便携 ZIP**，完整解压到可写目录后运行 `START-PORTABLE.cmd`。便携目录中的 EXE 也会通过 `ACGN-HUB-PORTABLE` 标记使用同一个 `Data`。不要从压缩包预览窗口直接运行，也不要只取走 EXE。

需要 Microsoft Edge WebView2 Runtime；普通使用无需安装 Node.js、Rust 或独立 aria2。NSIS 安装包作为另一种分发方式提供。当前发布目标为 Windows x64。

首次使用只需三步：

1. 在「设置」确认待整理、作品库和电子书输出目录。
2. 到「来源管理」启用需要的来源；预置下载来源默认关闭。
3. 从发现页打开作品，或在「找资源」直接搜索，再选择准确的作品版本和章节。

普通直链和 BT 下载使用内置引擎。JMComic、公开投稿等可选功能需要相应本机工具，详情见[使用指南](docs/releases/v0.4.0-usage.md)。发行包不含账号、用户资料或作品文件。

## 0.4.0：补齐轻小说与 Galgame，改善便携使用

轻小说继续以 **LNovel 中文日轻文本**为主，改善标题与作者匹配、正文实体解码、插图条目识别和资源 ID 校验。可通过作品链接或站点 ID 补查缓存目录外的作品，能否取得仍取决于上游；TXT 为纯文本，不含原书插图。

轻小说首页先显示首批 8 部真实推荐，再补齐本页 24 部；已有缓存过期也会先显示并后台更新。后续请求失败时保留已有结果，可用「补全本页」继续加载。

LNovel 缓存漏掉正篇时，会补查官方月 / 周索引。《无职转生》正篇 2013 与蛇足篇 4325 现分别展示；当前正篇详情返回 HTTP 408、首章已下架，本轮未取得完整卷，不承诺当前可下载。见[正篇核查记录](docs/research/lnovel-main-series-v040.md)。

Galgame 扩展真红小站原文合集文件目录，保留中文 Windows 版本优先；改善 KUN、ShionLib 与官方发行入口的作品匹配、分页及取消处理。资源语言依据来源信息标记，原文合集不会自动当作中文版。

便携包新增独立模式标记，修复 EXE 与启动脚本使用不同资料库、移动后绝对路径失效，以及输出发布依赖 NTFS 硬链接的问题。迁移在启动下载前完成；异常时保留记录，活动的内置下载任务暂停待确认续传。

## 各来源能提供什么

| 用途 | 来源 | 实际能力 |
| --- | --- | --- |
| 作品资料 | Bangumi、VNDB | 封面、简介、评分、作者关系、季度或发行目录；不等于媒体下载源 |
| 动画 | 蜜柑、AcgnX、自定义 RSS | 种子、磁力或源中提供的链接；BT 速度取决于实际节点与网络 |
| 中文漫画 | MangaBZ、拷贝漫画 | 可读取的章节原图生成 CBZ；访问条件以原站为准 |
| 漫画补充 | MangaDex | 多语言章节原图；是否有中文取决于所选章节 |
| 日轻中文文本 | LNovel | 来源可公开读取的分卷生成 TXT；不含插图 |
| Galgame 文件 | 真红小站 | 中文目录及原文合集中的文件直链，保留版本和分卷信息 |
| Galgame 多版本目录 | ShionLib | 版本、平台、文件与哈希信息；获取实际链接可能需要原站验证 |
| Galgame 补充 | KUN、VNDB 官方发行 | 社区分享入口、官方商店、试玩及免费发行参考；网页入口由浏览器打开 |
| 其它可选来源 | Internet Archive、公开投稿等 | 按各自内容和访问条件使用；不保证覆盖特定作品 |

来源健康检查只确认当前接口或目录可访问，不代表每个文件均可完整下载。实际可用内容、语言与版本以原站和所选资源为准。WeebCentral、快看已撤下。

## 便携、迁移与升级

```text
ACGN-Hub/
├─ ACGN-Hub-0.4.0.exe
├─ START-PORTABLE.cmd
├─ ACGN-HUB-PORTABLE
└─ Data/                       首次启动后创建
   ├─ acgn-hub.db               收藏、资源与下载记录
   ├─ WebView2/                设置、阅读进度及界面资料
   └─ Files/                   默认下载、书库与存档备份
```

**迁移**：完全退出程序，复制整个便携目录到新位置或另一台 Windows x64 电脑，再启动。`Data` 内已登记路径自动更新；外部自定义媒体目录保留原路径，需要自行搬迁或重新设置。连接凭据和第三方登录可能需要重新填写。

**升级**：先关闭程序并备份旧目录，将新版解压到独立目录，再把原 `Data` 复制到新版目录后启动。已有目标 `Data` 时先保留它，不合并覆盖两个资料库。旧版未记录便携位置时，仅在多个默认目录一致的情况下自动识别旧路径；升级后请核对保存位置。不要让两个实例同时写同一个 `Data`。

便携支持 NTFS，并使用兼容 exFAT / FAT32 的无覆盖发布方式；真实 exFAT 设备尚未验证，FAT32 仍有单文件 4 GiB 限制。未完成的改名恢复需先在原位置处理。完整步骤见[迁移与升级指南](docs/releases/v0.4.0-usage.md#迁移与升级)。

## 开发

前端使用 Vue 3、TypeScript、Vite；桌面端使用 Tauri 2、Rust、SQLite。使用支持当前 Vite 版本的 Node.js LTS。Windows 桌面构建另需 Rust MSVC 工具链、Visual Studio C++ Build Tools 与 Windows SDK。

```powershell
npm ci
npm run dev
```

浏览器开发模式用于界面预览；原生下载、目录选择和本地阅读文件访问需要桌面端。

```powershell
npm run verify
npm run test:e2e
powershell -NoProfile -File .\src-tauri\scripts\build-desktop.ps1 -Action test
```

构建桌面程序及 NSIS 安装包：

```powershell
powershell -NoProfile -File .\src-tauri\scripts\build-desktop.ps1 -Action bundle
```

构建脚本会检查前端、Cargo 与 Tauri 版本是否一致，并加载本机 MSVC / SDK。正式包装脚本额外要求匹配的静态扫描证据；`release/`、`.work/`、用户数据库与媒体不上传 Git。

## 验证与文档

单元测试与固定响应浏览器测试用于防止代码、路径和交互回归；真实来源与桌面样本的验证范围单独记录。尚未完成完整 Galgame 下载、安装和运行验收，也未验证其它桌面平台。视频编码支持取决于系统，EPUB / PDF 仍使用系统阅读器。

| 文档 | 内容 |
| --- | --- |
| [0.4.0 使用指南](docs/releases/v0.4.0-usage.md) | 首次启动、来源选择、阅读、便携升级与常见问题 |
| [验证记录](VERIFICATION.md) | 各版本实际测试与未覆盖边界 |
| [历史 README](HISTORY.md) | 原 README 完整存档，保留历史交付叙述与当时路径 |
| [本地阅读研究](docs/research/local-reader-references-v036.md) | 阅读交互参考与实现范围 |
| [轻小说正篇核查](docs/research/lnovel-main-series-v040.md) | 缓存漏检修复、《无职转生》正篇与正文限制 |
| [Galgame 文件来源](docs/research/galgame-direct-source-v038.md) | 直链及部分传输的历史核验 |
| [第三方声明](THIRD_PARTY_NOTICES.md) | 依赖、内置 aria2、作品内容与素材归属 |

封面、文本和其它作品内容属于各自权利人。仓库公开源码不改变第三方内容或依赖的许可；本项目尚未单独指定项目许可证。
