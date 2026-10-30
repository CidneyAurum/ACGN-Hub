# 《脑洞学生会》真实来源核对

核对时间：2026-10-29 22:20–22:30（本机）。只读取公开页面、目录及响应头，没有下载其它作品替代本片，也没有绕登录、付费或 DRM。

## 作品身份

原文《脑洞学生会》确实有对应作品，不是《妄想学生会》。[Bangumi TV 条目 554779](https://bgm.tv/subject/554779)的日文名为《生徒会にも穴はある！》，中文标准名为《学生会也有洞！》，别名中包含《脑洞学生会！》、`Seitokai ni mo Ana wa Aru!`、`Even the Student Council Has Its Holes!`，共 12 话，2026-10-03 开播。[官方站](https://nama-anaru.com/)与[放送/配信页](https://nama-anaru.com/onair/)对应同一作品。

## 已有下载来源的实际返回

### 蜜柑、AcgnX：找到了目标剧集，但当前是 BT

真实公开目录：

- [蜜柑日文名 RSS 搜索](https://mikanani.me/RSS/Search?searchstr=%E7%94%9F%E5%BE%92%E4%BC%9A%E3%81%AB%E3%82%82%E7%A9%B4%E3%81%AF%E3%81%82%E3%82%8B)：HTTP 200，10 项。
- [AcgnX 原中文名 RSS 搜索](https://share.acgnx.se/rss.xml?keyword=%E8%84%91%E6%B4%9E%E5%AD%A6%E7%94%9F%E4%BC%9A)：HTTP 200，19 项。

蜜柑目录中可核对的实际条目包括：

| 内容 | 字幕/格式 | 目录登记大小 | 附件类型 |
| --- | --- | ---: | --- |
| 第 1 话，TSDM | 简日双语内嵌，1080p AVC MP4 | 283,639,808 字节 | Torrent |
| 第 1 话，TSDM | 简日双语内嵌，1080p HEVC MP4 | 322,541,984 字节 | Torrent |
| 第 1 话，TSDM | 简日双语内封，1080p HEVC MKV | 200,173,152 字节 | Torrent |
| 第 4 话，TV/其它版本组合条目 | 简/繁，1080p H.264 AAC | 1,202,590,848 字节 | Torrent |

例如第 1 话 AVC 项的附件为 `https://mikanani.me/Download/20261025/f97d21d21c1fbe8633f53a1b22f9a373393e7ca8.torrent`。这是**种子文件的 HTTP 地址，不是 MP4 视频直链**。目录中的 MP4、1080p 等描述是 BT 内部内容格式，不能据此告诉用户能用 aria2 直接下载正片。本轮未提交这些 BT 任务，未确认做种及实际传输。

### Internet Archive：目标正片 HTTP 尚未找到

按原中文名的标题检索返回 0 条。按日文、罗马字以及已确认英文别名检索，实际找到：

- 2 个番宣 CM 条目。
- 1 个官方歌曲/PV 宣传条目。
- [英文名 Media History 条目](https://archive.org/details/even-the-student-council-has-its-holes-media-history)：元数据确有 MP4，但文件时长只有 **25.04 秒**，大小 **3,143,007 字节**，不是一集正片。

对应[公开元数据](https://archive.org/metadata/even-the-student-council-has-its-holes-media-history)明确给出文件名和时长。未把这些片段下载为用户所需成品。匹配逻辑已经为 `CM`、`PV`、`Media History` 等加上“音乐、片段或二创内容，不是正片剧集”提示，并保留真实文件时长字段。

## 官方播放入口不等于可下载文件

[官方配信页](https://nama-anaru.com/onair/)提供了实际观看入口，例如：

- [d アニメストア](https://animestore.docomo.ne.jp/animestore/ci_pc?workId=29286)
- [AnimeFesta](https://animefesta.iowl.jp/new_episodes?play_episode_id=9654&tid=2090)
- [ABEMA](https://abema.tv/video/title/26-273)
- [Netflix](https://www.netflix.com/jp/title/82616221)
- [niconico 系列页](https://www.nicovideo.jp/series/580657?rf=nvpc&rp=watch&ra=video_detail)

这些是站内观看页面，可能有地区、账号或订阅条件。没有提取或绕过其受保护视频；不能把页面 URL 交给 aria2 冒充视频直链。

公开搜索另出现 [B 站第 1 话中文字幕页面](https://www.bilibili.com/video/BV1UqHi6uEie/)。当前网络访问公开搜索和 view API 都返回 HTTP 412，因此本轮没有验证播放流，更不能声明已验证可下载。

## 本轮结论

已经确认目标身份，并找到它的真实剧集 BT 目录和官方播放入口；在现有 Archive/RSS 适配范围内，**还没有验证到本片正片的 MP4/HLS HTTP 下载路径**。不能用 25 秒宣传片或其它动画的下载成功替代该缺口。

原始证据保存在 `.work/real-workflow/target-bangumi.json`、`target-mikan.xml`、`target-acgnx.xml`、`target-archive-jp.json`、`target-archive-en.json`、`target-archive-media-history.json`、`target-onair.html`。这些仅是公开元数据/目录响应，不含作品正文、用户凭据或下载任务。

## 交给原生下载验证的准确条目

已将精确参数写入 `.work/real-workflow/requested-title-resource.json`，不再使用其它动画样例：

- 动画选择桜都字幕组第 1 话，1080p、简繁内封，185,870,576 字节；Mikan Episode ID `ff7b1a88b5d16e94adc598e3d52b92439bc9d20c`，为此次目录里第 1 话最小体积项。该 Episode 页面同时给出剧目 ID `4064` 与 Bangumi `554779`，身份关联已核对。同文件含准确 `.torrent` 与带 tracker 的 Magnet，实际传输及是否完成由主代理的隔离原生流程验证。
- 原作漫画准确来源名称《腦洞學生會》，CopyManga `path_word=naoodngxueshenghui`（站点原值，不能自行纠正拼写），作者むちまろ。真实公开检索排第 1，233 章；第 1 话 UUID `50fea5ac-c587-11ec-8361-024352452ce0`，descriptor 给出 17 页及 Referer。完整 descriptor 已交给原生生成 CBZ。本子任务没有下载这些图片。

同时修正当前目标触发的标题匹配缺口：`腦/學` 简繁差异、逗号分隔的别名和同名官方插画集降权，避免原作被插画集或部分别名淹没。
