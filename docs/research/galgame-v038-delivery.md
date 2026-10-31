# 0.3.8 Galgame 资源整合与验证记录

本轮针对“Galgame 来源仍不好用”的反馈，新增可交给内置下载器的游戏归档来源和独立的中文多版本资源库，同时修复版本漏选、分卷漏下、资源类型误判与下载目录冲突。官方商店和试玩参考折叠到次要区域，发现页优先引导查找完整资源。

本文记录已取得的源码、自动化与桌面证据。截至写入时，最终可执行文件已完成扫描、原生重启续传、双译本及跨来源查询验收，用户资料后验通过；GitHub 发布仍在准备，以下不预填发布资产回验成功。

## 来源及实际获取方式

| 来源 | 本轮接入内容 | 点击后实际行为 |
| --- | --- | --- |
| [真红小站](https://www.shinnku.com/) | 公开游戏档案目录、版本、容量、归档格式、更新时间与分卷 | 真实 HTTP 文件地址交给内置 aria2；按原始文件名下载到独立版本目录 |
| [Shionlib](https://shionlib.com/zh) | 中文、英文、日文版本，平台、汉化组、官方翻译、免安装等形态，文件清单、容量和来源哈希 | 打开准确的资源详情页；用户在原站完成 Cap 验证后获取文件地址 |
| [鲲 Galgame](https://www.kungal.com/) | 继续作为社区资源与网盘发布的补充 | 打开对应来源资源页，保留语言、平台和本体/补丁等分类 |
| [VNDB](https://vndb.org/) | 保留官方发行、原版、试玩与商店参考；完整发行版排序优先 | 打开官网或商店，遵循具体发行的获取条件 |

真红适配器依据[官方公开项目](https://github.com/shinnku-nikaidou/shinnku-com)的目录和下载地址规则独立实现。仅解析页面中 JSON 编码的 Next/RSC 目录数据，不执行网页脚本。仅允许官方 HTTPS 地址和已接入的 `0/`、`zd/` 档案路径；不将另一套存储映射的 `galgame0` 原文合集错接到同一文件端点。

Shionlib 依据[官方 API 合约](https://github.com/Ringyuki/shionlib/blob/main/apps/api/openapi/openapi.json)独立实现匿名目录客户端。普通搜索、作品详情和资源列表无需账户或 API Key。新增原生 JSON 请求白名单仅包含 `shionlib.com`，没有扩大到任意同后缀域名。

该站的签发文件地址需要原站验证；适配器不调用下载签发接口、不生成或伪造验证 token、不从存储 key 猜测文件地址。上游 SHA-256 / BLAKE3 是来源信息，界面允许查看与复制，明确未由本软件下载校验。资源页 HTML 不会作为游戏文件进入 aria2。

TouchGal 当前匿名请求仍返回访问挑战，未作为已验证可用的新内置来源。详细证据见[第二来源复核](galgame-secondary-sources-v038.md)；目录可达不能代替文件下载或游戏运行验证。

## 用户操作与来源管理

发现页的 Galgame 入口依次介绍文件下载、多版本资源库和社区补充，提供 CLANNAD、ATRI、千恋＊万花、Summer Pockets 的检索入口。原有免费试玩与原厂日文免费文件保留在折叠参考区，避免与中文完整资源混淆。

来源搜索支持“全部已启用来源”，并标明正在使用的来源及单源失败；一个来源故障不抹掉其他来源的结果。新的预设仍需用户启用，搜索不会擅自开启旧配置中已关闭的来源，也不覆盖用户自定义名称和地址。

作品资源面板支持组合筛选“中文”“Windows”“游戏本体”，并分别选择“文件直链”或“原站获取”。资源关键词可以分别匹配语言、平台、版本等字段。未声明语言或平台的条目不被猜成中文 Windows 版本，中文作品名本身也不是汉化证据。

多版本以来源作品身份分组，可以选择具体版本；批量下载只作用于当前版本范围中可下载的文件。Shionlib 等站外入口没有批量文件下载勾选。文件清单保留每个分卷的名称、大小及来源哈希。

主要实现：

- `src/infrastructure/sources/shinnku-source-provider.ts`
- `src/infrastructure/sources/shionlib-source-provider.ts`
- `src/domain/galgame-resource.ts`
- `src/application/resource-discovery.ts`
- `src/components/GalgameResourceGuide.vue`、`SubjectResourcePanel.vue`
- `src/pages/ResourceSearchPage.vue`、`MediaPage.vue`、`SourcesPage.vue`

## 已修复的实际问题

| 问题 | 修复后的行为 | 验证范围 |
| --- | --- | --- |
| 真红每个归档各为一个候选，作品详情原来只保留首个，其他汉化版消失 | 真红详情读取最多 8 个高置信候选，保留可选版本 | 单元、浏览器及独立生产代码复核 |
| 以经典分卷的 `Game.rar` 进入时，只下载主文件，遗漏 `r00/r01` | 重载父目录，识别同一组全部分卷；拒绝缺首卷或断号的集合 | 单元与独立生产代码复核 |
| 正常的 `0/win` 父目录有 1,782 个文件，超过原先 1,000 个的限制 | 允许有界的 10,000 个目录文件，保留响应大小、深度和遍历上限 | 实站有限 GET、较大目录单元场景 |
| “已打修正补丁”的本体因出现“补丁”二字被判为独立补丁 | 区分已集成的本体与独立补丁；保留部分内容未汉化等说明 | 真实文件名回归与独立复核 |
| Shionlib 的 `Demo.zip`、`OST.zip`、`patch.zip + README.txt` 可能被当本体 | 说明文本不参与本体判断；区分试玩、补丁、存档、原声、画集，无法确定的混合文件标为待确认 | 用户组合筛选单元场景与浏览器回归 |
| 规范化后的短英文串可误命中其他词组，例如 `ATRI` 与 `a trial` | 短拉丁字母查询先检查原始标题或别名的实际词边界 | 最终构建前的针对性回归 |
| 不同汉化版本下载到同一目录，存在同名冲突；分卷后缀可能被截断 | 一个来源版本使用独立目录，同组分卷保持相同目录和完整后缀 | 单元、浏览器、原生真实传输 |
| 下载引擎拒绝重复任务前，作品关联已被新操作覆盖 | 引擎成功接收 Galgame 任务后再保存关联；关联失败明确提示任务已经加入 | 单元/浏览器范围内的针对性验收 |

独立复核保留了修复前后两份记录，便于确认问题确实被解决：

- `.work/gal-v038/shinnku-independent-review-findings.json`
- `.work/gal-v038/shinnku-independent-review-postfix.json`，三项检查均通过
- `.work/gal-v038/shinnku-parent-folder-review.json`

## 在线目录与文件检查

真红实际目录确认了 CLANNAD、ATRI、千恋万花和 Summer Pockets，保留对应官中、汉化组和其他平台版本；归档详情可在不重新广搜的情况下按保存的来源 ID 重载。有限 HTTP 检查确认实际文件的内容类型和声明长度；ATRI 的 Range 响应为 206，并含真实 7z 文件头。

Shionlib 生产适配器直连检查共 10 个匿名公开 GET，均返回 200：CLANNAD 和 ATRI 的 VNDB ID 精确检索、Summer Pockets 原版与 REFLECTION BLUE、千恋万花两个中文译本，以及冷启动按 ID 重载。千恋万花的上游模糊结果被过滤为准确作品。证据为 `.work/gal-v038/shionlib-provider-live-smoke.json`。

这些检查确认目录与有限文件数据可取得，没有代表所有作品的资源存活、下载速度、压缩包完整性或运行兼容性。Shionlib 上游已有的文件扫描记录被保留；上游复核结论不等于本工程确认文件安全。

## 自动化验证

| 项目 | 已取得结果 | 证据 |
| --- | --- | --- |
| TypeScript / Vue 类型检查 | 通过 | `npm run typecheck` |
| Vitest 全量 | **61 个测试文件，604 项通过，0 失败** | `.work/v038-final-vitest.json` |
| Rust | **86 项通过，2 项默认忽略** | 桌面构建脚本的测试执行记录；忽略项不计为通过 |
| 完整浏览器回归 | **80 项通过** | `.work/e2e/v038-full-results/` |
| 最终 Galgame 针对性浏览器回归 | **13 项通过** | `.work/e2e/v038-final-galgame/`；与上行有交集，不累计成 93 项 |

浏览器回归使用可控响应验证筛选、选择、错误隔离、版本范围和下载交互；它与真实源站检查及原生桌面传输各自证明不同范围，不能互相替代。

## 原生桌面与真实传输：区分两个候选

原生验收使用正常 Windows 桌面窗口与 UIAutomation，没有使用 CDP、远程调试或向运行中的应用注入 JavaScript。测试使用独立资料目录 `.work/normal-gal038-profile`。

### 初始候选的完整交互验收

初始候选 SHA-256：

```text
54DAA47128539AB8167534090C9A39DF98940EBCCEDF3117E6DB372AAC55B127
```

该候选实际完成公开来源搜索、选择 ATRI 的 3,781,414,904 字节归档、组合筛选、加入内置下载、暂停和继续。aria2 任务确认收到 **14,516,224 字节**，文件开头为 `377abcaf271c`，与 7z 魔数一致；输出位于独立来源版本目录。证据为 `.work/v038-evidence/native-transfer.json` 及同目录的原生界面记录。

测试刻意设置 **256 KiB/s** 下载上限，目的是有限传输与暂停续传验证；该数值不能当作源站实际速度。aria2 可能预分配文件空间，因此落盘文件的逻辑长度不代表已收到的字节数。上述 14,516,224 来自任务完成字节数。

这次记录产生在短英文词边界修复之前，不能用其可执行文件身份替代最终构建身份。

### 最终候选的重启续传复核

最终候选以正常应用重启恢复同一暂停任务，并再次继续传输后暂停。`.work/v038-evidence/native-final-transfer.json` 记录：

- 可执行文件 SHA-256 为下节的 `6298FC…E255`。
- 同一任务累计收到 **22,020,096 字节**，相比初始记录继续增长。
- 7z 文件头、独立版本目录、暂停/继续检查均通过。
- `fullDownload:false`、`archiveUnpacked:false`、`gameExecuted:false`。

这证明最终候选能够恢复既有任务并继续收到实际文件数据；没有将部分传输写成完整游戏下载验收。

同一最终候选还实际完成了以下原生操作：

| 操作 | 已观察结果 | 证据 |
| --- | --- | --- |
| 真红搜索 ATRI | 返回 3 个匹配候选，`a trial` 的误命中已消失 | `.work/v038-evidence/native-final-atri-search.json` |
| Shionlib 搜索千恋万花，并组合中文、Windows、本体条件 | 保留官方中文与城彩学园×落樱两个译本 | `.work/v038-evidence/native-final-shionlib-files.json` / `.png` |
| 展开 Shionlib 文件清单 | 显示来源 SHA 与未由本软件下载校验的说明；原生程序成功读取新增官方 JSON 来源 | 同上 |
| 对两个已启用来源执行同一次查询 | 返回 7 个候选，并显示来源身份 | `.work/v038-evidence/native-final-multisource.json` |

验收后应用已正常关闭，未留下本轮测试下载继续消耗带宽；该任务保留为暂停状态。运行验收结束后 Defender 未出现新增检测事件。

## 构建身份、扫描与发布前状态

| 产物 | 当前 SHA-256 |
| --- | --- |
| 最终 0.3.8 可执行文件 | `6298FC5235A0A8FEC584703AE98D7D3ADD34BA61689C50E01B3D9AD2AC56E255` |
| 0.3.8 x64 NSIS 安装包 | `C997C9D294B818D61329F0090B51BCA4E60DA989470A2FD5DF5BEAC99129B48A` |

`.work/security-audit/v038-release-final-scan.json` 记录两个产物扫描通过、哈希与扫描前一致，实时防护保持启用，无新增检测事件。NSIS 只构建和扫描，**没有实际安装**；静态扫描本身不证明程序已经执行。

用户资料基线位于 `.work/v038-evidence/baseline.json`，覆盖现用资料库 9 张表、3 个原有媒体文件及 16 个旧版可执行文件。最终后验 `.work/v038-evidence/data-preservation.json` 的 `tables`、`payloads`、`previousExecutables` 均为 true，`allPreserved:true`，数据库完整性为 `ok`，不记录用户数据值。本轮原生下载在独立测试资料中进行，没有把测试归档当作用户现用库的正式下载。

便携包已完成 10 条目白名单、CRC 与逐项 SHA256 校验，9,578,019 字节，SHA256 `BFC0C59ABE14163A4DBFAEABE534D87583C84C2C49E8DC2692CE72C2C92C4768`。桌面快捷方式指向 `START-ACGN-0.3.8.cmd` 与新 exe 图标，沿用原 `release/v0.3.2/Data`；回执在 `.work/v038-evidence/shortcut-verification.json`。发布地址为 [私有 GitHub 0.3.8](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.3.8)，远端发布和实际下载回验状态以 `.work/v038-evidence/github-published-verification.json` 为准。

本次没有重新验收所有动画、漫画、小说来源、阅读器组合或所有游戏引擎兼容性。没有完整下载、解压或启动 Galgame，也没有绕过站点登录、付费或人机访问验证。源码的来源适配、实际有限传输与整包安装运行是不同验收范围。
