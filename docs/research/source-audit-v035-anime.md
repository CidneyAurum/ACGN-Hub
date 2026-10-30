# 0.3.5 动画 / Galgame 来源与下载状态审计

审计时间：2026-10-31（Asia/Shanghai）。全部使用匿名公开请求。未读取浏览器登录态、Cookie，未请求整集视频、游戏包或实际 BT 节点；未操作正在运行的 0.3.4、aria2、用户数据库和已有成品。

## 来源结论

| 来源 | 实际用途 | 本轮代表性结果 | 建议顺序 |
| --- | --- | --- | --- |
| 蜜柑计划 | 动画 Torrent / 磁力发布目录 | `学生会也有洞` 返回 78 条；选定第 01 话 Torrent HTTP 200、9,720 字节，成功解析出 MKV 正文名称、415,158,220 字节、396 个分片、36 个 tracker tiers | 动画 BT 首选；优先原始 `.torrent`，不能把种子文件称为视频直链 |
| AcgnX | 动画磁力目录 | 同关键词返回 50 条，准确作品与集数存在；RSS enclosure 给出 magnet | 动画 BT 备用；磁力需要取得元数据和实际节点，目录可访问不等于速度保障 |
| B站公开投稿 | 普通公开投稿，须逐条确认内容与匿名画质 | 关键词当前返回 20 条，混有合集、近名作品、解说片段；具体 `BV1UqHi6uEie` 通过既有桥接的匿名元数据及每流 1 KiB 检查，选中 1920×1080 AVC + AAC，时长 1772.202 秒 | 已知公开 BV 的补充来源；不能将搜索标题中的“4K / 全集”当作实际格式或正片证明 |
| Internet Archive | 公开档案文件直链 | 搜索 `Big Buck Bunny` 得到 12 个匹配目录；其中有 10 秒测试样片，也有 596.5 秒完整公开短片。所查文件 HEAD 200 | 公开动画、档案资料备用；不是当季日漫通用源，必须区分样片、原始文件与低清衍生版本 |
| 鲲 Galgame | 可匿名检索的作品 / 资源目录，实际文件在站外确认 | 旧 picker HTTP 401；官方新 v1 API 匿名正常。修复后真实 provider 检索 `CLANNAD` 得到准确作品 86、36 条有效资源目录，全为原站资源页 | Galgame 站外资源索引；不当成游戏包直链，也不把网盘页面发送给 aria2 |

GitHub Releases 仍是软件 / 项目附件来源，不作为动画资源源。JMComic 属于另行配置的漫画来源，不提高动画或 Galgame 搜索优先级。

## 真实请求与资源边界

### 蜜柑计划与 AcgnX

