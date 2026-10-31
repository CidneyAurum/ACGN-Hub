# 0.3.6 本地观看、改编版本与统一搜索

记录日期：2026-10-31，Windows x64。本轮源码功能已实现，最终统一搜索程序95D19A…已构建、静态扫描并打包；正式程序的正常桌面、重启、数据保留及快捷方式已完成本地验收，GitHub正式发布仍在准备中。本文保留此前失败与候选的独立身份，未提前填写尚未取得的发布回执。

## 用户操作与实现范围

下载中心的已完成漫画、小说和视频提供应用内入口。漫画继续保存CBZ，阅读器直接读取原图；下载中心另有“按作品观看”，将有可靠身份的已下载话、集和卷列成目录。多文件下载先选实际成品，系统程序打开入口仍可使用。

漫画默认连续纵向滚动，可切换单页翻页、适合宽度/高度、浅深舞台；单页支持上一页/下一页、页码输入和键盘。进入全屏的容器包含工具栏、翻页和跳页控件，鼠标无需退出全屏即可翻页。连续模式只加载当前附近页，远页保留尺寸占位，离开时释放会话；页面成功加载后才保存进度，坏页有当前页重试和重新打开文件入口。

UTF-8 TXT（含BOM）轻小说提供本卷章节目录、字号、行距、米白/护眼/夜间纸色、阅读宽度和滚动位置恢复。能识别“第…章/卷”“序章/终章/后记”及部分英文标题；没有可识别标题的TXT仍可读正文，目录不虚构。正文按文本呈现，不执行文件中HTML。EPUB/PDF及其它TXT编码继续交给系统阅读器。

阅读器有作品目录、上一话/下一话及默认可关闭的自动接续。漫画连续滚动或小说实际阅读到末尾、内容加载成功且存在有效下一份文件时，出现3秒可取消倒计时；隐藏窗口、离开末尾、取消或禁用时不继续。单页模式可在末页继续下一话；视频`ended`事件在开启接续时进入下一集。接续不获取新章节、不跨作品/季度/已知版本，旧记录没有足够关联时保持分开。

## CBZ第1页读取失败的修复

初次1058…候选在真实桌面中出现页图失败。根因是Tauri的`convertFileSrc`编码整个参数，将拼在token后的`/page/N`一并变成`%2Fpage%2FN`，与原生协议路由不一致。现在只转换不透明会话token，再追加真实`/page/N`或`/video`路由。

对应服务测试和浏览器替身均按官方“整参数编码”行为生成URL，精确断言图片及视频路由；修复不依靠测试替身省略编码。旧失败和后续成功保留独立身份。只读原生会话检查文件归属及路径，限制CBZ归档、页数与解压量，视频按受控Range读取；不把文件系统路径直接作为任意网页资源暴露。

## 同名作品的不同改编版

此前搜索后过早取首项，导致《安达与岛村》的另一漫画版本被丢弃。本轮MangaBZ/Copy保留来源中不同作品ID及独立作者、目录，资源面板提供“作品 / 改编版本”选择器及版本标签。18话版和60话版各自保留，不因标题简繁相近而合并。来源作者、实际目录条数与最新话标签分别显示；章节数是本次读到的来源目录，不冒充作品永久总话数。

Copy目录中的内部`index=67`是排序位置，不能解释为第67话。现在从“第60话”等明确章节名提取话数；番外、卷或其它不明确条目不猜成话数。目录可以含番外，因此条目数与最新正篇话数本来就可能不同。

新漫画下载目录带来源版本身份，避免不同改编的同名“第01话.cbz”争用路径。已有文件、任务和阅读记录不自动搬迁；已知版本不同、或旧记录没有可靠版本身份时，作品目录和自动接续保持隔离。

## 一个框搜索作品名或作者名

最终搜索界面保留作品类型，统一框接受作品名、作者名或可靠别名；直接呈现作品卡及作者参与角色，没有“作品/作者”模式前置，也不要求先点人物卡。同名且姓名可信匹配的人物通过简短筛选切换，关联作品可继续分页。当前Galgame仍使用VNDB标题检索，作者关联通道未接入。

