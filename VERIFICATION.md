# ACGN Hub 验证记录

## 最新增量：0.4.0 来源可靠性与便携迁移

| 检查 | 实际结果 |
| --- | --- |
| 工程与浏览器 | 前端类型和 E2E 类型检查通过；Vitest 62 文件 / 647 项、Playwright 83 项、Rust 96 项通过 / 2 项默认忽略。最后导航及简介修复另有 2 项浏览器、51 项相关单测通过；完整回归与最后定向回归分别记录 |
| 小说首页 | 正常桌面冷资料库显示真实推荐与封面；首 8 条分批、本页补齐、第二批失败保留结果和缓存时间由定向单测 / 浏览器回归覆盖 |
| 正篇检索 | 正常桌面输入“无职转生”，正篇 2013 排在蛇足篇 4325 前；索引未缓存和衍生版本均有提示，不自动用番外替代正篇 |
| 正篇正文边界 | 本轮源接口先后返回 408 / 500，首章公开错误标记已下架；繁体站返回不完整内容，未接入假回退，也未取得正篇完整首卷。见[专项记录](docs/research/lnovel-main-series-v040.md) |
| 原生 TXT / 内读 | 《文学少女》首卷 242,459 字节 / 83,192 字符，10 个目录项、阅读器 7 章节；第二卷 342,612 字节 / 118,813 字符，12 个目录项、阅读器 10 章节。两卷均正常 UI 下载与打开，第二卷由最终 E146CE… 程序在新目录实际生成 |
| 物理便携迁移 | 完整关闭并移动到含 `%20`、中文的新目录；最终程序直接使用相邻 Data，收藏和下载保留，首卷字节不变且恢复第一章阅读位置，未创建错误的百分号解码目录 |
| 导航 | 最终程序从小说详情返回后仍为小说、原 LNovel 来源及原检索词，重新搜索得到同一作品；原有 `<br>` 简介按纯文本显示 |
| Galgame | 真红原文合集、KUN / Shionlib / VNDB 定向 141 项通过；真实目录、3 个归档的 64 字节文件头与容量、捆绑 aria2 HEAD 通过；最终桌面确认 CLANNAD 多版本候选。未完成下载或运行游戏；后续被切换的详情页排除出文件目录验收 |
| 数据保留 | 原用户数据库 9 表逐表行数 / 内容哈希及完整性保持；3 个原媒体、23 个旧 EXE 哈希保持；未启动原用户资料库。桌面入口切至新版并沿用原 Data |
| 构建与打包 | 最终 EXE `E146CE109A20B2F29C69EA1A49C64851CAEFC8D863C227252D3270CDC51B0D40`；NSIS `59C5AB8E2CEA331CE0AB330F192D35DADB88C19004D6EC085E3F7113D7425745`；均扫描通过。11 项白名单便携 ZIP CRC / 每项哈希通过，不含用户 Data |
| 运行范围 | 全程 UIAutomation，无 CDP / 注入；两次正式桌面正常退出，无新增防护检测；安装包未实际安装，物理 exFAT 尚未验证 |

本地回执：`.work/v040-evidence/{engineering-verification,native-workflow,preservation-after,portable-archive}.json`；源实测见 `.work/gal-v040/` 与 `.work/novel-sources-v040/`。这些资料不随公开源码或便携包上传。2E97DF… 的首页 / 第一卷流程与最终 E146CE… 的迁移、第二卷和返回导航分别保留，不把前者冒充最终构建重下。

生产打包使用 `scripts/package-verified-release.ps1`；白名单 ZIP 使用 `python scripts/create-portable-archive.py release/v0.4.0`。迁移、升级和来源能力见[0.4.0 使用说明](docs/releases/v0.4.0-usage.md)。

## 最新增量：0.3.9 暖色电视图标

| 检查 | 实际结果 |
| --- | --- |
| 图标生成 | 16／24／32／48／64／128／256 像素 ICO、透明角与不透明屏幕、SVG 副本一致；`.work/brand-icons-tv-v039/verification.json` |
| 真实程序图标 | 从发布 exe 提取 32 像素图标，545 个全不透明像素与生成源的 RGB 最大差值为 0；`.work/v039-evidence/embedded-icon-verification.json` |
| 类型检查／生产构建 | 通过，桌面打包完成 |
| 浏览器定向流程 | 一个已有首页显示与详情流程通过；`.work/e2e/v039-brand-final/.last-run.json` |
| 原生视觉验收 | 最终 exe 的窗口与侧栏显示暖色小电视；隔离资料、Windows UIAutomation、无调试注入、程序已关闭；`.work/v039-evidence/native-verification.json` |
| 静态扫描 | exe `128C4E83FB46C35A77E90653BCAC8C0BD2C35137F9360F0792AEE58A0F1C16C9`，NSIS `851E05901FE48E97562E1170B236EC2D590D7EA3603BBC8F8A287D629A1120B0` 均通过；NSIS 未安装 |
| 数据保留 | 原 9 表／3 媒体／18 个旧 exe 保持，DB 完整性 ok；`.work/v039-evidence/data-preservation.json` |
| 桌面与便携包 | 桌面指向 START-ACGN-0.3.9.cmd 与新 exe 图标；ZIP 9,541,561 字节、10 条目 CRC 及逐项 hash 通过，不含用户资料 |

本轮只修改品牌资产、资源缓存标识、版本与交付文件，没有将 0.3.8 的 604 单测／80 浏览器等历史记录计作本次重新执行。发布路径：[私有 GitHub 0.3.9](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.3.9)。

## 最新增量：0.3.8 Galgame 完整资源整合

| 验证 | 结果与范围 |
| --- | --- |
| 全量单测 | 61 文件／604 项通过，`.work/v038-final-vitest.json` |
| 完整浏览器回归 | 80 项通过，`.work/e2e/v038-full-results/.last-run.json` |
| 最后 Galgame 回归 | 13 项通过，`.work/e2e/v038-final-galgame/.last-run.json` |
| Rust | 86 通过、2 默认忽略、0 失败；新增 JSON 来源使用相同代理边界 |
| 最终原生验收 | `.work/v038-evidence/native-verification.json` 全部通过；Windows UIAutomation、隔离测试资料，无 CDP、脚本注入或 Cookie 读取 |
| 实际数据传输 | 真红 ATRI 总长 3,781,414,904 字节，初候选收到 14,516,224；最终程序重启后继续到 22,020,096，并暂停；7z 魔数正确、独立版本目录、文件名正确。人为限速 256 KiB/s，不用于评价源站速度，未完整下载或运行 |
| 实际独立目录 | 最终 ShionLib 千恋万花显示官方中文与汉化组两个版本；源站哈希明确标注未校验本地文件；两源联合查询实际 7 候选；ATRI 修正为 3 候选，无 trial 误命中 |
| 最终静态扫描 | exe `6298FC5235A0A8FEC584703AE98D7D3ADD34BA61689C50E01B3D9AD2AC56E255`；NSIS `C997C9D294B818D61329F0090B51BCA4E60DA989470A2FD5DF5BEAC99129B48A`；`.work/security-audit/v038-release-final-scan.json`，NSIS 未实际安装 |
| 用户资料保留 | 9 表／3 媒体文件／16 旧程序保持，DB 完整性 ok；`.work/v038-evidence/data-preservation.json` |
| 桌面入口 | `START-ACGN-0.3.8.cmd` 使用原 `release/v0.3.2/Data`，图标取新 exe；`.work/v038-evidence/shortcut-verification.json` |
| 便携包 | 9,578,019 字节、10 条目白名单、CRC 及逐项 hash 通过，不含用户资料和游戏档案；`.work/v038-evidence/delivery-assets.json` |

