# 真实作品主流程审计（2026-10-29）

本轮读取真实公开元数据、作品/分卷/章节目录，并用 HEAD 确认一张章节图片的可访问性。没有提交下载任务、下载作品正文、读取用户凭据或修改现有媒体。使用项目当前 provider，通过注入真实 curl HTTP transport 执行；这验证了适配和匹配逻辑，不代表已验证桌面 IPC、播放或完整下载。审计临时脚本、HTTP 状态/耗时及结果在 `.work/real-workflow/`，不加入自动单元测试。

此前固定响应 E2E 只能证明页面状态机与持久化交互，不能作为真实来源可用的证明。

## 实测路径与断点

| 类型与真实作品 | 实测通过的步骤 | 实际失败/偏差 |
| --- | --- | --- |
| 动画《葬送的芙莉莲》 | Bangumi 搜索及详情 `400602` HTTP 200；现有 RSS provider 从蜜柑获得 1000 个匹配，从 AcgnX 获得 166 个匹配，能解析磁力/种子 | 新资料库全部来源停用，详情无直接可用来源。即使手动启用，第一季条目的首批资源含第二季 `29–38`、`S2`、跨季合集；没有季/集匹配，关键词结果全量展平。未提交 BT 下载，不能声称其种子有人做种或 qBittorrent 可用。 |
| 小说《无职转生》 | Bangumi 实际 UI 排名首项 `100704`，名称 `無職転生 ~異世界行ったら本気だす~ (1)`；LNovel 目录 HTTP 200 | UI 交给来源的是日文卷名，LNovel 返回 0；原始中文查询返回 12 个候选，第一项是《无职转生 ～蛇足篇～》，其余包含不相关作品。已找到衍生篇，不等于找到用户要求的主系列。 |
| 小说《我想成为影之强者》 | 直接检索 LNovel 找到 `nid=75`，7 卷，首卷目录 11 章，详情/卷目录 HTTP 200 | 同一中文名称走 Bangumi → UI 排名得不到结果，用户无法进入这个本来有来源的作品。当前主流程将来源检索绑定于 Bangumi 对象，也无内置小说阅读器。 |
| 漫画《葬送的芙莉莲》 | Bangumi `305429` 正确；MangaDex 找到原作 `b0b721ff-c388-4486-aa0f-c2b0bb321512`；CopyManga 能查作品与章节 | MangaDex 原作在当前指定语言下目录 HTTP 200、`total=0`，不能把“搜索接口通”当作章节可读。CopyManga 39 个候选，首项为同名合集，仅 5 页；原作 `zangsongdefulilian` 位于后面。当前页面对每个候选读章节后全量合并，原作和同人混在同一作品下。 |

CopyManga 原作第一章的公开详情 HTTP 200；返回图片 `sz.mangafunb.fun`，在对应 Referer 下正确执行 `curl -I` 得到 HTTP 200、`Content-Type: image/webp`、`Content-Length: 347536`。只取响应头，未下载该图片。第一次探针误用 `-X HEAD` 导致 curl 等待不存在的响应体而超时，此为审计脚本错误，不计入产品故障。

## 优先修的五个主流程阻断

1. **没有默认可达的资源入口。** 全停用来源却把用户带到标准元数据详情，必须离开作品页研究来源配置，回页后还要重新触发搜索。应在作品页按内容类型列出可用能力与一键启用并搜索；显式由用户点选，保留旧启停偏好。不能简单把所有站点默认启用。
2. **元数据对象与来源对象之间没有确认层。** 名称包含就认定同作，遍历所有匹配读取全部章节，再展平。真实结果含原作、同人、续篇、跨季和合集。应保留 `来源作品` 层，按标题/别名/季/卷信息排序，只取少数高可信候选，相关作品另组并警示，让用户能确认原作。
3. **小说系列名丢失，且丢掉用户的有效原始查询。** 日文卷号和长副标题直接用于中文目录。应保留原始查询，对系列名、简繁/日文汉字、卷号和副标题做有限规范化；按真实目录标题优先匹配，不能用简介中泛化词和 60% 字符重叠把大量异世界作品都当匹配。主系列缺失时必须说明，不把蛇足篇标成主系列。
4. **动画只有名称，没有季/集上下文。** 第一季搜索首项可能是第二季。`SourceSearchQuery` 目前只有 keyword、aliases、mediaType、page，不能向来源传 Bangumi subject ID 或当前集。应优先用 Bangumi→蜜柑剧目索引验证关联，再读该剧目 RSS；关键词 fallback 必须标记模糊匹配并识别 S2、第二季、集数区间和合集。发现 1000 条是检索失控，不是可用性指标。
5. **“接口健康”与“用户可读”混淆。** MangaDex 返回主作而没有可读章节时，页面应明确当前语言没有可用章节，并提供其它来源/语言路径。当前没有内置动画播放器、小说/漫画阅读器，只有生成 TXT/CBZ、目录打开与外部打开文件；“下载成功”也尚未闭环为“点开作品就能看/读”。

## 成熟项目实际做法

