# 0.3.5：真实书籍发现、统一品牌及流程修复

状态：验收与正式发布完成，2026-10-31。[v0.3.5正式发布](https://github.com/CidneyAurum/ACGN-Hub/releases/tag/v0.3.5)对应私有仓库annotated tag，固定提交c989cb23fc227a98cfa844338a1b23a6984b2d57。冻结源码全量测试、最终构建/扫描、真实35分钟漫画热门自动刷新、正式便携程序重启/正常退出、桌面入口、数据保留、7附件实际下载回验及正式远端核验均通过，verification-final.json已实际生成allChecksPassed=true。本文按二进制身份分开记录候选和最终文件；后续main仅补充文档回执，不改生产代码。

## 用户可见变化

漫画和轻小说首页不再仅显示空收藏：新增真实作品精选、封面、简介、评分、标签、收藏与推荐墙，并保留个人书架。热门、高分、近一年热门各自可切换、刷新和加载更多；进入详情、返回及直接访问分类链接保留对应分类/排序。

品牌统一为紫色底、叠放收藏书签与星标，站内、favicon和Windows图标采用同一SVG几何图形，没有角色立绘或AI生成图片。源SVG在 `src-tauri/icons/icon.svg` 和 `public/brand/acgn-mark.svg`，多尺寸ICO在 `src-tauri/icons/icon.ico`；这些是源码仓库路径，不意味着发布目录附带全部源图。

下载中心给普通引擎完成任务增加“打开文件”。单个可用成品直接打开；多个文件须先选择登记路径，脚本和未支持类型不进入选择器。MP4/MKV等由系统默认程序处理，适合HEVC成品；旧公开投稿的本地MP4浏览器预览保留。改名、删除或打开操作忙时阻止重复操作。已整理路径必须位于原任务目录或明确配置的Library/Incoming/下载目录，既不把任意父目录当允许根，也不回退已移动的旧引擎路径。

本地生成任务遇到记录存储失败时，保存已确认成品和本次窗口中的任务结果，提示重试保存/导出；待保存期间禁止备份重建丢弃内存结果。进一步修复取消A后B复用同一路径时旧清理权限删除新成品的问题；打开按钮和处理器都读取实时ownedOutputPath，旧完成记录不能打开B。相同RSS类型的精确sourceId选择也已修复。这些均纳入最终390项unit和52项完整E2E，未进行真实磁盘写满测试。

## 真实Bangumi数据与更新规则

使用 [Bangumi 官方项目](https://github.com/bangumi/api) 的 [OpenAPI契约](https://github.com/bangumi/api/blob/master/open-api/v0.yaml)及公开 `POST https://api.bgm.tv/v0/search/subjects`，不需要账号、Cookie或付费接口。条目本身、封面、简介、评分人数和评分均来自实际响应；0分或无有效评分显示“暂无评分”，不补造分数。

| 分类/排序 | 实际条件 |
| --- | --- |
| 漫画 | `type:[1]`、`tag:[漫画]`、`nsfw:false`，再依据明确platform和可信标签防止跨媒介误分 |
| 轻小说 | 同为书籍type1，但标签需有可靠轻小说类别；普通小说及少数读者的玩笑标签不能自动当轻小说 |
| 热门推荐 | 上游 `sort:heat`，即收藏人气；不称小时热榜或章节更新时间 |
| 高分佳作 | 上游 `sort:score`，评分人数至少50，响应中再次核对 |
| 近一年热门 | 本地日期滚动一年发售日期窗口，加 `sort:heat`；API没有recent日期排序，不将其标成“最新更新” |
| 作品分页 | 每显示页消耗24个上游位置；API实际单次最多20，按20+4拼接，无跳过4条。严格过滤后显示数量可以少于24 |

书籍缓存按分类、排序、页隔离，TTL30分钟；失败只回退相同列表的缓存，并显示原更新时间。切换分类、排序或页会取消旧请求，旧回执不能覆盖新视图或晚写缓存。临时网络/429/5xx最多一次有限重试，整体有超时；损坏缓存不能阻断远端重新加载。

书籍组件每分钟检查到期，窗口焦点/页面恢复可见时按需刷新，网络恢复时刷新空结果或旧缓存；近期列表跨本地日期重新计算窗口。不会每秒轮询整个站点。动画页继续按本地年/月自动跟随1/4/7/10月季度，在分钟时钟及重新聚焦/可见时同步；手选往季保持手选，不在跨季时强制跳走。每周放送表是独立数据。

2026-10-31实际provider六组合核验，见 `.work/book-discovery-provider-live.json`：漫画热门21、高分21、近一年22个有效封面；轻小说热门24、高分19、近一年24个。此时近期窗口为 `>=2025-10-31` 且 `<2026-11-01`，轻小说近期上游total670，部分上游total显示1000上限。当前数字会随服务数据变化，不写成静态推荐名单或覆盖率承诺。

## 针对性修复

- 缓存读取：隔离损坏/不符合契约内容，不让失效缓存阻止正常请求；不把跨分类内容套到当前页。
- 封面：原生请求与浏览器图像按可见区懒加载，首屏精选明确立即加载；切图后的旧load/error事件不覆盖当前封面，超时或失败能单独重试。
- 评分：统一读取Bangumi与VNDB的实际评分字段和尺度，不将已有百分制数据混作十分制；缺失、不合法和0分不显示伪评分。
- 导航：复用详情组件切换作品、旧详情请求迟到、搜索分类和资源链接的query保留分别处理，推荐记住真实作品身份后进入详情。
- 资源与来源：统一用途、所支持媒介和优先级；按分类过滤只改变视图，不删除自定义配置。慢连接检查完成时只更新诊断状态，不覆盖期间修改的URL、Token或启用状态。
- 成品打开：只处理completed登记的媒体/书籍，Windows大小写与斜杠正规化，防同名前缀目录、相对路径与父路径；最终仍由原生检查普通文件和canonical路径。默认MP4预览参数保持旧调用兼容。
- 本地记录：存储失败与下载文件生成成功分开保存，后续迟到错误不能删除已发布成品；pending可重试和导出，损坏的启动记录仍沿用独立原文备份流程。

## 下载源筛选结果

展示顺序来自统一 `source-catalog.ts`，排序依据用途，不是硬编码绿色“全站可用”。不自动改变用户既有地址、认证或启用选择。

| 媒介 | 优先入口 | 备用/索引及限制 |
| --- | --- | --- |
| 动画 | 蜜柑、AcgnX等动画RSS，确认作品和集数后由内置aria2/可选qBittorrent处理 | 公开投稿需Python/yt-dlp/FFmpeg且核对上传者/时长；IA是公开档案，不能把测试片或二创当正片 |
| 中文漫画 | MangaBZ、拷贝 | MangaDex多语原图备用，原作可能只有索引无可下载章节；拷贝当前匿名样本能下，受限时才登录 |
| 中文轻小说 | LNovel逐卷中文TXT | TXT无插图；IA公开电子书辅助，语言、格式、版本及下载权限需逐项核对 |
| Galgame | 新v1公开目录可匿名检索 | 分享网页不是文件直链，部分站外分享仍需原站条件；不宣称所有文件可直接下载 |

完整书籍链路、真实像素和正文检查见[书籍源审计](source-audit-v035-books.md)。MangaDex原作芙莉莲feed为空是本轮明确负例；同人的图像成功不能替代原作。WeebCentral、快看不恢复；JMComic维持可选桥接，本轮不主动访问成人内容。[动画及Galgame实审](source-audit-v035-anime.md)另外记录KUN新v1匿名公开目录及站外资源边界，不把旧picker的401说成当前公开目录必须登录，也不把索引当文件下载成功。

## 已有专项与最终回归

| 专项 | 已有结果/边界 |
| --- | --- |
| 书籍provider与Bangumi分类 | 16+9项定向单测已有通过回执；包含真实一票“罪与罚”误标回归 |
| 下载成品打开helper | 6项通过，覆盖完成条件、受支持扩展、Windows/UNC/POSIX、越界与整理后路径 |
| 下载打开E2E | 初期2/2通过，之后增加旧A/新B路径归属回归，与4项公开视频场景合计7/7通过于 `v035-owned-output-results`。native边界为固定模拟；首轮测试误拦.vue CSS的2失败单独保留 |
| 首页/书籍E2E | 初期8项专项通过，后续纳入最终52项完整套件 |
| 缓存/评分/catalog | 13/34/14项专项已有回执，最终完整源码unit另计390项，不将专项简单相加 |
| 来源管理E2E | 2/2通过，分类切换不丢配置、慢检查不覆盖编辑/启用状态 |
| 品牌图标 | `.work/brand-icons/verification.json` 核查ICO帧和透明角，接触表为同目录 `contact-sheet.png`；源图改变后需重新取hash |
| 本地生成存储/取消P1、精确RSS选择 | 均已纳入最终390项unit及52项完整E2E；旧快照与重复cleanup不能取得新成品权限，旧记录打开须有当前归属 |

以下为实际全量回执、已完成的原生长观察及剩余发布项目。52项E2E是单次完整套件，不是专项数量相加：

| 最终项目 | 当前结果与证据 |
| --- | --- |
| TypeScript、E2E TypeScript | 均退出0；计数汇总 `.work/v03-evidence/normal-discovery-v035/automated-checks.json` |
| Vitest全量 | 51文件，390通过、0失败；`.work/v035-vitest-stable.json` |
| Rust全量 | 74通过、0失败、2默认忽略，直接调用退出0；`.work/v035-rust-tests.log`。首次stderr/Tee包装错误返回1保留，不能隐去该包装失败或把默认忽略项写成通过 |
| Playwright完整套件 | 52/52通过，2.3分钟、单worker；`.work/e2e/v035-release-final.log`及同名report。包括一个48轮混合导航/刷新/状态场景，31.6秒，固定响应，不能代替35分钟真实原生观察 |
| 最后KUN文案 | 仅澄清新v1匿名目录，无功能改动；再过18项相关unit、7项来源E2E（17.3秒），`.work/e2e/v035-wording-final.log` |
| 生产前端与Tauri/NSIS构建 | 已完成；最终exe25,170,944字节，SHA256 `7F00CED820F1758FA35DC09858805E9AAC32EB9017FF24CD84DF40087809E7A1`；NSIS7,094,473字节，SHA256 `7494F6EE693AEBAD55D174DEE2339A426C0B87CB8CC4D11EEEF7809BA7E7FA1C` |
| 最终静态扫描 | `.work/security-audit/v035-release-final-scan.json`两项退出0，防护和实时保护开启、无新增检测、产物保留且hash一致；NSIS未实际安装 |
| 最终正常UIAutomation | session `normal-discovery-v035-final`，PID32412，原032Data，最终7F00…；真实文学少女热门24部/8.5分与漫画21部，见该目录 `launch.json`、`light-novel-loaded-final.png`。仅UIA，无CDP/注入 |
| 真实35分钟自动刷新 | **passed=true**；elapsed2101.92865秒，71样本全部valid，UTC17:48:58.344→18:24:02.916。同PID32412/漫画/热门推荐保持，页脚01:48:20→02:18:39自动前进1819秒，无失败/手动刷新/helper干预，keepAwakeReleased=true。唯一汇总为final/refresh-observation-20261030T174858324Z-1dfb4e2b/summary.json，结束截图passive-timer-final.png及status无新增检测 |
| 最终重启后数据保留 | `.work/v03-evidence/normal-discovery-v035/data-preservation.json` 于18:26:39Z再次只读核对：10来源、2下载、1作品、2资源、1外部ID、0本地索引共6表原样，DB integrity=ok，两部成品hash和旧10个exe保持 |
| 本地发布目录 | `release/v0.3.5`已生成程序、安装包、启动说明及notice5小文本，并纳入VERSION/校验和；便携ZIP已生成校验，7个交付附件已正式发布 |
| 便携ZIP核验 | `ACGN-Hub-0.3.5-windows-x64.zip`：9,389,201字节，SHA256 `EEE43144C524E075F543326753412E87F9295110699A2069A41411384CA32EC4`；10条目CRC及全部内部文件hash核对通过，不含用户Data。证据 `.work/v03-evidence/normal-discovery-v035-final/delivery-assets.json` |
| 正式便携程序重启 | final/restart-verification.json passed=true；session normal-discovery-v035-restart、PID54160，正式release035exe同7F哈希、原032Data。两完成记录/文件名/打开按钮保留，小说/漫画精选排序及首屏真实封面正常；退出0、防护开、关闭前后无新增检测、无CDP/注入，未做成品播放测试 |
| 桌面入口 | final/shortcut-verification.json passed=true；桌面ACGN Hub.lnk已更新START-ACGN-0.3.5.cmd+035exe图标，仍用032Data，旧lnk已备份 |
| 最终发布汇总 | final/verification-final.json于18:30:48Z实际生成allChecksPassed=true，完整聚合tests/scans/35min/restart/shortcut/数据/ZIP/GitHub；并非预填完成 |
| GitHub源码 | 验证文档提交 `c989cb23fc227a98cfa844338a1b23a6984b2d57` 已推main，annotated tag v0.3.5 peeled同提交，发布核验时main/tag一致；private=true。初始生产源码快照为b18c4e9，后续只改文档；之后main文档回执不改本版生产代码 |
| 正式Release | 18:30:35Z正式发布，isDraft=false、非prerelease；7资产远端digest/大小与本地及实际下载SHA一致，final/github-published-verification.json passed=true。先前实际下载回验final/github-draft-verification.json亦保留，下载ZIP的CRC/内容白名单通过，无Data/媒体 |

## 二进制身份与长观察边界

深审前候选未运行、未发布。完成P1修复后的84F8458C91383D64B416EA970FF8C75F566CD6323ACF3FFF79E1950A81B07047候选仅用于原生验证，未发布；证据在 `.work/v03-evidence/normal-discovery-v035`。它实际完成漫画21→45分页、付丧堂古董店7高分9.1/详情、来源建议及类别query保留、下载两记录展示。MKV的系统打开命令记录success=true，并观察到OpenWith窗口；这不证明视频已播放或解码成功。

随后仅澄清KUN文案，重新构建扫描为最终7F00…文件，以PID32412在 `normal-discovery-v035-final` 记录真实页面及35分钟被动刷新，正常退出0。正式release目录同hash程序又以PID54160/原Data重启，真实检查两条成品记录/打开入口及小说漫画首屏封面后正常退出0；final/restart-verification.json记录本次实际检查。上一候选的具体操作不可改贴为最终程序的操作，各次都没有重下用户媒体。

真实35分钟观察初始有两次纯PowerShell5工具预检失败：重定向子进程ExitCode需保留进程句柄，ConvertFrom-Json数组需赋值后再枚举。修正工具后才开始被动采样，最终由唯一summary确认71个有效样本、请求时长完成与页脚自动前进。这两次预检不计作35分钟运行，也未使用首个valid样本或48轮浏览器场景代替原生长观察。

## 发布清单原则

`package-verified-release.ps1` 保留原有扫描身份、无覆盖检查和复制后hash核验，guide仍通过ASCII脚本中的UTF8 Base64生成。本轮补充书籍发现、品牌源路径/哈希、来源用途、成品打开和存储失败策略字段，并将第三方归属小文本纳入支持文件清单和校验。旧命名/BT信息保留为既有能力，不把历史验收当本轮物理操作。

便携产物包含程序、安装包、启动说明、校验信息和第三方归属文本，不包含用户Data、媒体、账号或Cookie。[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)与aria2官方COPYING、AUTHORS、README.mingw、LICENSE.OpenSSL共5个小文本已计入本地发布清单。`START-PORTABLE.cmd`使用版本目录自己的Data；本机桌面升级入口已核对为START-ACGN-0.3.5.cmd及035exe图标，单独指向原 `release/v0.3.2/Data`，旧lnk有备份。图标源路径属于仓库说明，不表示发布目录附带SVG源或完整证据目录。所有旧release目录保持原样。
