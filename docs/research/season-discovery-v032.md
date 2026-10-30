# 0.3.2 季度首页与撤源验证

日期：2026-10-30。用户要求移除 WeebCentral、快看，并让软件随季度更新。

## 当前行为

- 首页默认依据本地年月选择当季：1月冬、4月春、7月夏、10月秋。推荐和封面墙来自该季度首播作品，保留真实图片、简介、评分和人气，不固定写死作品。
- 自动跟随当前季度；运行期间每分钟及窗口重新获得焦点时检查跨季。可手动查看近12个季度，显式往季选择不会被强行切回；进入详情后返回仍保留季度，点击「回到本季」恢复自动跟随。
- 每页24部，支持继续加载。每周放送表独立保留，长篇连载不会仅因仍在放送而占据当季首播推荐。
- 按年、季度、页保存30分钟缓存；更新失败仅回退同季度同页，展示原更新时间。没有新季度缓存时明确报错，不拿旧季度内容冒充。
- WeebCentral 和快看从来源预设、类型菜单、搜索及下载适配器撤下；相关Nuxt解析器一并移除。旧type只保留兼容识别，以便安全清理旧来源配置。其它来源及历史文件、作品和任务保留。

## 官方接口与实际核查

参考 [Bangumi官方API规格](https://github.com/bangumi/api/blob/master/open-api/v0.yaml)，使用公开 `POST /v0/search/subjects`：空keyword、`sort:heat`、`type:[2]`、`nsfw:false`，并用 `air_date >= 季度首日` 与 `< 下一季度首日` 限定窗口。输出再次验证日期、动画类型及去重，不执行站点脚本、不登录。

实测发现服务端单次最多20条，即使请求24也会截成20；正式provider因此使用20+4合并为界面一页24，下一页从offset24开始，避免跳过条目。真实provider已读取2026Q4两页24+24、总数158，无跨页重复及跨季日期；新鲜缓存无网络请求，离线回退保留原时间。证据：[provider-live-proof.json](../../.work/season-discovery/provider-live-proof.json)。

## 最终桌面验证

最终程序：`DE8827C7B2164B27A1ABA57E69F8BAF3CA37B91ED466DAF10DF844834DBA9CDB`，24,618,496字节。安装包：`D9FF94A9F0CFC38D9D3F18E2B5BEE5D80C3A29C2FDCEECD8A7A752B8496C46A8`，6,860,091字节。两项[静态扫描](../../.work/security-audit/v032-season-final-scan.json)通过；NSIS未实际安装。

正常桌面窗口、Windows UIAutomation，无CDP/远程调试/注入。测试资料库复制自先前独立测试的SQLite和应用自身Local Storage，未复制Cookies；原测试资料库保留。实际完成：

| 操作 | 结果 |
| --- | --- |
| 默认首页 | 2026年10月秋季，24 / 158；真实《学生会也有洞！》封面及简介 |
| 加载更多 | 48 / 158，真实第二页 |
| 选择夏季 | 2026年7月，24 / 252；推荐与封面墙随之更换 |
| 回到本季 | 恢复当前秋季及自动跟随 |
| 进入漫画选源 | 仅MangaBZ、CopyManga、MangaDex、JMComic；无撤下两源 |
| 来源升级 | 12项来源仅删除指定2项，其余10项记录完整hash不变 |
| 其它资料 | 全部非来源SQLite记录hash不变；历史3份完成任务可见，3个CBZ现存hash与原校验一致 |

截图：[秋季](../../.work/v03-evidence/normal-season-v032/current-quarter.png)、[夏季](../../.work/v03-evidence/normal-season-v032/previous-quarter.png)、[剩余漫画来源](../../.work/v03-evidence/normal-season-v032/manga-sources-after-removal.png)、[历史下载保留](../../.work/v03-evidence/normal-season-v032/retained-downloads.png)。截至12:14:53（UTC+8）进程存活，无新增Defender检测/处置事件，随后正常关闭。

## 工程回归与交付

- TypeScript和生产构建通过，Vitest44文件/241项通过。
- Rust45通过、1项原外网probe忽略。
- 相关6项浏览器场景通过：撤源新建/升级/MangaBZ45章、季度24→48→49、往季详情返回、模拟跨年自动跟随/手选不跳、同季缓存与跨季拒绝。首轮5过1失败涉及旧测试文案及HMR，记录与修正后6项分别保留；未将其改记为首次全过。
- 最后在冻结代码上完整Playwright **23/23通过**，49.5秒，无失败或跳过；独立[日志](../../.work/e2e/v032-full.log)与[报告](../../.work/e2e/v032-full-report/index.html)保留，未覆盖先前专项回执。新季度真实网络和原生结果另有上述证据。跨年行为采用模拟时钟验证，没有改系统时间。

[汇总逐项校验](../../.work/v03-evidence/normal-season-v032/verification-final.json)核对来源差异、成品hash、运行及新旧发布文件身份。[0.3.2便携版与说明](../../release/v0.3.2/使用说明.md)不包含用户资料和测试媒体，旧0.3.0/0.3.1产物保持原hash。
