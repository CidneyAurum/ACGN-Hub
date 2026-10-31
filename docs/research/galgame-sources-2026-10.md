# Galgame 来源复核与接入建议（2026-10-31）

本次针对“Galgame 内容和资源入口不足”，使用匿名公开 HTTP 请求核对了 KUN Galgame、HIKARI FIELD、Steam、ATRI 官方网站、Narcissu 原作者网站及 DDLC 官方网站。浏览搜索工具返回 503，改以来源网站、官方接口和官方 GitHub 仓库复核。没有读取浏览器 Cookie，没有绕过登录、付费、地区或访问权限，没有下载完整游戏包。

## 可采用的来源

| 来源 | 实际提供的内容 | 本轮证据 | 建议用途 |
| --- | --- | --- | --- |
| [KUN Galgame](https://www.kungal.com/) | 公开作品目录、资源索引、语言、平台、文件体积、网盘/发布站名称、有效状态 | 5 个代表作品均能命中；匿名 v1 GET 200；资源页带分页 | 中文资源查找主入口。按钮应为“查看资源页”，按语言、平台、资源类型和有效状态筛选 |
| [Steam](https://store.steampowered.com/) | 正式版商店页、真正的免费版和试玩版，由 Steam 客户端下载 | ATRI、千恋＊万花分别有独立免费试玩 app；Narcissu 和 DDLC 原版为免费作品 | 补充可信试玩/免费作品入口。商店和试玩独立标识，不当作 aria2 文件 |
| [HIKARI FIELD](https://store.hikarifield.co.jp/shops) | 官方中文版目录、官方中文网站、语言与系统要求、发行商客户端入口 | 商店和 5 个具体作品页 HTTP 200；千恋官方中文下载页链接至 Steam 试玩 | 中文作品资料和官方版本入口，适合精准作品映射。本站本次匿名页面显示地区限制，不能承诺可直接购买或下载 |
| [ATRI 官方试玩页](https://atri-mdm.com/special/demo/) | 原厂明确提供的体验版说明与 Steam 入口 | 官网与试玩说明页 HTTP 200；Steam 的 demo 资料再次独立确认 | 适合“官方试玩”推荐卡片，支持简繁中文 |
| [Narcissu 原作者下载页](https://stage-nana.sakura.ne.jp/down.htm) | 免费旧日文版游戏文件、差分文件及历史镜像 | 官方 `naru2.lzh` HTTPS HEAD 200，64 字节 Range GET 206，确认为 LHA 文件 | 少量真正可直接下载的原厂免费作品补充。需明确日文和 LZH 格式，未测试启动 |
| [DDLC 官方网站](https://ddlc.moe/) / [Team Salvato itch.io](https://teamsalvato.itch.io/ddlc) | 免费原版下载入口，官网嵌入 itch.io 下载组件 | 两个页面 HTTP 200；Steam 原版也标记免费 | 标记英文、心理恐怖题材和官方外部下载入口；本轮未取得稳定文件直链 |

VNDB 是作品元数据目录，不是游戏文件来源。本轮不把增加元数据站点等同于增加可下载资源。

## 已核对的作品与资源覆盖

KUN 的官方仓库为 [KunMoe/kun-galgame-forum](https://github.com/KunMoe/kun-galgame-forum)。接口为：

```text
GET /api/v1/search/works?q=作品名&page=1&limit=24&include_nsfw=false
GET /api/v1/works/{workId}/resources?page=1&limit=50
```

搜索结果允许近似匹配，因此应在本地用中文、日文、英文名称和别名再次核对，不能把所有搜索返回项当作目标作品。接口响应中的资源 `total` 包括失效条目；可用数量应在读完分页后按 `state === "valid"` 计算。

| 作品 | KUN 作品入口 | 本轮读取的资源 | 说明 |
| --- | --- | --- | --- |
| CLANNAD / 克兰纳德 | [作品 86](https://www.kungal.com/galgame/86) | 第 1 页共 38 条 | 比此前审计的 36 条多，目录确实持续更新 |
| ATRI / 亚托莉 | [作品 12](https://www.kungal.com/galgame/12) | 总 67 条；两页中 58 条标记有效 | 第 2 页 17 条，8 条有效；只读首 50 条会遗漏 |
| 星之梦 | [作品 196](https://www.kungal.com/galgame/196) | 第 1 页共 23 条 | 搜索“星之梦”还返回“雪圈球”和其他近名作品，需区分 |
| Summer Pockets / 夏日口袋 | [作品 4](https://www.kungal.com/galgame/4) | 总 57 条；两页中 53 条标记有效 | 第 2 页 7 条，3 条有效 |
| 千恋＊万花 | [作品 15](https://www.kungal.com/galgame/15) | 总 122 条；三页中 107 条标记有效 | 第 2 页 50 条有效，第 3 页 22 条中 7 条有效 |

这些资源包含百度、夸克、迅雷、移动云盘、OneDrive、PikPak 及其他发布站的**索引**。本轮没有验证所有网盘文件存活、授权或下载速度。KUN 的 `state:valid` 是目录声明，不能代替实际文件可用性检查。现有资源页模式应保留，不抓取隐藏分享链接，不调用会增加计数的 `POST .../downloads`。

此前 0.3.6 适配器将资源固定在 `page=1&limit=50`，对上述三部作品存在已复现的遗漏。本轮 0.3.7 已实现有上限的分页、资源类型/语言/平台筛选和清晰的站点类型。

## 官方试玩与免费版的具体入口

| 作品与版本 | 已确认入口 | 语言 / 平台 | 实际下载方式 |
| --- | --- | --- | --- |
| ATRI -My Dear Moments- Demo | [Steam 体验版 1263470](https://store.steampowered.com/app/1263470/)；正式版 [1230140](https://store.steampowered.com/app/1230140/) | 简中、繁中、英、日；Windows | 官方资料 `type`/免费标记对应体验版，交由 Steam 安装 |
| 千恋＊万花 体验版 | [Steam 体验版 1221010](https://store.steampowered.com/app/1221010/)；[官方中文下载说明](https://www.hikarifield.co.jp/senren/download.html) | 简中、繁中、日；Windows | 官方接口 `type:demo`、`is_free:true`；与付费正式版 1144400 分开 |
| Narcissu 1st & 2nd | [Steam 264380](https://store.steampowered.com/app/264380/) | 官方资料为英、日；Windows / macOS / Linux | `is_free:true`；未验证中文，不能添加“中文”标签 |
| Doki Doki Literature Club! 原版 | [Steam 698780](https://store.steampowered.com/app/698780/) / [开发者 itch.io 页面](https://teamsalvato.itch.io/ddlc) | 官方资料为英文；Windows / macOS | 免费原版；不与付费 DDLC Plus 混淆 |
| Narcissu 2 旧日文原版 | [官方文件 naru2.lzh](https://stage-nana.sakura.ne.jp/download/naru2.lzh) | 日文；原厂旧 Windows 版本，未实机启动 | 282,478,817 字节；`application/x-lzh-compressed`；支持 Range；LZH 需兼容的解压工具 |

Narcissu 文件检查 HEAD 与 `Range: bytes=0-63`，收到 64 字节、HTTP 206，头部 `-lh5-`；集成时又核对前 4096 字节，容量与文件头一致，没有下载完整归档。旧页面中的视频 `naru_movie.zip` 实际 HEAD 404，已排除，不能把历史下载链接全部视为可用。

Steam 公开接口可用于验证作品名、支持语言、平台、免费状态及 demo app ID：

```text
GET https://store.steampowered.com/api/storesearch/?term=关键词&l=schinese&cc=cn
GET https://store.steampowered.com/api/appdetails?appids=1230140&l=schinese&cc=cn
```

这两个是公开商店接口，本轮可匿名读取，但不是已承诺稳定的应用集成 SLA。需要缓存、短超时和单源失败隔离。`storesearch` 的 `price:null` 不代表免费，必须再看详情的 `is_free` 和 `type`；DLC、原声和设定集也可能混入结果。`cc` 和地区限制会影响结果，本轮 `cc=cn` 搜“千恋万花”只给出体验版，不能因此误判正式版不存在。

## HIKARI FIELD 的实际范围

以下精确作品页都返回 HTTP 200，可作为官方中文版入口：

- [千恋＊万花](https://store.hikarifield.co.jp/shop/senren_banka)
- [苍之彼方的四重奏](https://store.hikarifield.co.jp/shop/aokana)
- [魔女的夜宴](https://store.hikarifield.co.jp/shop/sothewitch)
- [Riddle Joker](https://store.hikarifield.co.jp/shop/riddle_joker)
- [魔卡魅恋！零之编年史](https://store.hikarifield.co.jp/shop/magical_charming_zero)

《魔卡魅恋！零之编年史》在官方目录明确标记为免费发行作品，正文说明简繁切换及 HIKARI FIELD CLIENT 安装。但本轮上述商店页面均显示“本产品暂不向您所在的地区销售”，所以只能确认目录与官方版本信息，不能标成已经验证的免费可下载文件。客户端页面的“下载客户端”也只是发行商客户端，不是所选游戏安装包。

还需避免国际发行版本混淆：`Sabbat of the Witch` Steam app 888790 的本轮官方资料只有英、日，不能因为 HIKARI FIELD 中文版页存在，就把该 Steam app 标记成中文。应依据实际 app ID 和发行版本核对。

## 暂不采用的来源

- TouchGal：本轮普通匿名 GET/HEAD 均落入 Cloudflare 403 challenge，旧域名重定向至 `www.touchgal.ink`。不绕过验证，暂不作为稳定内置源。此项由主任务并行复核。
- Katawa Shoujo 的旧 `download.php`：本轮返回 Vercel Security Checkpoint，无法确认真实下载页，未收集游戏文件。
- Key 官网：本机普通 HTTPS 请求发生 TLS handshake 失败，未关闭证书验证或改动系统代理；本轮不声称该来源已验证可用。
- NekoNyan 猜测的 `/downloads` 返回 404，不能当作有效下载目录。其首页与 Aokana 子站可达，但本轮未找到验证过的文件直链。
- 任意网盘页、资源站详情页、Steam 商店 HTML、HIKARI 客户端安装器：均不能包装成游戏本体直链送入下载引擎。

## 应用接入顺序

1. 修复 KUN 有上限的资源分页，过滤失效条目，优先 Windows/中文/游戏本体；保留平台和语言多选、体积、更新时间及来源域名。目录故障应展示重试和原站入口。
2. 增加“官方试玩 / 免费作品”独立推荐区，至少放入已核验的 ATRI 中文试玩、千恋中文试玩和准确标注语言的 Narcissu、DDLC 免费原版。按钮直达具体官方作品页或试玩页，避免用户重新搜索。
3. 作品详情整合 KUN 中文资源索引、HIKARI 官方中文版和 Steam 版本入口。明确按钮是“官方商店”“试玩”“资源页”还是“文件直链”。
4. 官方真正的文件下载应再次检查状态码、内容类型和 Range，再传给文件引擎。归档下载完成不等于游戏已安装；不要自动执行下载的程序。

## 本地证据

小型脱敏摘要在 `.work/galgame-source-audit/`，仅保存公开作品/资源元数据与允许字段，不保存响应 Cookie、会话、表单令牌或完整游戏文件：

- `source-report.json`：代表性 KUN 搜索和公开站点状态。
- `followup-report.json` / `extra-report.json`：精确作品页、Steam 官方语言/免费/试玩字段及 KUN 目录。
- `direct-report.json`：原厂下载页与 Narcissu HEAD。
- `final-checks.json`：Narcissu 64 字节 Range、试玩详情、Steam 搜索和 KUN 总数。
- `pagination-report.json`：KUN 第 2/3 页，复现被首 50 条截断的有效资源。
- `demo-report.json`：官方 demo 入口、历史链接及排除项。

本次是来源可达性和类型审计，没有对商业游戏完成下载、解压或运行测试，也不承诺网盘速度及永久可用性。