蜜柑从 [RSS/Search](https://mikanani.me/RSS/Search?searchstr=%E5%AD%A6%E7%94%9F%E4%BC%9A%E4%B9%9F%E6%9C%89%E6%B4%9E) 取得发布条目，所查 Torrent 是公开小型元数据文件，没有下载动画正文或建立 BT 连接。Torrent 内 `name` 为 `[KitaujiSub] Seitokai ni mo Ana wa Aru [01][Uncensored][WebRip][HEVC_AAC][CHS&CHT].mkv`。RSS 的声明大小与实际 Torrent 内长度存在差异，实际下载进度仍须以引擎读取的正文长度为准。

[AcgnX RSS](https://share.acgnx.se/rss.xml?keyword=%E5%AD%A6%E7%94%9F%E4%BC%9A%E4%B9%9F%E6%9C%89%E6%B4%9E) 中 `enclosure.length="1"` 是磁力占位，正文却明确标出 `394.3MB` 等体积。旧实现把它显示为 1 B，现只对已知 AcgnX 源处理该占位：从描述的独立、明确大小字段读取 MB / MiB / GB / GiB 等单位；未知就不显示大小，保留其它源和真实 enclosure 字节值，不把集号、画质数字或标题数字当大小。MB/GB 按十进制、MiB/GiB 按二进制换算。

### B站公开投稿

所查普通投稿为 [「脑洞学生会！」第1话【中文字幕】](https://www.bilibili.com/video/BV1UqHi6uEie/)。桥接仅运行 `inspect`，没有运行 `download`。匿名实际选中视频格式 `30080`、音频格式 `30216`。这个结果只证明当前这个 BV 的公开音视频可以读取，不能推导所有搜索候选可用，或证明投稿者、内容及集数与目录完全对应。

关键词前排包含长达数小时的“4K超高清合集”、近名 `妄想学生会`、时长 4:43 的解说片段。现有投稿 provider 已提供时长、片段 / 合集警告及实际检查后的画质；应保留这些信息，不能按标题优先承诺质量。

### Internet Archive

已核对 [BigBuckBunny_124 元数据](https://archive.org/metadata/BigBuckBunny_124)，其目录声明 CC BY 3.0：

| 文件 | 元数据实际尺寸 / 时长 | 大小 / 可访问性 |
| --- | --- | --- |
| `Content/big_buck_bunny_720p_surround.avi` | 1280×720，596.46 秒 | 332,243,668 字节，HEAD 200 |
| `Content/big_buck_bunny_720p_surround.mp4` | **640×360**，596.5 秒 | 61,878,609 字节；文件名中的 720p 不代表这个衍生版本的实际画质 |
| 另一目录 `big-buck-bunny-1080-10s-30-mb` 的 MP4 | 10 秒测试样片 | 一种衍生文件 HEAD 200，但不能视为完整动画 |

对文件元数据明确不足 120 秒的视频，增加“短视频直链 · 片段/样片待核对”标签及警告，保留下载选项；没有删除真实短视频。596 秒完整公开短片、未知时长、TXT / EPUB 等文件不受此警告影响。没有按文件名推断它是完整正片或真实 1080p。

### 鲲 Galgame 官方接口迁移

官网公开页面链接到 [官方仓库 KunMoe/kun-galgame-forum](https://github.com/KunMoe/kun-galgame-forum)。旧 `KUN1007/kun-galgame-nuxt3` 仓库地址也重定向到这个项目。

- [官方路由注册](https://github.com/KunMoe/kun-galgame-forum/blob/master/apps/api/internal/search/apiv1/register.go) 把 `/search/works` 注册为 Public；[API 设置](https://github.com/KunMoe/kun-galgame-forum/blob/master/apps/api/internal/apiv1/setup.go) 声明前缀 `/api/v1`。
- [资源目录路由](https://github.com/KunMoe/kun-galgame-forum/blob/master/apps/api/internal/galgame/resourceapiv1/register.go) 允许匿名查询作品资源目录。只用 `GET /api/v1/search/works` 和 `GET /api/v1/works/{id}/resources`。
- 旧 `/api/galgame/search/picker` 已移除，落入旧认证边界，匿名返回 HTTP 401、`{"code":205,"message":"用户登录失效"}`。这不意味着新公开作品搜索必须登录。
- [资源读取实现](https://github.com/KunMoe/kun-galgame-forum/blob/master/apps/api/internal/galgame/resourceapiv1/read.go) 中 `POST .../downloads` 会增加计数；本轮及修复后的目录 provider 均不调用它，也不抓取隐藏分享链接。

修复使用 v1 localized / 字符串 ID / cover / resources 新结构，过滤错误作品和失效条目，保留中文、日文、英文别名匹配。返回 `https://www.kungal.com/galgame/resource/{id}`，明确标记 `external_link` / 站外资源索引。用户点击后在来源中确认文件及权限。

## 下载状态审计与已修问题

### P1：成品生成成功后，保存记录失败导致成品被删除

旧流程：原生已经成功生成 CBZ / TXT / MP4 → `local-download.complete()` 先把最终文件加入 cleanupPaths → localStorage 因 quota / 权限失败 → 页面 catch 调 `fail()` → `fail()` 更新状态虽然也失败，仍清理 cleanupPaths → 删除刚生成的成品，旧记录还停留 preparing。

已用独立内存存储和模拟原生删除边界复现。整个模拟没有访问实际文件：修复前的调用序列同时包含临时目录和最终成品删除。

现行为：

- 原生成功后先确立内存中的 completed 结果。记录写入失败仅标为 `persistencePending`，独立显示“尚未保存”，保留成品。
- 进度回调在存储故障时继续保留内存进度，不让记录故障冒充传输失败。
- 完成后的 late fail / late progress 不能倒退状态或清理成品；显式删除文件仍由用户操作执行，清理失败保留 completed。
- 提供 `retryPersistence()` 重试保存；导出同时保留原始存储文本和 pendingTasks。待保存时禁止“备份并重建”清空内存结果。
- 如果用户关闭窗口时仍未保存，重启可能只能看到旧活动记录。记录明确提示“文件可能已经生成，先检查输出路径”，不会自动重下或删除原文件。

DownloadManager 的 BT 请求状态、取消 / 暂停的任务锁、GID 恢复及已知正文进度保留本轮未发现需要额外改动的确定缺陷。该结论仅限静态检查及已有测试覆盖，没有对用户运行中的引擎作新的控制实验。

## 验证与证据

定向单测：RSS 15、Internet Archive 3、本地任务 15、KUN v1 4，共 37 项分别通过；修改完成后 `npm run typecheck` 通过。未在本子任务重新运行全量测试、构建、安装或原生启动，由根代理统一集成验证。

证据位于 `.work/source-audit-v035/`：

- `anim-probe-results.json`：原始来源搜索、公开 BV 检查、旧 KUN 401。
- `anim-response-*.txt`：对应匿名 HTTP 正文。
- `anim-torrent-probe.json` / `anim-mikan-selected.torrent`：9,720 字节 Torrent 元数据及解析结果。
- `anim-followup-results.json`：完整公开动画文件、HEAD、官网 / 官方仓库关联。
- `anim-kungal-official-*`、`anim-kungal-*-*.go.txt`：官方公开路由与类型快照。
- `anim-kungal-provider-final.json`：修复后真实 provider 的两次 GET 200、准确作品与 36 条站外目录。
- `anim-download-state-before-fix.json` / `anim-download-state-probe.json`：模拟文件边界下修复前后的删除调用对比，修复后为空。

浏览搜索工具本轮返回服务 503，因此使用原站公开 HTTP 和官网链接的官方 GitHub 源码直接复核。请求没有通过更改代理、Cookie、登录态或访问权限来绕过限制。

## 终审补充：取消与同路径复用的清理权限

随后终审另行用内存文件系统复现：A 在发布结果时取消，`complete(A)` 清除成品后仍保留最终路径的 cleanup 权限；同窗口内 B 在同一路径下载成功后，删除 A 的旧记录和文件会删掉 B。重复 `complete(A)` 也可能重新取得旧路径权限。这条复现与前述 quota 问题不同，已另行修复。

最终本地任务账本维持以下不变量：

- 一个任务的原生结果只结算一次。重复 complete / fail 不重新登记最终文件清理权限。
- 每条路径成功清理后立即消费该项权限；多路径清理中途失败时，只允许重试仍保留的路径。
- 新任务成功生成同一规范化输出路径时，在同一次记录快照中撤销旧任务该路径权限；删除操作始终读取当前记录，忽略 UI 旧快照中的权限。
- 同路径有活动 writer 或正在进行清理时，阻止相互冲突的操作；清理父目录时也阻止在其内生成新输出。
- 启动时若旧记录中有重复路径所有权，撤销这些不明确的旧权限，不猜测哪个历史任务拥有当前文件。
- `ownedOutputPath(id)` 只返回当前已确认的本地任务路径；旧记录被接管后不再由它打开或删除新任务文件。

这套保护针对应用本地任务账本和正常应用生成路径，规范化 Windows 大小写、斜杠和 verbatim 路径前缀。它没有新增原生文件 identity 令牌，因而不宣称能够证明跨引擎写入、8.3 / 物理目录别名或用户外部替换文件后的身份；原生允许根目录和文件校验仍保留。

最终本地任务定向单测 **23 项通过**，包括成功/取消后的同路径复用、重复回调、旧 UI 快照、部分清理失败、父目录互斥、quota 下所有权撤销、正常新任务删除及旧重复记录；修改结束后的类型检查通过。原始只读复现 `.work/v035-readonly-cancel-reuse.json` 保留，修复后的 `.work/v035-readonly-cancel-reuse-after-fix.json` 显示 B 的成品保留，模拟删除仅针对 A 自己的已取消输出。两次实验均未触碰真实文件。