最终程序与初候选身份、公开来源协议及限制详见 [0.3.8 交付记录](docs/research/galgame-v038-delivery.md)。发布地址为 [私有 GitHub 0.3.8](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.3.8)，最终远端及回验回执保存在本机 `.work/v038-evidence/`。

## 最新增量：0.3.7 Galgame 发现与资源

最终程序 SHA256 `C461B9EB29B7327271FB4F6B85A54529E389588F84889B71BF8955EE7924D781`，NSIS 为 `C729E4A6A586687DEB2897EAC5C5290E51A457746AA9EABA6E450BA8FD09953F`。最终程序以隔离测试资料完成 Windows UIAutomation 原生验收，未读取浏览器 Cookie，未使用 CDP／注入脚本或修改防护。安装包未实际安装。

| 验证 | 结果与证据 |
| --- | --- |
| 类型检查及生产构建 | 通过，桌面打包内含相同生产前端 |
| Vitest | 58 文件／487 项通过，`.work/v037-final2-vitest.json` |
| Rust | 86 通过／2 默认忽略／0 失败，未修改原生下载与阅读实现 |
| 完整浏览器 | 74 项通过，`.work/e2e/v037-final-full-results/.last-run.json` |
| 最后上下文修复回归 | 12 项通过，`.work/e2e/v037-final-context-results/.last-run.json`；覆盖 Galgame、来源导航、共用官网发行版本保留和直链任务的中文名称 |
| 实际原生来源 | 最终 exe 重启后恢复已保存来源作品，ATRI 58 条／安卓 28 条，CLANNAD 官方 32 条／中文 1 条；不再有动画跨季误提示，无外链批量下载按钮。`.work/v037-evidence/native-verification.json` |
| 静态扫描 | 最终 exe、NSIS 均通过；`.work/security-audit/v037-context-final-scan.json`；最终原生 session 无新增检测 |
| 原用户数据 | 9 个数据库表、3 个媒体文件、14 个旧 exe 保持，DB 完整性 ok；`.work/v037-evidence/data-preservation.json` |
| 桌面入口 | 指向 `START-ACGN-0.3.7.cmd`，图标取新 exe，继续使用原 `release/v0.3.2/Data`；`.work/v037-evidence/shortcut-verification.json` |
| 便携 ZIP | 9,565,661 字节，10 条目白名单、CRC 和逐项 hash 通过；不含用户资料。`.work/v037-evidence/delivery-assets.json` |

官方试玩／免费标记、具体语言和版本已按公开接口核对。原厂 LZH 仅检查 HEAD、Range、文件长度和文件头；没有将有限字节请求当作完整游戏下载。KUN 网盘的权限、存活与速度没有逐个验证。更多范围见 [0.3.7 交付记录](docs/research/galgame-v037-delivery.md)；源码与包上传至 [私有 0.3.7 发布页](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.3.7)。

## 最新增量：0.3.6 本地观看与统一作者搜索（验收及正式发布完成）

本轮最终交互为“同一搜索框输入作品名或作者名，直接看作品”，没有人物卡或预先选择模式。CBZ连续/单页阅读、全屏完整控件、TXT章节阅读、按作品目录及已下载同版接续已实现。最终正式程序的正常桌面、重启、数据保留和快捷方式已验收；[GitHub 0.3.6正式发布](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.3.6)及最终汇总已完成。下表区分工程测试、此前候选与最终程序；详细范围见[本轮记录](docs/research/local-viewing-v036.md)。

| 验证 | 当前证据与范围 |
| --- | --- |
| 全量Vitest | `.work/v036-unified-final-vitest.json`实际记录57个文件、450通过/0失败、success=true；覆盖作者姓名、来源版本、原生观看服务、章节解析及分组等，不代替真实桌面 |
| Rust | 本轮86通过/0失败/2默认忽略；包括归档读取/页序/边界、会话及视频Range等。默认忽略项不计为已运行通过 |
| 完整浏览器回归 | 67/67通过、4.1分钟，`.work/e2e/v036-unified-full-results/.last-run.json`为passed、failedTests=[]；固定响应覆盖不代表真实来源均可用 |
| 统一搜索缓存 | 初次缓存专项7项通过，`.work/e2e/v036-unified-cache-results/.last-run.json`为passed；最后空缓存/作者/历史返回7项定向回归22.1秒全部通过，`.work/e2e/v036-unified-empty-cache-results/.last-run.json`为passed |
| 官方作者API实查 | `.work/author-provider-live-smoke.json`：真实搜索入间人间取得人物6207，关联动画含安达与岛村/电波女与青春男，小说含说谎的男孩与坏掉的女孩；不把真实API结果当最终GUI已经通过 |
| 已修原生失败 | 初次本地页图失败对应1058…候选：整条`convertFileSrc`编码令路由`/page/`变为`%2F`；已改为只转换会话token再追加真实路由，测试替身同时采用官方整参数编码语义，旧失败保留 |
| 此前候选正常桌面 | `.work/v03-evidence/normal-v036-delivery/launch.json`为6D1B96886C123B210BF034EDA11461C1E238A580CA2C6E57EE02DA8709830438、PID38516、原032Data、无CDP/注入、防护开启；真实安达17页、连续滚动、全屏鼠标翻到第2页、返回恢复第2页已有截图/UIA |
| 候选证据限制 | 6D1B…仍含被用户否定的人物卡界面；`author-related-works`截图仅保留为历史，不作为最终统一搜索交互验收。该候选的扫描与运行不能移记到最终95D19A…程序 |
| 最终构建及扫描 | exe25,553,408字节，SHA256 `95D19AA77908C3E9056F5DE4E134D3C4D5BA8B7F5346165A78E342CD613403F4`；NSIS7,223,620字节，SHA256 `D0AFD2DD201473604821C2C18404205945F747DBC84665C3B003681BA1324A29`；`.work/security-audit/v036-unified-final-scan.json`两项退出0、防护开启、无新增检测，已打包，NSIS未安装 |
| 最终正常桌面身份 | `.work/v03-evidence/normal-v036-unified/launch.json`为正式`release/v0.3.6`同95D19A…、PID5620、2026-10-31T02:50:19Z启动、原032Data、无CDP/注入、防护开启；本次正常桌面复验使用该文件，没有移记旧候选证据 |
| 统一输入直接作品 | 最终session的`author-direct-work-results.json`/`.png`记录入间人间直接显示3部动画作品；`author-novel-results.json`/`.png`显示16项小说结果，其中1项标题相关、15项作者关联，不称16项全是作者作品。没有人物卡 |
| 漫画版本及第60话 | 同session的`manga-two-source-editions.json`和`manga-edition-chapter60.json`/`.png`实际查看不同来源版本、柚原もけ版75条目录及第60话22页信息；这是目录核验，没有重新下载全卷 |
| 最终漫画与正常重启 | `final-fullscreen-mouse-next.json`/`.png`实际全屏鼠标翻到第2页，`comic-continuous-final.png`显示连续阅读，`resume-page2-final.json`记录返回恢复第2页。PID5620正常退出0后，`normal-v036-restart/launch.json`记录同正式exe/原Data重启PID62636，`restart-resume-page2.json`/`.png`仍显示第2页；status无新增检测。用户已关闭GUI，不重开 |
| 数据与文件保留 | `.work/v036-evidence/data-preservation.json`为passed，DB完整性ok；10个来源ID保留，用户并行使用期间3条配置发生修改，保留当前值、不回滚也不称全表字节不变。原2任务/3资源/1作品/1外部ID/0本地索引保持，选版核验新增1作品（现2）；3个媒体payload（含CBZ）hash及12个旧exe不变 |
| 快捷方式 | `.work/v036-evidence/shortcut-verification.json`为passed：桌面入口指向START-ACGN-0.3.6.cmd与036exe图标，仍用原032Data；程序/安装包/清单已打包 |
| 便携ZIP | `.work/v036-evidence/delivery-assets.json`：`ACGN-Hub-0.3.6-windows-x64.zip`为9,556,150字节，SHA256 `8C1E8267F5D27DF0D451F9C21FCFE7CEE1DCBBC3C1AE9E2881F2D90ECEFDCD58`；10条目CRC及逐项hash通过、不含用户Data。VERSION附最终原生证据路径，exe/NSIS哈希保持上表 |
| 资产实际下载回验 | `.work/v036-evidence/github-draft-verification.json`为草稿阶段的实际下载passed回执：7资产大小/SHA256/API digest全部一致，下载ZIP10条目白名单/CRC/每项hash/noData、VERSION/SHA9项及外层6项校验通过；保留该阶段isDraft=true历史事实 |
| 私有源码及正式发布 | [正式发布远端核验](.work/v036-evidence/github-published-verification.json)为passed，仓库private=true、isDraft=false、非预发布，7资产远端metadata与上述实际下载hash一致；正式`v0.3.6`标签固定`427bbe48e646169e8aad8da63f8352abd2e01ac5`，发布核验时main/tag一致，后续main仅补发布文档回执 |
| 最终汇总 | [verification-final.json](.work/v036-evidence/verification-final.json)已实际生成、allChecksPassed=true，聚合450unit/86Rust（另2忽略）/67完整E2E/最后7项、最终正常桌面漫画与直接作品搜索/第60话目录/重启、数据、快捷方式、ZIP和GitHub；报告scopeLimits保留TXT/接续/视频的实际验证边界 |

