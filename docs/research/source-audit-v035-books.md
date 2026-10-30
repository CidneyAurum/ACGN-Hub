# 0.3.5 漫画、轻小说下载源实审

核查时间：2026-10-31 00:07–00:13（Asia/Shanghai）。本轮按现有生产 provider 发起普通公开 HTTP 请求，验证搜索、作品身份、目录及实际内容。没有更改来源地址、Token、启用状态、数据库或用户下载。没有访问 JMComic 成人样本，也没有恢复用户已移除的 WeebCentral、快看。

## 结论与建议顺序

| 来源 | 实测链路与内容 | 边界 | 建议定位 |
| --- | --- | --- | --- |
| [MangaBZ](https://mangabz.com/) | 《葬送的芙莉蓮》作品 7020，148 个中文章节；“1-3卷附贈”章节 160382 返回 11 页描述，首张 JPEG 764×1200、129730 字节，完整像素解码通过 | 本次样本为附赠章节，不能拿它的尺寸代表每章。无登录、Python 前提；普通网页规则变化、原站验证或临时图片签名过期仍可能失败 | 中文漫画优先 |
| [拷贝漫画配置节点](https://mapi.hotmangasg.com/) | 《腦洞學生會》准确匹配原作，234 个章节；第01話返回 17 页描述，首张 WEBP 892×1280、221986 字节，完整像素解码通过 | 本次匿名请求成功，不能宣称所有章节必须 Token，也不能保证所有章节永久公开。URL 带 h1500 不等于实际图高1500；保留服务端图像，不放大、不转码。实际使用遇到原站登录要求时再配置 Token | 中文漫画并列优先，补充 MangaBZ 收录 |
| [MangaDex](https://mangadex.org/) | 搜索和图像机制可用；一个明确标识的中文同人单页可取得原图 `/data/`、PNG 1080×1654，并完整解码 | **《葬送的芙莉莲》原作** b0b721ff-c388-4486-aa0f-c2b0bb321512 的当前中、日、英 feed 为空，现有 provider 正确拒绝生成空 CBZ。不能用同人的图片成功证明原作能下。来源多语，作品显示名不代表章节语言 | 多语原图备用；先确认具体作品和章节 |
| [LNovel](https://lnovel.animes.garden/) | 《文学少女》nid88，20卷；第一卷10章；正文序章 cid12412 实际返回1512字，其中1330个汉字，非目录、版权信息或图片占位 | 当前无需登录、Token或Python。现有应用逐章拼接中文 TXT，**不包含插图**。目录是项目抓取缓存，站点返回的 updatedAt/fetchedAt 与本次 checkedAt 含义不同；新卷是否已收录取决于上游缓存 | 中文轻小说 TXT 优先 |
| [Internet Archive](https://archive.org/) | 准确选择1980版《西游记 上》identifier 1980_20240422_202404，有TXT、EPUB、PDF、ZIP；TXT文件 HTTP206，取前2048字节，含418个汉字 | 全站混合语言、格式、原作及同名衍生，不是中文轻小说专库。限制借阅、私有文件不等于可下载。现有 adapter 依 metadata 排除 private/noindex，具体公开文件还需实探；本次样本是公开文件 | 公开电子书辅助兜底 |

以上“优先”是入口排序建议，不代表自动启用来源或替换用户配置。仅索引在线时应显示“搜索接口正常，章节待核实”，不能直接显示“下载已验证”。同一来源不同作品、章节的状态可能不同。

## 本次发现的实际易错点

1. 短词 `Frieren` 的默认首候选是同人《Frieren Cinnamoroll Kamigata》，原作在第二项。使用原作准确标题 `Sousou no Frieren` 与原作稳定 ID 后，得到空章节 feed。推荐保留明确的“确认来源作品”步骤，显示原名、年份及可得语言；不把第一个模糊匹配自动当原作。
2. IA 搜索“西游记”首项为番茄网文同人《西游记：菩提祖师下山》，并非吴承恩原作。本次重新选定1980版《西游记 上》才验证实际文件。搜索命中与准确版本匹配必须分开判断。
3. LNovel 第一卷首个目录项名为“插图”，返回内容以录入、校对、转载说明为主。初探不能证明正文完整；本次另选正文序章验证中文内容。TXT下载不应宣传为带插图的 EPUB。
4. 图链后缀、参数不是清晰度证据。所有图像结论均来自 Pillow 完整解码后的实际宽高；不比较不同章节的画质优劣，也不把1280图标成1500图。MangaDex现有 `/data/` 使用原图而不是 `data-saver`。

这些是本次真实检查的边界。没有证据表明上述源必须新增破解、验证码处理或隐藏节点，故本轮不添加未经验证的替代源，不尝试绕过原站限制。

## 请求方式与证据

- [可复核审计脚本](../../.work/source-audit-v035/audit-books.mjs) 使用 Vite SSR 加载现有 `MangabzSourceProvider`、`CopyMangaSourceProvider`、`MangaDexSourceProvider`、`LNovelSourceProvider`、`InternetArchiveSourceProvider`，注入记录器后仍使用现有 provider 请求地址、方法和请求头。
- 记录器只保存 URL、状态码、耗时、响应类型、字节数和 SHA-256 等概要，不传入用户 Cookie 或认证信息；临时图像 key 在证据中遮蔽。
- MangaBZ、拷贝各取一张封面/转载说明页与一张正文页，以免把日文封面误当作中文译文；两个来源的第3页均目视确认有繁体中文对白。MangaDex取一张明确标识的独立同人图片，总计5张单页，没有下载整章 CBZ。LNovel取过一个插图项与一个实际正文 API 响应，不输出整卷；IA只读取并保留前2KiB的统计，取消后续响应流。
- [图像验证](../../.work/source-audit-v035/image-verification.json) 包含五个单页的格式、实际像素、大小、SHA-256及完整像素解码结果。其中 MangaDex 图片属于第一轮明确记录的独立同人作品，不属于第二轮检查的原作。
- 分来源证据为同目录 `mangabz-audit.json`、`copymanga-audit.json`、`mangadex-audit.json`、`lnovel-audit.json`、`archive-books-audit.json`。第一轮不准确候选与插图正文误判保留为 `*-first-pass.json`，没有覆盖成成功证据。

本轮是源链路审计，不等同于再次完成正常桌面 UI 操作、全卷 TXT 或整章 CBZ 成品验证。历史整章成品证据见 [0.3.1 漫画源核查](manga-sources-v031.md)，应按其原核查日期理解；其中用户后来移除的源不在本轮推荐范围。

## 原站、官方项目与协议参考

- [LNovel 官方项目](https://github.com/yjl9903/lnovel) 的 README 明确提供轻小说开放接口，并链接 [JSON API 请求示例](https://github.com/yjl9903/lnovel/blob/main/examples/api.http)。项目链接由 LNovel 原站首页确认；项目不是原作出版社，Bangumi作品元数据的权威性不能转移为下载源的版权或质量保证。
- [MangaDex 官方 API 文档](https://api.mangadex.org/docs/) 与本次现有 adapter 的搜索、chapter feed、@Home `/data/` 路径一致。
- [Internet Archive 官方 metadata 文档](https://archive.org/developers/metadata-schema/index.html) 用于解释元数据、文件与访问状态；具体文件可下仍以上表实际 Range 响应为准。
- MangaBZ 与拷贝使用当前已配置原站/节点的普通公开接口；本次没有复制外部下载器实现或切换用户节点。