- [Animeko 主仓库](https://github.com/open-ani/animeko) 把追番、观看和来源选择作为同一流程，维护可订阅来源与自动选择；不是把 GitHub Release 当作作品来源。
- [MediaFetchRequest](https://github.com/open-ani/animeko/blob/main/datasource/api/src/commonMain/kotlin/source/MediaFetchRequest.kt) 显式携带 `subjectId`、所有作品名、`episodeId`、集数/集名、整季剧集与 fallback 查询词；来源返回的匹配并非仅一串 URL。
- [MikanMediaSource](https://github.com/open-ani/animeko/blob/main/datasource/bt/mikan/src/commonMain/kotlin/MikanMediaSource.kt) 先找蜜柑剧目索引，并核对剧目页面的 Bangumi ID；缓存关联，再读 `RSS/Bangumi`。索引失败才退回关键词 RSS。
- [SplitSeasonEpisodeMatcher](https://github.com/open-ani/animeko/blob/main/app/shared/app-data/src/commonMain/kotlin/domain/media/selector/filter/SplitSeasonEpisodeMatcher.kt) 根据作品/集上下文处理分季与连续编号，避免当前第一季被第二季覆盖。
- [Miru App README](https://github.com/miru-project/miru-app/blob/dev/README.md) 说明安装官方扩展后可实际搜索和观看视频/漫画/小说。其 [搜索控制器](https://github.com/miru-project/miru-app/blob/dev/lib/controllers/search_controller.dart) 直接搜索运行中的来源，可按扩展类型过滤，并逐来源显示结果；[漫画](https://github.com/miru-project/miru-app/blob/dev/lib/controllers/watch/comic_controller.dart)与[小说](https://github.com/miru-project/miru-app/blob/dev/lib/controllers/watch/novel_controller.dart)有专用阅读控制器。并不要求用户先在独立元数据站点搜到同名对象。

以上为读取当日官方 GitHub 文档/源码所得。Web 搜索工具当时返回 503，使用 GitHub 官方 API/raw 读取相同一手资料。

## 实现顺序与验收边界

先修来源入口、候选作品确认、有限搜索词 fallback 和季/集警示，再用这三类真实作品复测“首项是谁、原作有没有章节、返回多少资源”。来源失败应逐个可见，不能一个站点失败拖住全部；不要以更多随机候选替代有效命中。

服务层可抽 `resource-discovery`，统一作品候选排名、上限、去重及明确的相关项警示。来源目录提供内容类型、是否需要账号/本地桥接、结果是文件还是章节。后端需要承接真实图片/视频请求头、重定向和代理的验证；BT 完成验证必须另用官方开放样本，并证实 qBittorrent Web UI/任务状态。根本阅读闭环仍需播放器/阅读器或明确的系统外部打开路径，不能靠本轮目录查询宣称完成。

## 本轮已实施与真实复查

新增 `/resources` 来源直接检索页面；不要求先搜到 Bangumi 对象。页面在同处明确启用所选来源，先列作品候选，用户点击封面、标题或确认按钮后，再进入准确来源作品的详情和章节。`source:` 本地作品保留来源配置及作品 ID，刷新后按 ID 取章节，不重新宽泛搜索。标准详情使用 `resource-discovery` 统一有限候选匹配；来源能力目录区分动画 RSS、漫画、小说、Python 及可选 Token，站外分享页标为 `external_link`。

- **CopyManga 原作**：修前真实中文查询 39 个候选，首项为同名合集（5 页）；修后 6 个候选，首项为 `zangsongdefulilian`《葬送的芙莉蓮》，匹配分 100、无衍生警示。新建 provider 按准确 ID 恢复 **153 章**，第一章 descriptor 为 **39 页**；未下载图片。
- **小说直接来源**：《我想成为影之强者》修后保留 2 个标题候选（本篇和 web 版本），首项为本篇，7 卷，首卷 11 章。此前 Bangumi 入口无结果，现在可以绕过这个前置条件选择来源作品。
- **小说日文卷名**：`無職転生 ~異世界行ったら本気だす~ (1)` 从 0 条变为 1 条《无职转生 ～蛇足篇～》，明确“同人、合集或衍生篇”警示。没有把现有目录里缺失的主系列伪造成成功命中；不相关的异世界作品已移出结果。
- **动画**：实测发现增大超时仍无法解决巨大 `Home/Search` 页面波动，故改走官方 `RSS/Search` 优先（真实 100 项、约 94KB），再由匹配发布页的剧目链接核对 Bangumi ID；已验证 `400602 → 蜜柑3141`。最后一轮真实调用约 **30.9 秒**，返回限量 24 个种子资源、无接口失败；前两项均为 **S01 / 01–28**，不再首推第二季。上游甚至存在 `S01 | 29–38` 错标，故另对已知本作 28 集的超范围区间标警示，不能单信站方 S01 字样。这个冷请求仍较慢，且这里只确认公开目录和种子链接，不确认 BT 做种/传输成功。
- **MangaDex**：原作无可下载图片章节时给出明确错误和换源建议，不再把标题搜索成功当作可生成 CBZ。

证据为 `.work/real-workflow/provider-audit-after.json`、`provider-audit-anime-final.json` 及上述公开目录响应。自动单元测试用于防止匹配、候选上限、零页章节和精确 ID 恢复退化；它们不替代这些真实复查，也不证明播放/阅读已经完成。