旧用户文件不自动移动或重打包；阅读只读原始内容。漫画/小说接续只使用同作品同版、归属有效且已完成的文件；自动倒计时只在实际阅读到末尾且内容加载成功后触发。TXT阅读及自动接续主要通过固定响应场景验证，不称原生全卷下载与接续已实测。内置视频的模拟控件测试不证明本机所有编解码/字幕均可用，NSIS未实际安装。0.3.5及更早验收保持原日期、构建哈希和适用范围。

## 历史增量：0.3.5 真实书籍发现与流程修复（验收与正式发布完成）

已完成最终源码全量回归、构建、扫描、本地清单、真实35分钟漫画热门自动刷新、正式便携程序重启/正常退出、桌面入口、7附件实际下载回验及正式发布远端核验。最终汇总已实际生成并通过。不同候选的正常桌面证据分开标明；[本轮完整说明](docs/research/discovery-and-fixes-v035.md)保存接口依据、完整身份及验证范围。

| 项目 | 当前范围/待填结果 |
| --- | --- |
| 书籍发现与分类专项 | 16项书籍provider和9项Bangumi分类回归已有通过回执；真实六组合公开请求见 `.work/book-discovery-provider-live.json`，不是全站可用率 |
| 下载文件打开专项 | helper6项通过；原2项打开E2E加旧A/新B成品归属回归通过。首轮测试误拦.vue CSS失败与修正回执分别保留；模拟测试不代替系统播放器实际播放 |
| 其它专项 | 首页/书籍8项E2E、缓存13项、评分34项、catalog14项、来源管理2项E2E已有回执，最终完整套件另行52/52通过 |
| 本地记录P1与精确来源 | 存储失败保成品、取消A→新B复用路径、实时ownedOutputPath及同类型RSS的sourceId精确选择均已纳入最终390项unit/52项E2E；不宣称真实桌面满盘测试 |
| 全量TypeScript / Vitest | 源码及E2E TypeScript退出0；51文件/390通过/0失败，[Vitest回执](.work/v035-vitest-stable.json)及[计数汇总](.work/v03-evidence/normal-discovery-v035/automated-checks.json) |
| 全量Rust | 74通过/0失败/2默认忽略，直接调用退出0。首次stderr/Tee包装层错误返回1后直接调用复核，未抹去包装失败；[日志](.work/v035-rust-tests.log)及计数汇总分别保留 |
| 完整浏览器E2E | 52/52通过，2.3分钟、单worker，含一个48轮固定响应混合压力场景；[完整日志](.work/e2e/v035-release-final.log)、[报告](.work/e2e/v035-release-final-report/index.html)。该压力场景不是35分钟原生计时观察 |
| 最后文案校对 | KUN公开v1匿名目录提示澄清后，相关18项unit与7项来源E2E通过，17.3秒；[文案回归](.work/e2e/v035-wording-final.log)，没有功能改动 |
| 最终产物/扫描 | exe25,170,944字节，SHA256 `7F00CED820F1758FA35DC09858805E9AAC32EB9017FF24CD84DF40087809E7A1`；NSIS7,094,473字节，SHA256 `7494F6EE693AEBAD55D174DEE2339A426C0B87CB8CC4D11EEEF7809BA7E7FA1C`。两项[最终扫描](.work/security-audit/v035-release-final-scan.json)退出0、防护开启、无新增事件；NSIS未安装 |
| 最终正常桌面 | 最终7F00…/PID32412、原032Data、UIA-only；[启动身份](.work/v03-evidence/normal-discovery-v035-final/launch.json)，真实文学少女热门24部/8.5分、漫画21部，[最终小说截图](.work/v03-evidence/normal-discovery-v035-final/light-novel-loaded-final.png) |
| 前一候选桌面边界 | 84F8458C…候选的漫画21→45分页、付丧堂7高分9.1/详情/来源建议、精确类别参数、2条下载记录及MKV打开命令成功记录于 `.work/v03-evidence/normal-discovery-v035`。观察到OpenWith，不能称已播放；这些操作不混作最终7F00…的全部验收 |
| 真实35分钟自动刷新 | **passed=true**，elapsed2101.92865秒，71样本全部valid；UTC17:48:58.344→18:24:02.916，同PID32412/漫画/热门保持，页脚01:48:20→02:18:39自动前进1819秒，无失败或helper干预，keepAwakeReleased=true。[唯一观察汇总](.work/v03-evidence/normal-discovery-v035-final/refresh-observation-20261030T174858324Z-1dfb4e2b/summary.json)、[结束截图](.work/v03-evidence/normal-discovery-v035-final/passive-timer-final.png)；该次status无新增检测 |
| 数据保留与本地清单 | 最终正式程序重启后再次只读核对：10来源/2任务/1作品/2资源/1外部ID/0本地索引共6表原样、DB完整性ok，MP4/MKV内容hash及旧10个exe保持；[18:26:39Z回执](.work/v03-evidence/normal-discovery-v035/data-preservation.json)。release/v0.3.5已带notice5小文本并列清单/校验 |
| 便携ZIP | 已生成 `ACGN-Hub-0.3.5-windows-x64.zip`，9,389,201字节，SHA256 `EEE43144C524E075F543326753412E87F9295110699A2069A41411384CA32EC4`；10条目CRC通过、全部内部文件hash匹配、不含用户Data，[交付资产核验](.work/v03-evidence/normal-discovery-v035-final/delivery-assets.json)，已在正式Release发布 |
| 私有源码与标签 | 验证文档提交 `c989cb23fc227a98cfa844338a1b23a6984b2d57` 已推main；annotated tag v0.3.5 peeled同一提交，发布核验时main/tag一致，仓库private=true。标签固定，后续main文档回执不改生产代码 |
| 正式Release附件 | 7资产已实际下载，大小/SHA256全部匹配，下载ZIP的10条目CRC与内容白名单通过，无Data/媒体；[下载回验](.work/v03-evidence/normal-discovery-v035-final/github-draft-verification.json)及[正式发布核验](.work/v03-evidence/normal-discovery-v035-final/github-published-verification.json)均passed=true。isDraft=false，非prerelease，正式时间18:30:35Z |
| 正式便携程序重启 | [restart-verification.json](.work/v03-evidence/normal-discovery-v035-final/restart-verification.json) passed=true：release/v0.3.5/ACGN-Hub-0.3.5.exe同7F00…、原032Data、PID54160；UIA实际两完成记录/文件名/打开按钮，文学少女与链锯人精选/排序/封面墙正常、首屏封面已目视加载；正常退出0，关闭前后无新增检测、防护开、无CDP/注入。未做成品播放测试 |
| 桌面快捷方式 | [shortcut-verification.json](.work/v03-evidence/normal-discovery-v035-final/shortcut-verification.json) passed=true：桌面ACGN Hub.lnk指向START-ACGN-0.3.5.cmd，图标取035exe；原032Data不变、旧lnk已备份 |
| 正式发布与最终汇总 | [v0.3.5正式发布](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.3.5)已完成；[verification-final.json](.work/v03-evidence/normal-discovery-v035-final/verification-final.json)于18:30:48Z实际生成，allChecksPassed=true，完整聚合工程/扫描/长观察/重启/桌面/数据/ZIP/GitHub，不改变各项原验证边界 |

