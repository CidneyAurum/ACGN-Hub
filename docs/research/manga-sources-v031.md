# 0.3.1 漫画源与画质验证

核查日期：2026-10-30。用户要求增加优质漫画源，本轮将能正确匹配作品、读取完整章节和保留原图作为接入标准。

| 新来源 | 适用范围 | 当前真实目录与图片样本 |
| --- | --- | --- |
| [MangaBZ](https://mangabz.com) | 中文日漫，注意简繁译名 | 《葬送的芙莉蓮》7020，148 章；第 1 话 117618，共 39 页；样本 JPEG 1115×1600 |
| [WeebCentral](https://weebcentral.com) | 英文漫画，英文/罗马字或作品 ID 搜索 | Frieren，147 章；第 1 章 39 页；样本实际 JPEG 1067×1600（URL 为 .png） |
| [快看官方](https://www.kuaikanmanhua.com) | 国漫及官方公开免费章节 | 《怦然心动》766，254 个明确免费目录条目；第 1 话 10950 共 151 片；样本 JPEG 1280×1000 |

这三项默认关闭；从「找资源 → 漫画」选来源，点击「启用此来源并搜索」，确认作品后进入章节页下载。原有 CopyManga 和 MangaDex 保留。快看只显示权限明确公开免费的章节，下载前再次检查；不接入签名接口、不处理登录、付费和 VIP 章节。

保存源站图像，不转码、不压缩、不把缩略图放大。快看优先公开 SSR 中的 `url1280`。MangaDex 沿用原图 `/data/`，没有改为 data-saver。原生下载与 CBZ 打包按实际图片签名命名，拒绝 HTML / JSON / 空响应，避免“下载完成”后无法阅读。

本轮没有确认 MangaBZ 收录《脑洞学生会》，不会用《妄想学生会》等相近结果替代。该作原有 CopyManga 路径和历史 17 页成品保持不动。

## 研究与实现

- 参考 [Keiyoushi 扩展源码](https://github.com/keiyoushi/extensions-source)，用站点当前普通公开页面和图片复核；快看旧扩展字段已过时，正式接入以当前公开 SSR 为准。
- MangaBZ 图链使用字符串表数据解码；快看 Nuxt 数据使用限长、限深、限节点的受限解析器。都不执行站点 JavaScript。
- 章节记录只持久化稳定作品/章节 ID；临时图片签名在下载前重新取得。重启后可恢复来源章节。
- v17 来源迁移只补充缺失的新预设，不覆盖现有 URL、Token 和启用状态，也不恢复用户已删除的旧来源。若旧 localStorage 来源仍非空或损坏，自动补充会跳过；此类用户可在「来源管理」手动添加三个预设。
- 未推广本机遇到验证码的包子、TLS 失败的漫画柜、Cloudflare 限制的 MangaPill、403 的 ComicWalker，及返回 protobuf 错误的 MANGA Plus；HTTP 200 本身不能证明可用。

目录、正式 provider、单张图片和受限语法证据在 [.work/manga-source-research](../../.work/manga-source-research/)。浏览器固定响应回归与真实原生下载分开记录；最终成品结果将在下面列明。

## 真实界面中发现并修复的问题

1. 封面请求旧规则把含 `manga` 的域名统一设置成 CopyManga Referer。已为 MangaBZ、WeebCentral 图片域、快看图片域分别设置对应来源；正常 UI 中三个新源的样本封面实际显示成功。
2. 第一份 0.3.1 构建在 WeebCentral 搜索成功后，进入详情错误地提示站点验证。原因是正常完整 HTML 页附带 `/cdn-cgi/challenge-platform/scripts/jsd/main.js`，被全文匹配误判。已改为识别真正的错误标题、挑战表单/容器和主动挑战脚本；普通附带脚本不阻止读取现成公开正文。没有执行该脚本或处理验证。

第二项曾被“同一 provider 搜索后读取目录”的缓存掩盖。补充了全新 provider 不经搜索、按稳定 ID 读取真实详情 → 147 章 → 首章 39 页的检查，以及普通页和真正挑战页的分立回归。原始界面失败截图与修复后的证据分别保留。

## 工程检查

- TypeScript 检查与生产构建通过；完整 Vitest 45 文件、258 项通过。
- Rust 45 项通过、1 项原有外网 probe 忽略。
- 完整 Playwright 21 项通过；新来源的首轮测试定位/错误持久化假设导致的 4 项失败原样保留，修正测试假设后定向 4 项及完整 21 项通过。后续 WeebCentral 真正详情页问题单独补回归，不用早先浏览器结果代替真实下载。

回执为 [.work/e2e/full-manga-regression.log](../../.work/e2e/full-manga-regression.log)。原生图片验证仅检查格式签名，不等同于完整像素解码；下面的成品验收另用 Pillow 解码每一页并检查 ZIP CRC。

## 桌面整章成品

使用独立 `.work/normal-manga-v031-profile`，通过 Windows UIAutomation 操作正常桌面窗口；没有 CDP、远程调试或注入。第一份构建身份为 `D01B3468E4323A637C7E84C41AFA50D64250D0EF383073E5AE02824A19ECE2BD`。

| 来源与章节 | 页数 | CBZ 字节数 | 完整成品检查 |
| --- | --- | --- | --- |
| MangaBZ《葬送的芙莉蓮》第 1 话 | 39 | 9,357,847 | ZIP CRC / 39 页解码通过；首页 1115×1600；含不同尺寸和跨页原图 |
| 快看《怦然心动》第 1 话「没有偶然的相遇」 | 151 | 20,870,265 | ZIP CRC / 151 片解码通过；全部宽 1280，高度 164–1000 |

完成页面见[两章完成截图](../../.work/v03-evidence/normal-manga-v031/two-chapters-completed.png)；逐页尺寸和 SHA-256 见 [MangaBZ 校验](../../.work/v03-evidence/normal-manga-v031/mangabz-cbz-verified.json)与[快看校验](../../.work/v03-evidence/normal-manga-v031/kuaikan-cbz-verified.json)。截至 10:58:24（UTC+8），该次进程仍存活、防护开启，没有新增 Defender 1116 / 1117 事件，随后正常关闭。

上述两份成品对应第一份构建；WeebCentral 误判修复后的构建单独对应后续验证，不混记成同一次运行。

### 最终构建的英文源实测

修复后的程序 SHA-256 为 `8DABCBD80AF334490F5C81357EACE124AE5A1A82F1685F3C7A6671A2BC568BA5`。程序及 NSIS 均重新静态扫描通过，证据为 [v031-manga-corrected-scan.json](../../.work/security-audit/v031-manga-corrected-scan.json)。NSIS 未实际安装。

在相同隔离资料库中正常重启，前两份完成记录及路径保留；再实际搜索 Frieren → 选择准确作品 → 完整 147 章 → 第 1 章 → 下载 39 页 → 发布 CBZ。成品 **17,029,892 字节**，ZIP CRC / 全部 39 页解码通过，SHA-256 为 `0660f581ea6de52bf7e03ce6683b306f3e08c4e835b9c20f3a0cfd9973f3e147`。实际 JPEG 使用 `.jpg` 入包，没有沿用源站错误的 `.png` 后缀。

证据为 [WeebCentral 成品校验](../../.work/v03-evidence/normal-manga-v031-final/weebcentral-cbz-verified.json)、[完整章节页](../../.work/v03-evidence/normal-manga-v031-final/weebcentral-chapters-corrected.png)及[三章完成页面](../../.work/v03-evidence/normal-manga-v031-final/three-chapters-completed.png)。截至 11:04:03（UTC+8），最终构建进程存活，观察窗口无新增 Defender 检测/处置事件，随后正常关闭。

最终源码检查为 258 项 Vitest，通过时间 10:55，已包含 WeebCentral 修复；11:01 的最终桌面构建再次通过 TypeScript 与生产构建。早先完整 21 项浏览器回归、修复后定向 4 项回归及本节真实整章证据分别记录。

最终构建再次正常重启后，三份完成记录和文件保留，见[重启页面](../../.work/v03-evidence/normal-manga-v031-restart/three-records-after-restart.png)。11:04:49（UTC+8）观察窗口无新增检测，随后正常关闭。逐项[汇总校验](../../.work/v03-evidence/normal-manga-v031/verification-final.json)核对了三份CBZ现存hash、两次构建身份、三个运行窗口及新旧release产物；[0.3.1交付](../../release/v0.3.1/使用说明.md)独立保留，不包含用户数据库或测试媒体。
