# 真红小站文件来源核验（0.3.8）

核验日期：2026-10-31。此次实际访问公开站点并阅读站方公开源码；网页搜索工具返回 503，使用普通匿名 HTTP 与 GitHub API 继续核验。未读取浏览器 Cookie、未登录、未调用下载统计写接口，未下载或运行完整游戏。

## 来源与公开协议

- [真红小站](https://www.shinnku.com/) 与 [站方项目](https://github.com/shinnku-nikaidou/shinnku-com) 的 homepage 相互对应。核验时源码 commit 为 `9beea005e975d2bc801696d2f36a3e9e0c39b2a3`，项目有 [MIT 许可证](https://github.com/shinnku-nikaidou/shinnku-com/blob/main/LICENSE)。适配器自行实现，只参考公开响应结构和站方公开路由，未复制站方页面代码。
- [搜索页](https://github.com/shinnku-nikaidou/shinnku-com/blob/main/frontend/app/search/page.tsx) 在 `GET /search?q=关键词` 的服务端 HTML 中带回最多 200 条语义搜索结果。Next/RSC JSON 数据里的 `answer[].info` 包含 `file_path`、`file_size`、`upload_timestamp`。该 HTTP 页面可匿名访问，公开站点未暴露等效、已验证的 JSON 搜索 API。
- [文件详情页](https://github.com/shinnku-nikaidou/shinnku-com/blob/main/frontend/app/files/%5B...slug%5D/page.tsx) 的 `/files/shinnku/{逐段编码的路径}` 返回同一结构的 `info`，目录页返回 `inode`。保存的文件 ID 可据此重新验证，不依赖进程内搜索缓存。
- [站方下载 URL 规则](https://github.com/shinnku-nikaidou/shinnku-com/blob/main/frontend/lib/url.ts) 与 [文件详情的下载按钮](https://github.com/shinnku-nikaidou/shinnku-com/blob/main/frontend/components/files/GameIntro.tsx) 将 `shinnku` 文件库映射到 `https://zd.shinnku.top/file/shinnku/{逐段编码的路径}`。这是真实档案地址，不是商店、网盘分享页或种子。
- 源码另有公开的 `/api/r2/download-url/...`，匿名测试返回 302 与临时签名 URL。适配器使用稳定下载地址，不持久化或记录签名、不推导私有 key，也不需要这个临时路由。

## 实际作品核验

站方同目录说明可补充版本差异和校验信息：[CLANNAD README](https://www.shinnku.com/files/shinnku/0/win/CLANNAD/README.md)、[Summer Pockets README](https://www.shinnku.com/files/shinnku/0/win/Summer%20Pockets/README.md)。本轮核查官方简介、仓库及这两份说明，未发现统一公开解压密码，不能据此保证所有归档都无需密码；具体档案以原站资源说明为准。

以下是来源所标记的 Windows 中文目录中的档案条目，不能据此断言压缩包内所有文本的翻译质量或程序安全性。核验只读取目录、详情和至多 64 字节档案前缀，未完整下载、解压或执行。

| 作品与来源版本 | 档案大小（字节） | 搜索及独立详情恢复 | 下载端点结果 |
| --- | ---: | --- | --- |
| CLANNAD（官中） | 2,962,220,920 | 匿名成功 | 7z 类型及大小吻合；曾返回 206 与 64 字节 7z 前缀，也有请求返回 200 |
| ATRI -My Dear Moments- v1.3 | 3,781,414,904 | 匿名成功 | 206，64 字节，7z 前缀 `377abcaf271c`，Content-Range 总长吻合 |
| 千恋万花（官中） | 8,108,024,871 | 匿名成功 | 返回 200、7z 类型和正确总长；受探测体积上限控制，未接收大文件 |
| Summer Pockets（Steam 汉化版） | 5,160,140,667 | 匿名成功 | 返回 200、7z 类型和正确总长；受探测体积上限控制，未接收大文件 |

**断点和速度的实际边界：** 同一服务并非每次 Range 请求都返回 206。不能仅凭 `Accept-Ranges: bytes` 保证断点续传或多连接加速；适配器统一提供 `rangeSupport: unknown`，由下载时的引擎探测确定实际行为。没有大文件吞吐速度或完整游戏可运行性结论。

本地证据保存在 `.work/gal-v038/`，不纳入 Git：

- `shinnku-search-{clannad,atri,senren,summer}.html/.json`：实际匿名搜索响应与结构化文件目录。
- `shinnku-probe-search.json`：四组搜索、数量与选中的 Windows 文件。
- `shinnku-probe-ranges.json`：有体积保护的 Range 探测，只保留状态、公开地址、必要响应头和小文件前缀，无临时签名。
- `shinnku-provider-live.json`：适配器读取真实搜索响应，并新建无缓存实例刷新四个文件详情和恢复下载 URL，均成功。
- `probe_shinnku.py`、`shinnku.live.test.ts`：对应核验脚本。因 CDN 与语义搜索顺序会变化，后续复跑状态和结果顺序可能不同。

## 已实现的接入边界

`ShinnkuSourceProvider` 只处理 `shinnku` 文件库的 `0/...` 与 `zd/...` 档案，不把另一套 `galgame0` 日文合集存储规则套到当前下载地址。

- JSON-only 解析：只 `JSON.parse` 站方 Next/RSC 数据，不执行或解包页面脚本。挑战页、非预期 HTML、HTTP 权限错误会明确报错，不绕过访问控制。
- 目录和搜索有界：最多三种名称搜索；每个页面不超过 3 MiB、目录最多 10,000 个文件、展示最多 80 个匹配版本。源站语义搜索只返回前 200 项，达到上限时标记 `catalogTruncated`；不伪造“下一页”。
- 本体、补丁、试玩、原声、画集与攻略按明确文件标记分开；Windows、移动移植分开。只有明确中文版本标记或站方明确归类为熟肉的 `0/win` 目录才显示“中文（来源标记）”。普通中文文件名、`zd` 路径或移动目录不作为语言依据，未知保持待确认。
- 完整保留文件名、体积、格式、版本、来源详情与更新日期；`downloadMode: direct_file` 仅用于实际档案地址。
- 多卷档案重新读取父目录，给出全部同组分卷、卷号、所需文件名及解压说明；缺首卷、断号或只找到一个分卷会报错。目录能确认当前列出的连续分卷，无法证明源站从未漏上传尾卷。档案仍需下载后解压确认。
- 持久化选择使用 `file:{编码后的原站路径}`，重启后可直接刷新详情；下载目标使用稳定公开地址，并保留 `.7z.001`、`.part1.rar` 等分卷后缀。

验证：新增 41 项针对目录协议、独立实例恢复、语言依据、恶意脚本、错误响应、分卷完整性与路径安全的单测通过；TypeScript 类型检查通过；实际四作品适配器详情恢复验证通过。其余桌面集成及发布验证由主任务记录。