书籍源5项实际审计已完成，见[审计报告](docs/research/source-audit-v035-books.md)：中文漫画两个来源实际页图及繁中对白、LNovel正文、IA准确版本公开TXT均有证据；MangaDex原作《葬送的芙莉莲》当前feed为空，独立同人的成功图片没有记为原作成功。旧版本的整章下载、改名和BT证据保持原日期与文件身份。

## 历史增量：0.3.4 成品自动命名（发布验收完成）

本轮用户要求在下载完成后将文件改成可读名称。源码已实现默认开启的 aria2 单文件完成命名、同目录修改且保留扩展名；不能确定作品/集数时保留原名，多文件逐项预览，qBittorrent 不直接改名。命名独立状态不会将已完成下载改为失败。

| 验证 | 当前证据与范围 |
| --- | --- |
| 源码 TypeScript | `npm run typecheck` 退出0；完成命名 UI 与现有源码合约一致 |
| E2E TypeScript | `npx tsc --noEmit -p tests/e2e/tsconfig.json` 退出0 |
| 命名专项 | 修正固定样本后3/3通过，10.6秒；`.work/e2e/v034-naming-target-retry.log` |
| 完整浏览器回归 | 29/29通过，1.3分钟，单worker；[完整日志](.work/e2e/v034-naming-full.log)、[HTML报告](.work/e2e/v034-naming-full-report/index.html)，`.last-run.json`为passed/failedTests=[] |
| 首次专项失败 | 2过1失败；命名失败样本的files误沿用另一个原路径，因此原名搜索正确匹配两条；只改测试数据，首轮`.work/e2e/v034-naming-target.log`及失败trace保留 |
| 完整前端测试 | Vitest46文件/282项通过，单worker，15:49:24，18.26秒 |
| 完整Rust测试 | 73通过、0失败、2默认忽略；Windows junction实测通过，file symlink创建遇权限1314，仅验证防御分支 |
| 最终构建/扫描 | exe25,304,576字节，SHA256 `4CB9F77A28718A0EB307BC49BD3B5F24ACC0B63D74DEC7292FDC76AFD9D592FA`；NSIS7,021,828字节，SHA256 `1114406E109DF155FBD98E98EB08D8FA72D5F0CE27F4C6D9BBBDFBD6D88BA0FA`；[本轮扫描](.work/security-audit/v034-naming-final-scan.json)两项退出0、无新检测，未实际安装NSIS |
| 实际文件命名 | 原文件同目录改为“学生会也有洞！ - 第01话 [简中] [HEVC].mp4”，416,074,928字节，SHA256保持 `429D0C803E3772100CA04D4253D17E13793A161C0DBF035DF670D61E97C6B2FB`；[after.json](.work/v03-evidence/normal-naming-v034/after.json)，397/397片[复核通过](.work/v03-evidence/normal-naming-v034/piece-verification.json) |
| 数据库与重启 | 命名相关路径及记录一致，其余字段保持，0待恢复journal；无原本存在的本地索引行，mappedLocalIndexRows=0；首次正常关闭后以发布exe重启，完成记录/原名/现名及updated_at不变，[restart.json](.work/v03-evidence/normal-naming-v034/restart.json) |
| 防护与发布 | PID26224和重启PID40864均仅UIA，未用CDP/注入；Defender开启，08:14:22Z及08:16:49Z无新增检测，后者进程存活；release/v0.3.4及桌面升级入口已就绪，沿用原032Data |

浏览器覆盖默认设置持久化、可靠单集名称预览、手动编辑与固定扩展、多文件选择第02话不套第01话、未关联保留原名、qBittorrent提示、原名搜索、冲突命名仍为下载完成。新命名最终证据集中在[0.3.4验证](docs/research/download-naming-v034.md)；下述0.3.0–0.3.3记录作为各自构建的历史证据保留。

自动检查计数回执：[automated-checks.json](.work/v03-evidence/normal-naming-v034/automated-checks.json)。本轮数据库改名前在线备份已保留。首次同名确认误标restart的JSON已标invalid并单独保存，不作为重启证明；首轮打包版本标签错误亦未执行/扫描/发布。真实改名与重启均按0.3.4本轮文件身份记录，详细证据见[命名验证](docs/research/download-naming-v034.md)。

最终[汇总证据](.work/v03-evidence/normal-naming-v034/verification-final.json)allChecksPassed=true：10条来源配置、1条作品、1条资源及0条本地文件索引保持，数据库integrity_check=ok，交付4个文件逐一匹配清单。08:16:49Z存活观察后，发布程序于08:17:11Z正常退出code0；较旧0.3.3实例也于随后正常退出，不能声称整个验收期间没有旧实例。[最终运行记录](.work/v03-evidence/normal-naming-v034/final-runtime.json)明确正常退出，不要求保持运行或重开已关闭窗口。