作者数据来自Bangumi官方匿名接口：`POST /v0/search/persons?limit=20&offset=0`，请求体为`{keyword}`；关联作品来自`GET /v0/persons/{id}/subjects`。官方契约为[open-api/v0.yaml](https://github.com/bangumi/api/blob/master/open-api/v0.yaml)，人物搜索标为实验性，实际响应的`summary`与文档`short_summary`均有兼容。接口失败会明确提示，不把失败静默替换成标题搜索成功。

姓名匹配只比较正式名和别名：NFKC、大小写、空白/标点及有限人名简繁归一化；精确匹配优先，至少3字的前缀次之，无单字包含或简介匹配。“入间人间”可对应“入間人間”，不会因为刘德华简介含“民間”就关联其作品。作者作品依据官方人物ID及参与关系，不再用作者名对作品标题评分而删掉《安达与岛村》这样的有效结果。

官方关联作品是平铺完整列表，同作品可因不同职务重复；provider按作品ID合并角色后分页。动画大类可直接分，书籍共用Bangumi类型1且关系行不含platform，因此每批最多20个候选、最多3个并发详情用于漫画/小说分类。分类后本批可能少于20项甚至为空，但`hasMore`保留；书籍不以候选总数冒充分类总数。缓存、切换类型、详情返回与迟到响应另有回归；最后空缓存/作者/历史返回7项定向检查已在22.1秒全部通过。

## 已有验证与构建身份

| 项目 | 当前实际范围 |
| --- | --- |
| 全量Vitest | `.work/v036-unified-final-vitest.json`为57个文件、450通过、0失败，`success=true` |
| Rust | 本轮86通过、0失败、2默认忽略，覆盖归档/页序/会话/Range等；忽略项未列入通过 |
| 完整浏览器E2E | 67/67通过、4.1分钟，`.work/e2e/v036-unified-full-results/.last-run.json`为passed；固定响应模拟不等同真实资源站 |
| 统一缓存专项 | 初次7项通过；最后空缓存/作者/历史返回7项定向回归22.1秒全部通过，`.work/e2e/v036-unified-empty-cache-results/.last-run.json`为passed |
| 官方API只读实查 | `.work/author-provider-live-smoke.json`真实取得人物6207入間人間；关联动画含新世界未来篇、安达与岛村、电波女与青春男，小说含19岁、说谎的男孩与坏掉的女孩 |
| 原生候选身份 | `.work/v03-evidence/normal-v036-delivery/launch.json`：`6D1B96886C123B210BF034EDA11461C1E238A580CA2C6E57EE02DA8709830438`，PID38516，原`release/v0.3.2/Data`，无CDP/脚本注入、防护开启 |
| 原生漫画局部成功 | 同目录`comic-continuous-start.png`/`comic-continuous-scrolled.png`显示真实安达17页及连续滚动；`fullscreen-after-mouse-next.json`/`fullscreen-after-next.png`记录全屏鼠标翻到第2页；`comic-resume-page2.json`/`.png`记录返回后恢复第2页 |
| 候选限制 | 6D1B…包含已被用户拒绝的人物卡搜索；其`author-related-works`截图仅作历史，不能作为最终统一搜索正常桌面通过回执 |
| 最终构建/扫描 | exe25,553,408字节，SHA256 `95D19AA77908C3E9056F5DE4E134D3C4D5BA8B7F5346165A78E342CD613403F4`；NSIS7,223,620字节，SHA256 `D0AFD2DD201473604821C2C18404205945F747DBC84665C3B003681BA1324A29`；`.work/security-audit/v036-unified-final-scan.json`两项退出0、防护开启、无新增检测 |
| 最终正常桌面身份 | `.work/v03-evidence/normal-v036-unified/launch.json`：正式`release/v0.3.6/ACGN-Hub-0.3.6.exe`同95D19A…、PID5620、2026-10-31T02:50:19Z启动、原032Data、无CDP/注入、防护开启 |
| 最终统一搜索 | 同session的`author-direct-work-results.json`/`.png`实际输入入间人间直接显示3部动画；`author-novel-results.json`/`.png`显示16项小说结果，其中1项标题相关、15项作者关联。没有人物卡；16项不全部归称作者关联作品 |
| 最终版本目录核验 | `manga-two-source-editions.json`和`manga-edition-chapter60.json`/`.png`实际查看不同来源版本、柚原もけ版75条目录及第60话22页信息。目录可含番外，不把75条叫75话；本轮没有重新下载全卷 |
| 最终漫画原生阅读 | `final-fullscreen-mouse-next.json`/`.png`实际全屏鼠标翻到第2页，`comic-continuous-final.png`显示连续阅读，`resume-page2-final.json`记录返回恢复第2页；使用现存17页CBZ，不是模拟页图 |
| 正常重启及进度 | PID5620正常退出0后，`.work/v03-evidence/normal-v036-restart/launch.json`记录同正式exe/原032Data重启PID62636；`restart-resume-page2.json`/`.png`仍显示第2页，status无新增检测。用户已关闭GUI，不再重开 |
| 数据保留 | `.work/v036-evidence/data-preservation.json`为passed、DB完整性ok。10个来源ID保留，3条配置在用户并行使用期间修改，保留当前值不回滚；原2任务/3资源/1作品/1外部ID/0本地索引不变，选版核验新增1作品（现2）。3个媒体payload含CBZ的内容hash及12个旧exe保持 |
| 桌面入口 | `.work/v036-evidence/shortcut-verification.json`为passed：桌面ACGN Hub.lnk指向START-ACGN-0.3.6.cmd，图标取正式036exe，继续使用原`release/v0.3.2/Data` |
| 本地便携ZIP | `.work/v036-evidence/delivery-assets.json`：`ACGN-Hub-0.3.6-windows-x64.zip`为9,556,150字节，SHA256 `8C1E8267F5D27DF0D451F9C21FCFE7CEE1DCBBC3C1AE9E2881F2D90ECEFDCD58`；10条目CRC和每项hash通过，不含用户Data。VERSION补入最终原生证据路径，exe与安装包哈希保持 |
| 私有源码与发布草稿回验 | 生产代码提交`cfa5f121c351189259f5ab16c86ba6eb5adcca76`已推main；`.work/v036-evidence/github-draft-verification.json`为passed、private=true、isDraft=true。7资产已实际下载，大小/SHA256/API digest全部匹配；下载ZIP10条目白名单/CRC/每项hash/noData、VERSION/SHA9项及外层6项校验通过。正式标签/发布及最终汇总JSON仍待回执，尚未声明正式发布完成 |

此前6D1B候选程序、安装包和清单保存在`.work/v036-evidence/pre-unified-candidate`，原生失败另在`normal-viewer-v036*`历史目录；这些本机证据不随源码上传。最终哈希取本次扫描文件，尚未填写未取得的标签提交或`allChecksPassed`。TXT阅读器及自动接续主要通过固定响应测试验证，不将其写成正式桌面全卷下载或跨卷接续实测。

## 参考与保留边界

已读Komga、Kavita、Mihon官方源码，固定提交、许可证链接和采用结论见[参考研究](local-reader-references-v036.md)。本轮自行实现本地阅读，没有复制第三方阅读器实现、引入其运行依赖或生成AI人物。

CBZ上限1000页、单页50MiB、归档512MiB、总解压500MiB；不支持加密、分卷或ZIP64。TXT上限20MiB。内置视频受本机/WebView编解码能力约束，HEVC、部分MKV/AVI/TS和字幕不作统一播放承诺；保留系统播放器入口。NSIS尚未实际安装。原媒体内容只读，不降低画质；旧版本和0.3.5的已完成发布证据保留原身份。