**最新高清结果：** 用户要求更高清后，已实际取得同一投稿的 1920×1080 整集，297,193,506 字节、1772.2秒，首中末解码通过，SHA256 `C82BD498A17F5F64C494CF49E531B402EA48CF92FC5C923D4CDC009F112AF3ED`。旧360p是实现档位，不是本次投稿的匿名上限。高清成品、源码策略、测试及与旧App记录的区别见 [高清验证](docs/research/hd-quality-verification.md)。

记录日期：2026-10-29，更新至2026-10-30，Windows x64。最终交付为1EC07C构建：正常重启读取完成记录、显示实际1080p资源、打开本地浏览器预览，防护开启且观察窗口无新增检测。A68D的真实整集下载/解码/重启、漫画整章及取消证据保留；高清整集为另一次独立工具下载，不能混记为新构建整集重下。最终身份与边界见第8节。

## 1. 已验证的实际目标成品

作品身份为 Bangumi TV `554779`《学生会也有洞！ / 生徒会にも穴はある！》，别名《脑洞学生会！》。来源是普通公开投稿 `BV1UqHi6uEie`，没有使用 Cookie 或登录。

本次 App 正常 UI 完成的文件：

```text
D:\ACGN\.work\normal-video-profile\Files\Library\Anime\「脑洞学生会！」第1话【中文字幕】\「脑洞学生会！」第1话【中文字幕】.mp4
```

| 检查 | 结果 |
| --- | --- |
| 完整文件大小 | 73,446,668 字节 |
| 时长 | 1,772.2 秒 |
| 视频 | H.264，640 × 360，约 23.98 fps |
| 音频 | AAC，48 kHz，双声道 |
| 抽样解码 | 0、886.1、1767.2 秒附近均 exit 0、无错误 |
| SHA-256 | `0F7B9B2721536BF5A1E186A8C45803D0482CD9BA14015B932E196B609E41B5B7` |

本次成品检查记录为 [app-video-verified.json](.work/v03-evidence/normal-resume/app-video-verified.json)，完成页面见 [app-video-completed.png](.work/v03-evidence/normal-resume/app-video-completed.png)。最终 A68D 构建的正常 UI 实际下载、音视频合并和输出发布已通过，运行身份与流程见第 5 节。

此前独立 yt-dlp + FFmpeg 成品另存于 `D:\ACGN\Library\Anime\脑洞学生会\脑洞学生会 - 第01话.mp4`，原始证据为 [requested-public-video-verified.json](.work/v03-evidence/requested-public-video-verified.json)；该独立文件发布后也经只读 SHA-256 复核。两份成品字节数和 SHA-256 一致。此次新增的 App 成功证据覆盖正常 GUI 下载，不是保存种子、目录响应、25 秒片段或其它动画，也没有用独立 CLI 文件代替。

## 2. 公开投稿桥接的工程检查

新增正式能力：普通公开 BV 投稿 inspect / download / cancel，前端接入进度与结果；来源关键词结果包含上传者、时长及片段/合集警示。

- Python 语法检查通过；固定匿名选项本地断言通过：不读取 Cookie/浏览器账户/netrc，1 MiB HTTP 分段，25 秒 socket timeout，5 次重试。
- 历史A68D固定360p；用户高清反馈后取消该限制，优先公开可读取的AVC/M4A（默认上限1080p）。当前inspect对所选流读取检查，返回实际画质；1080p成品另有高清验证，不将列表当作下载承诺。
- 注册原生命令后 `cargo check --lib --offline` 通过。
- 使用仓库 MSVC / Windows SDK 环境，`cargo test --lib --locked public_video::tests --offline` **3 / 3** 通过：普通 BV/分P白名单、取消仅作用指定注册任务、MP4 冲突保护与无覆盖发布。
- 该轮前端 typecheck 及公开投稿 provider / discovery 专项 **18 项**通过。
- A68D阶段工程快照：41文件/204项Vitest、37项Rust通过（1项忽略）、Python9格式+4恢复，17浏览器场景跨运行覆盖。当前高清阶段检查为205项Vitest、39项Rust通过（1项忽略）、Python10格式+4恢复；高清专项与最终原生检查见第8节，不把浏览器模拟结果当公网成品。
- 下载页 MP4/CBZ/TXT 合并统计、筛选、空态和实际百分比，以及窄范围原生媒体打开命令已纳入回归；正常 UI 下载/完成现另有真实证据，视频打开行为仍需单独核验。

证据：[public-video-bridge-local-checks.json](.work/v03-evidence/public-video-bridge-local-checks.json)。这些检查没有再次联网下载整集，没有启动被拦截 GUI，也不证明安全软件检测是误报。

恢复检查见 [public-video-recovery-checks.json](.work/v03-evidence/public-video-recovery-checks.json)：实际使用 yt-dlp 在本机 loopback HTTP 服务验证 Range 续传，没有公网请求、GUI 或整集重下。设置 `continuedl=true`，最多 3 次外层恢复（首次加恢复共 4 轮），总原生处理上限 1800 秒；403/412/429 再解析次数为 0。这证明局部恢复机制，不证明目标公网整集完成。

续传修正后的程序、NSIS 与对应静态扫描已落盘，文件身份见第 3 节；新的 normal-resume 已完成公网目标整集，成品通过解码，见第 5 节。不能沿用较早构建的静态结果，也不能将本机工程回归替代这份公网生产证据。最新 Rust/Python 工程回执为 [native-final-checks.json](.work/v03-evidence/native-final-checks.json)。

最终前端回执见 [frontend-final-checks.json](.work/v03-evidence/frontend-final-checks.json)：`npx playwright test` 退出 1，17 项中 16 项通过；唯一失败项为发现页放送表/封面点击流程的全局 `Test timeout of 30000ms exceeded`。随后仅筛选该项重跑，产品、测试、固定响应与超时设置均未改，单项耗时 11.0 秒并退出 0。该记录保留整套超时事实，不把最新 `.last-run.json` 的单项成功当作完整 17/17 回执；未独立证明超时根因。浏览器的站外请求和原生视频边界采用固定响应，不能证明真实站点或公网下载完成。

## 3. 已知安全拦截与生产验证边界

在原生漫画下载诊断中，Defender Operational 的 1116 / 1117 事件与同一程序、PID 和时间对应：检测为 `Behavior:Win32/LummaStealer.CER!MTB`，随后对测试 `acgn-hub.exe` 执行删除处置。进程退出不能继续当作 Rust 普通异常或整章下载成功。

- 已停止重复启动被拦截 GUI；未关闭防护、增加排除或改名规避。
- aria2 官方发行物、yt-dlp / imageio-ffmpeg 官方 wheel 与本机对应代码/二进制已核对；Cargo 缓存也有完整性检查。
- 来源和字节一致不等于行为安全审查完成，不能据此直接判定误报。
- 2026-10-29 23:34 的本次发布文件 Defender 自定义扫描退出码 **0**，输出“found no threats”，检查窗口内没有新增检测事件。扫描未执行应用。
- 随后一次正常窗口、独立资料库、防护开启、无 CDP 的漫画 UI 下载流程通过；最终续传构建也另有公开投稿整集正常 UI 下载与解码成功证据，见第 5 节。单项流程不能代替所有功能或长期运行结论。

本次静态扫描对应文件如下；源码或构建变化后不能沿用这一文件的结果。

| 项目 | 值 |
| --- | --- |
| 路径 | `src-tauri/target/release/acgn-hub.exe` |
| 版本 / 大小 | 0.3.0 / 24,498,176 字节 |
| 构建文件时间 | 2026-10-29 23:33:31（UTC+8） |
| SHA-256 | `5AA70E23439B24CD736A8F86E05A89C63B165BFBAEEDAD480802F843BE9305A4` |
| 扫描窗口 | 2026-10-29 23:34:03–23:34:05（UTC+8） |

原始扫描证据为 [v030-custom-scan.json](.work/security-audit/v030-custom-scan.json)。历史拦截、组件摘要和已知边界见 [security-interception.md](docs/research/security-interception.md)。正常 UI 漫画通过不抹去历史拦截，也不能直接判定误报。

### 续传修正后的程序与安装包静态扫描

2026-10-30 00:30:42–00:30:52（UTC+8），对新程序和 NSIS 安装包分别执行 Defender 自定义静态扫描，两项均退出 **0**、报告未发现威胁，检查窗口内没有新增检测事件。扫描没有执行应用或安装 NSIS。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `src-tauri/target/release/acgn-hub.exe`，0.3.0，00:30:23 构建 | 24,588,288 字节 | `A68D22165AF939500684E5E0F429CD30722B60AFF9A73523C857F33E98A3C2EA` |
| `src-tauri/target/release/bundle/nsis/ACGN Hub_0.3.0_x64-setup.exe`，00:30:22 构建 | 6,850,346 字节 | `C8ED03D00DEFA923D7D04516A55ADDC4F2B3F1B4F14D7FF7D0A738B916FEC48D` |

证据：[v030-recovery-bundle-scan.json](.work/security-audit/v030-recovery-bundle-scan.json)。这两份文件与上表较早程序、先前正常漫画/视频 UI 运行各有独立身份；本次静态扫描不证明整集下载或安装流程完成，也不构成历史行为检测为误报的结论。

## 4. 用户目标的来源边界

| 路径 | 已确认的实际结果 | 没有据此声称 |
| --- | --- | --- |
| B 站公开投稿 URL | 独立工具和最终 App 正常 UI 均完成目标整集；成品解码通过，真实取消另有证据 | 匿名关键词自动搜通、1080p 可下载或所有投稿都可下载 |
| B 站匿名关键词搜索 | 同机 API 412，官网 200 为验证码页，没有有效搜索结果 | 自动关键词检索已搜通 |
| 蜜柑 / AcgnX | 目标 EP01–04 的真实 BT 目录；Mikan 4064 与 Bangumi 554779 已核对 | Torrent 的 HTTP URL 是视频直链 |
| 真实目标 BT 任务 | 本轮记录 error 7，下载 0 字节，0 连接 / 种子 | BT 内容已完成传输 |
| CopyManga 原作 | 准确 path `naoodngxueshenghui`，233 章；第 1 话 17 页已在正常 UI 下载并生成 CBZ，见第 5 节 | 所有章节/来源或最终新构建均已验收 |
| Archive 的目标别名检索 | CM/PV 与 25.04 秒 Media History，未找到目标正片 HTTP | 片段可替代目标视频 |
| 官方配信站 | 找到对应官方观看页面 | 页面 URL 可作为 MP4、或可以绕登录/DRM下载 |

目标来源参数在 [requested-title-resource.json](.work/real-workflow/requested-title-resource.json)；失败 BT 记录在 [requested-episode-download.json](.work/v03-evidence/requested-episode-download.json)。[目标来源核对](docs/research/naodong-student-council-sources.md)描述的是当时目录查验，不覆盖随后公开投稿成品成功的结果。

对《葬送的芙莉莲》的真实只读检查曾修复来源匹配和 Archive 截断顺序，不能拿另一部作品的链接代替用户当前目标。

## 5. 0.3 已记录的界面与原生局部流程

### 正常 UI 的目标漫画整章成品

在 fresh `.work/normal-ui-profile` 中正常启动窗口（PID 53276），不使用 CDP、远程调试或注入，实际操作“搜索脑洞学生会 → 选择原作 → 读取 233 章节 → 第 1 话 → 下载 17 页 → 生成 CBZ”。成品 **3,957,320 字节**，SHA-256 为 `4001481CBFCCF44E5B1B73F18FDB5E255086A5FFB4ED3A914365A0E12102ECFB`；ZIP CRC 与全部 17 页 PIL 解码通过。

截至 23:43:19，进程仍存活，检查窗口内没有新增 Defender 1116/1117 事件。证据：[chapter-verified.json](.work/v03-evidence/normal-ui/chapter-verified.json)、[manga-completed.png](.work/v03-evidence/normal-ui/manga-completed.png)。这一结果对应当时测试构建和流程，不能推广为之后重建的公开投稿下载或全部 App 功能已通过。

### 正常 UI 的公开投稿解析与真实取消

2026-10-30，正常窗口、无 CDP 的独立资料库中，完整投稿 URL 可匿名解析到目标第 1 话、29:32 时长与上传者，显示游客 360p 后开始实际 MP4 下载。约 1% 时执行取消，自有 Python PID 34108 退出，清理本次临时目录，没有留下最终 MP4；主程序存活，该检查窗口无新增 Defender 事件。证据：[取消前子进程](.work/v03-evidence/normal-video/children-before-cancel.json)、[取消后子进程](.work/v03-evidence/normal-video/children-after-cancel.json)、[video-cancelled.png](.work/v03-evidence/normal-video/video-cancelled.png)。

该次视频 UI 运行身份由 [launch.json](.work/v03-evidence/normal-video/launch.json)记录：SHA-256 `876AA86A9ECB18A5B9B885E1A901CE891D1472F3FB47EE9B14D5393B4E3E84A8`、PID 53620，防病毒和实时防护开启，无远程调试/CDP/脚本注入；它与第 3 节较早静态扫描文件的哈希不同，不能混用扫描身份。

第二次整集 App 下载在约 **40%** 时失败，错误为分段读取不完整（`3372 bytes read / 1035103 more expected`），5 次重试后放弃，**没有产生成品**。证据：[video-network-failure.png](.work/v03-evidence/normal-video/video-network-failure.png)。截至 2026-10-30 00:12:55，PID 53620 持续存活、没有新增 Defender 事件，之后正常关闭。这次失败属于已记录的网络传输失败，不能写成整集通过，也不能与早前安全软件处置混为一谈。

同任务内保留暂存分段、有限网络续传与 URL 刷新已实现并通过上述本机恢复检查，不对 403/412/429 自动再解析；UI 已接续传说明。新构建已完成并静态扫描，normal-resume 公网目标整集也已完成，详见下节。BV 号曾被应用相似度过滤的问题已修并加回归；不把修复或模拟边界测试当实际传输完成。

另有 [cleanup-after-failure.json](.work/v03-evidence/normal-video/cleanup-after-failure.json)确认旧失败流程结束后，包含隐藏项的剩余文件与自有 stage 数均为 0；[runtime.log](.work/normal-video-profile/Logs/runtime.log)保留正常关闭记录，不能将这次关闭误记为外部异常终止。

匿名关键词检索是另一个未通过的边界：[bilibili-anonymous-search-20261030.json](.work/security-audit/bilibili-anonymous-search-20261030.json)记录同机官方 API HTTP 412，普通 User-Agent / Referer 仍为 412；官网 HTML HTTP 200，但标题为验证码页、BVID 数量为 0、没有搜索结果。没有发送 Cookie、登录、处理验证码或指纹模拟，不能宣称自动关键词检索可用。

### 最终构建正常 UI 的目标整集 MP4

2026-10-30 00:32:19 正常启动最终 A68D 构建，PID **35708**，复用隔离的 `.work/normal-video-profile`，未使用 CDP、远程调试或注入，防病毒与实时防护均开启。[launch.json](.work/v03-evidence/normal-resume/launch.json)的 SHA-256 与第 3 节续传程序静态扫描身份一致。

实际使用“下载页粘完整 BV URL → 自动转到公开投稿来源 → 确认目标候选 → 29:32 / 游客 360p → 下载”流程，最终显示完成并发布 MP4。文件 **73,446,668 字节、1,772.2 秒**，H.264 **640 × 360**、AAC 48 kHz 双声道；0、886.1、1767.2 秒附近抽样解码均退出 0、无错误。SHA-256 为 `0F7B9B2721536BF5A1E186A8C45803D0482CD9BA14015B932E196B609E41B5B7`，与先前独立成品一致。证据：[app-video-verified.json](.work/v03-evidence/normal-resume/app-video-verified.json)、[完成页面](.work/v03-evidence/normal-resume/app-video-completed.png)、[准确候选](.work/v03-evidence/normal-resume/final-bv-candidate.png)。

截至 **00:42:26**，[status.json](.work/v03-evidence/normal-resume/status.json)记录主程序仍存活、检查窗口内没有新增 Defender 1116/1117 事件。这份正常 UI 成功结果保留先前网络失败与 CDP 诊断拦截事实，不能据此把行为检测认定为误报。此次整集成功也不证明运行中必然触发过外层恢复，恢复本身另有本机 Range 回归证据。

### A68D 正常重启后的完成记录

下载运行正常关闭后，同一 A68D 程序于 **08:02:53** 复用该隔离资料库正常启动（PID **60352**），仍无 CDP、远程调试或注入且防护开启。[重启身份](.work/v03-evidence/normal-restart/launch.json)与上述程序一致；进入下载页完成筛选后，目标 MP4 仍显示已完成 **100%**、1 个完成任务、原输出路径，文件 SHA-256 仍为 `0F7B…B5B7`。证据：[completion-after-restart.png](.work/v03-evidence/normal-restart/completion-after-restart.png)。

截至 **08:07:56**，[重启状态](.work/v03-evidence/normal-restart/status.json)为存活、无新增 Defender 事件；随后正常关闭，[runtime.log](.work/normal-video-profile/Logs/runtime.log)中 PID 60352 保留 close requested、destroyed、exit 与 event loop returned code 0。点击“打开文件”没有界面错误，但播放器未出现，因此打开行为尚未通过。当前针对 Windows 规范化路径兼容问题作最小修正，后续构建需对应新的文件身份、扫描及打开验证；不重下整集，不将 A68D 的下载证据改记为新构建实际重下。

### 较早的局部界面检查

[.work/v03-evidence/results.json](.work/v03-evidence/results.json)记录了重做阶段 5 项局部通过：真实放送表/封面解码、作品封面点击与在看进度重载、CopyManga 精确原作章节、HTTP 字节校验、内置 BT 父子 GID 与本地 WebSeed。

这些结果发生在当前最终桥接加入前，且本地 WebSeed 并非目标公网种子；不代表当前发布构建的全部生产流程已通过。图片、真实源目录和目标视频成品各有不同范围，不能只汇总一个“passed”就得出全应用可用。

## 6. 历史回归与数据保护

旧 0.2 阶段曾记录 152 项 Vitest、25 项 Rust、8 条固定响应界面流程与 1 条启动恢复专项，以及隔离资料库中的 SQLite/事务/整理/Range 续传等检查。这些是历史回归证据，**没有作为 0.3 本轮最终验收重新计数**。旧 `release/` 中的 0.2 程序、安装包及其旧 SHA-256 不再列为当前交付物。

数据保护实现继续保留：SQLite 不静默切换存储；旧记录先预览再导入并跳过冲突；原文保留；活动任务暂停；输出文件不覆盖；清理仅作用本次拥有的临时目录。全量工程测试与安装包验收结果需与最终构建另行对应。

## 7. 本轮验收范围与待验证项

本轮最终范围为本机便携式程序真实完成目标整集、校验成品解码，并正常重启确认任务记录。NSIS 仅打包与静态扫描，未实际安装；不将改动现有安装或注册表列为本轮必须完成项。

1. 最终续传构建的公开投稿 MP4 正常 UI 下载已完成，对应第 3 节文件身份及扫描、第 5 节成品证据，不覆盖已经记录的正常 UI 漫画结果。
2. 防护开启且无 CDP 的正常 UI 准确候选 → 游客画质说明 → MP4 成品与完成页面已通过；匿名关键词搜索仍受 412/验证码限制。
3. App整集/解码与A68D重启记录已通过；历史默认Xmp未响应，最终MP4改为本地浏览器预览，已观察到窗口、正确时长和播放控件。约1%时真实取消已通过；恢复与输出冲突另有工程证据。
4. 小说 TXT、其它来源/章节和后续构建的运行边界继续单列，不因本轮便携式程序单项通过而宣称全部通过；目标漫画一次正常 UI 整章/CBZ 已单独通过。
5. NSIS 安装行为未验证，仅保留打包及静态扫描结果，不把未执行的安装测试写成已通过。

## 8. 最终高清交付构建

- 程序SHA256：`1EC07CE74907FD14CE301F02906EF6D18823F27F00CFB37A5F0144231E95608B`，24,613,376字节。
- 安装包SHA256：`B37C1C04748C99A3ABDCA672E8DEE45FEF67B22B289C4F63B95A3E3E809A73B6`，6,855,001字节。未实际安装。
- [最终静态扫描](.work/security-audit/v030-hd-preview-final-scan.json)两个文件均未检出；[正常启动身份](.work/v03-evidence/normal-hd-preview/launch.json)对应同一程序，PID23660，无远程调试/注入，防护开启。
- 正常启动后完成记录保留；点击打开文件后实际出现Edge本地预览窗口，UIA读取时长1772.2026秒与播放/暂停控件。[预览证据](.work/v03-evidence/normal-hd-preview/playback-verified.json)中的进度值为0，不将此说成已经播放过若干秒。
- [资源页截图](.work/v03-evidence/normal-hd-preview/actual-1080p-resource.png)及[辅助功能快照](.work/v03-evidence/normal-hd-preview/last-accessibility.json)实际显示1080p；本次没有再次通过App重下整集。
- [运行状态](.work/v03-evidence/normal-hd-preview/status.json)为存活、无新增1116/1117，随后正常退出，runtime.log保留对应PID的exit code0。
- 高清成品为297,193,506字节、1920×1080、29:32，首中末解码通过，另有[高清本地浏览器预览](.work/quality-research/hd-browser-preview.json)读取正确时长。[完整高清验证](docs/research/hd-quality-verification.md)区分文件与应用检查。
- 当前检查：41文件/205项Vitest；39项Rust通过、1项外网probe忽略；Python格式10项与恢复4项通过。高清相关浏览器3项通过，画质后缀后专项MP4流程通过；历史17场景跨运行覆盖按原始记录保留。
- 交付文件及校验和在[release/v0.3.0](release/v0.3.0/使用说明.md)，不带用户DB、测试profiles或媒体。关键词匿名搜索412/验证码、其它来源覆盖和未安装NSIS限制保留。

## 9. 0.3.1 新增漫画源交付

- 新增 MangaBZ（中文日漫）、WeebCentral（英文漫画）、快看官方公开免费章节，默认停用；保留已有来源和凭据，v17只补充缺失预设。旧localStorage来源仍非空/损坏时自动补充会跳过，可在来源管理手动添加预设。
- 第一份 `D01B3468…ECE2BD` 构建在正常UI完成 MangaBZ《葬送的芙莉蓮》第1话39页和快看《怦然心动》第1话151片，CBZ分别9,357,847和20,870,265字节，ZIP CRC与全部页面解码通过。快看全部宽1280。
- 同次真实UI发现WeebCentral正常详情页的Cloudflare被动脚本被误判为挑战。已修复，补全新provider和真挑战拒绝回归；没有执行脚本或绕验证。
- 最终程序SHA256为 `8DABCBD80AF334490F5C81357EACE124AE5A1A82F1685F3C7A6671A2BC568BA5`，24,626,176字节；安装包 `C40897ED1CB0932EDAA68F335A71979D921D5B44258002704BF501EDFC5E06D3`，6,866,323字节。两项重新[静态扫描](.work/security-audit/v031-manga-corrected-scan.json)通过；NSIS未实际安装。
- 最终构建通过正常UI搜索Frieren、准确选择→147章→第1章→39页CBZ，17,029,892字节，全部解码通过，实际页高1600、宽1067–2133。按真实JPEG命名，修复URL标PNG的问题。
- 同一最终构建再次正常重启，三份完成记录保留。11:04:49（UTC+8）进程存活且无新增Defender事件，随后正常关闭。无CDP、远程调试、注入，防护保持开启；不据此认定历史行为检测为误报或所有功能均通过。
- 最终源码45文件/258项Vitest通过；Rust45通过、1外网probe忽略；完整浏览器21通过，Weeb修复后定向4通过。浏览器首轮测试假设失败及真实Weeb失败分别保留，不用fixture结果替代公网成品。
- [三章成品与构建汇总](.work/v03-evidence/normal-manga-v031/verification-final.json)、[重启截图](.work/v03-evidence/normal-manga-v031-restart/three-records-after-restart.png)、[详细来源验证](docs/research/manga-sources-v031.md)。交付为[release/v0.3.1](release/v0.3.1/使用说明.md)，不带用户资料；旧0.3.0两产物实际hash仍与其manifest一致。

## 10. 0.3.2 季度首页与两源撤下

按用户追加要求撤下WeebCentral、快看，保留其它来源。首页从独立的季度首播目录加载作品，支持本地季度自动跟随、往季切换与返回、分页及同季缓存；继续保留每周放送表。官方接口实测单次上限20，正式provider聚合20+4为界面一页24，避免按24偏移却只取得20而跳项。

- 最终程序 `DE8827C7B2164B27A1ABA57E69F8BAF3CA37B91ED466DAF10DF844834DBA9CDB`，24,618,496字节；NSIS `D9FF94A9F0CFC38D9D3F18E2B5BEE5D80C3A29C2FDCEECD8A7A752B8496C46A8`，6,860,091字节。两项[重新静态扫描](.work/security-audit/v032-season-final-scan.json)通过，未实际安装NSIS。
- 最终构建正常UI实测秋季24/158→加载到48，夏季24/252及回本季，真实封面随选季更换；没有使用旧周历或跨季缓存冒充季度作品。
- 以独立旧测试资料库副本验证升级，来源12→10，仅指定2项删除，其余完整配置hash不变；全部非来源SQLite记录hash不变。旧3份完成任务可见，成品文件现存hash与逐页校验记录一致；没有重新下载或删除媒体。
- 无CDP/远程调试/注入，防护开启，12:14:53（UTC+8）进程存活且无新增检测，随后正常退出。源配置清理发生于来源store初始化，不能把尚未打开来源时的原DB计数误记为迁移完成。
- 44文件/241项Vitest通过，Rust45通过/1外网probe忽略；相关6项界面回归通过，跨年自动更新使用模拟时钟，未改系统时间。首轮测试旧文案/HMR失败与修正后回执分开保留。
- 最终冻结代码完整Playwright23/23一次通过（49.5秒），无失败/跳过，独立[完整回执](.work/e2e/v032-full.log)和[HTML报告](.work/e2e/v032-full-report/index.html)保留。
- [详细行为与证据](docs/research/season-discovery-v032.md)、[逐项校验](.work/v03-evidence/normal-season-v032/verification-final.json)。[release/v0.3.2](release/v0.3.2/使用说明.md)独立交付，旧0.3.0和0.3.1的发布文件hash仍保持一致。

## 11. 0.3.3 原用户蜜柑BT任务完成

用户原任务`a083f62b-c2f3-43a4-b786-5791216e8e2d`先前错误7、0字节。修复零速硬停、DHT引导、引擎/GID恢复、设置同步和状态诊断后，继续真实定位到Tracker顺序：原36个tier串行等待，已验证可用者位于第8/9。正式native仅对公开Mikan种子限时探测原Tracker并优先阳性，私有/失败/无结果保持原设置，不复制NDM项目代码或程序。

- 原任务已通过正式UI实际完成416,074,928字节，1920×1080 HEVC Main10+AAC、1420.04秒。**397片SHA1全部匹配原torrent**，首中末音视频解码均无错误；成品SHA256 `429D0C803E3772100CA04D4253D17E13793A161C0DBF035DF670D61E97C6B2FB`。
- 217,792,512字节处正常UI暂停、退出，最终构建重启显示207.8MiB，继续后保留原文件分片并完成。正式发布exe重启也保留完成记录。没有换任务ID、source URL或目录，DB仍只有原1条下载记录。
- 最终程序24,811,520字节，SHA256 `11E35E1BC939EFCF99DF54E3BF79AFCF8B9828DEEB2CEFCA7A517C7432DD9767`；安装包6,926,462字节，`88160BCDEFE63562F584557A78F927D5BB90F1FAB978F8665A22AAEE80F39E04`，未实际安装。两项[最终扫描](.work/security-audit/v033-bt-resume-final-scan.json)通过。
- 最终正常UI无CDP/注入，防护开启，15:10:59与发布重启15:12:39（UTC+8）均存活且无新增检测/处置事件；不据此抹去历史拦截或判断误报。
- Vitest44文件/263通过；Rust62通过、2默认忽略（本地真实metadata审计另显式通过）；完整浏览器26通过，最终两窄修后另有BT专项3通过。并行检查曾内存分配失败，已记录并以受限并发顺序完成最终检查，不能把失败算通过。
- [最终逐项证据](.work/v03-evidence/normal-bt-v033-final/verification-final.json)、[详细报告](docs/research/bt-download-v033.md)、[完成截图](.work/v03-evidence/normal-bt-v033-release/completed-after-release-restart.png)。桌面已更新至0.3.3并沿用原Data，用户任务/设置/文件及旧发布产物保留。
