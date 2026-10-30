# 0.3.3 BT下载修复与NDM参考

日期：2026-10-30。用户反馈当季新番在蜜柑下载困难、怀疑下载实现；随后提供[NDM](https://github.com/fttawa/NDM)供参考，明确并非其自有项目。

## 实际任务

用户任务为北宇治《学生会也有洞 / 脑洞学生会》01无修WebRip HEVC简中；infohash `2f492ebf2f9b0207c063e36641296b9f26ab4b22`，416,074,928字节/397片。原torrent原始info字节SHA1与任务完全一致；[蜜柑原页面](https://mikanani.me/Home/Episode/2f492ebf2f9b0207c063e36641296b9f26ab4b22)及RSS没有换错文件或丢hash。

旧0.3.2只读RPC实际为error、错误码7、0字节、0连接、0做种；单任务timeout120，而全局默认0。错误码7只说明下载未完成，不能单凭该值认定具体超时原因。原前端没有取节点数，错误message为空时不解释错误码。证据在 `.work/bt-diagnostics/owned-engine-readonly.json`。

## 已落地的基础修复

- BT默认`bt-stop-timeout=0`，新任务和运行中的旧任务都可清除120秒硬停。
- 内置引擎使用`--no-conf`、官方DHT引导与应用资料目录内独立路由缓存。退出先通过认证RPC正常关闭并等待，超时仅停止自有子进程；没有关闭防护或改系统网络。
- 仅明确标记、准确内置地址和会话凭据允许连接失败后恢复引擎；外部aria2不会被自动接管。GID丢失时按原任务恢复，暂停意图保留。
- pause/resume/cancel跟随派生内容GID，不按目录控制其它任务；并发与单任务限速（含0清除）同步内置aria2。
- 显示取种子、取磁力元数据、找节点、传输、校验和引擎排队；真实零速与未知速度区分，保留错误码和已有进度，写操作防重。
- SQLite新增独立`diagnostics_json`，兼容旧记录并保存阶段/节点/校验信息；仅提取已知诊断字段，不能覆盖ID或路径。旧存储导入同步保留字段。

基线0.3.3工程检查：44文件/261项Vitest通过；Rust51通过、1项外网probe忽略（含本机真实aria2元数据跟随检查）；BT专项3及完整Playwright26通过。实际基线窗口确认>120秒不再硬停、显示0节点、暂停与重启恢复可用，但仍未传输，不以工程检查冒充吞吐改善。

## Tracker发现瓶颈与对照

原种子36个单URL tier，最先为旧Bangumi tracker；Nyaa HTTP第8、Anibt HTTPS第9。对原Tracker的合法scrape(GET)得到48和77个做种者；另一HTTPS tracker证书失败原样保留，未绕TLS。统计说明应继续查连接路径，不能直接推定缺种，也不保证每个做种者都可连接。

aria2 1.37逐项尝试Tracker，每个HTTP tracker自身重试2次，连接和请求超时各60秒；成功却零peer也不会继续搜索后面的tier。[官方实现](https://github.com/aria2/aria2/blob/release-1.37.0/src/DefaultBtAnnounce.cc)。仅追加`bt-tracker`会放末尾；动态`changeOption OK`也只保存选项，现有metadata列表不会重新构建，暂停/继续实际仍36tier。这些行为均已对照只读状态核实。

独立、可退出的原生引擎仅针对同一用户目标、独立临时目录，在新建任务的初始参数中先清原list、再优先加入原种子自带的Anibt与Nyaa；禁DHT用于隔离Tracker效果。沿followedBy确认同hash/416,074,928字节、实际2个tier：

| 时间 | 已下载字节 | 速度（B/s） | 连接 / 做种 |
| --- | --- | --- | --- |
| 5.0秒 | 32,768 | 193,893 | 44 / 1 |
| 10.1秒 | 5,144,576 | 991,629 | 39 / 5 |
| 15.1秒 | 14,647,296 | 1,561,580 | 9 / 5 |

达到少量正文后停止临时任务及自有引擎，用户原记录/目录未被替换。证据 `.work/bt-diagnostics/isolated-tracker-transfer.json`。该对照证明优先选择可用原Tracker在本样本有效，不能替代正式App集成与整集成品验收。

## 正式Tracker优化

仅对受管理内置引擎的原Mikan HTTPS hash命名Torrent，在新建任务时限时检查原HTTP(S) Tracker。元数据≤16MiB，受限bencode按原始info字节SHA1校验并比对URL hash；私有标记、异常字段、hash不符不探测。最多4 HTTPS与8 HTTP候选、每批≤4并发、总预算10秒；仅标准公开scrape路径，无query/passkey或猜测Token路径。

只接受正确infohash的合法scrape，至少有一个报告complete+incomplete>0才优先排序，完整保留其它原Tracker后备；拿到阳性立即取消仍未完成的探测，避免后面超时耗尽总预算。全失败、全零、私有种子或用户自定义Tracker设置均保留原列表；不新增外部Tracker，不关闭TLS，不改输出路径、系统代理或防火墙。

真实样本的Nyaa位于HTTP候选第8，因此补了“AniBT失败、前7HTTP失败、第8Nyaa阳性仍可置首”的回归。预检元数据与aria2实际下载元数据仍是对相同hash命名URL的两次GET，不能把预检称为完整消除了来源变化竞态；网络目标检查也不是完整DNS重绑定防护证明。本次实际引擎infohash、总量、36原Tracker与成品全分片另行核对。

## 正式桌面整集与重启续传

首份优化构建 `DA4ED86D…` 在用户原Data、原task ID、原source URL和目录中恢复任务。原生自动预检日志为`prioritized checked=3 positive=1`；只记录计数，不记录凭据或完整Tracker URL。实际aria2首Tracker变为AniBT，原36项保留。首段下载到 **217,792,512字节**，正常UI暂停后关闭。

最终构建 `11E35E1BC939EFCF99DF54E3BF79AFCF8B9828DEEB2CEFCA7A517C7432DD9767` 重启显示207.8MiB已暂停，点击继续后从已有分片恢复，40个连接/3个做种，随后实际达到约2MiB/s；没有新建重复的应用下载记录。完整完成时间15:10:23（UTC+8），文件：

```text
D:\ACGN\release\v0.3.2\Data\Files\Incoming\[KitaujiSub] Seitokai ni mo Ana wa Aru [01][Uncensored][WebRip][HEVC_AAC][CHS].mp4
```

| 成品检查 | 结果 |
| --- | --- |
| 字节数 | 416,074,928，与原torrent一致 |
| 分片 | 原torrent全部397片SHA1一致，每片1MiB（末片按实际长度） |
| 视频 | HEVC Main10、1920×1080、23.98fps |
| 音频 | AAC LC、48kHz、双声道 |
| 时长 | 1420.04秒，23分40秒 |
| 抽样解码 | 0、710.02、1415.04秒附近音视频均无错误 |
| SHA256 | `429D0C803E3772100CA04D4253D17E13793A161C0DBF035DF670D61E97C6B2FB` |

证据：[暂停检查点](../../.work/v03-evidence/normal-bt-v033-optimized/paused-checkpoint.json)、[分片校验](../../.work/v03-evidence/normal-bt-v033-final/piece-verification.json)、[视频解码](../../.work/v03-evidence/normal-bt-v033-final/video-verification.json)、[完成页面](../../.work/v03-evidence/normal-bt-v033-final/app-completed.png)。这是正式App通过BT取得的原任务成品，不是先前B站投稿或临时引擎片段。

最终正式发布exe又正常重启，原任务完成记录和文件保留，[发布后重启页面](../../.work/v03-evidence/normal-bt-v033-release/completed-after-release-restart.png)。15:12:39（UTC+8）窗口存活，无新增Defender检测/处置事件，当前留窗口供用户继续使用。所有操作无CDP、远程调试或脚本注入，防护保持开启。

## 发布与工程检查

- 最终程序24,811,520字节，SHA256 `11E35E1BC939EFCF99DF54E3BF79AFCF8B9828DEEB2CEFCA7A517C7432DD9767`。
- 安装包6,926,462字节，SHA256 `88160BCDEFE63562F584557A78F927D5BB90F1FAB978F8665A22AAEE80F39E04`；未实际安装。
- [最终静态扫描](../../.work/security-audit/v033-bt-resume-final-scan.json)两项通过；较早2E8C/DA4E身份与扫描独立保留。
- Vitest44文件/263项通过。此前一次默认多worker与构建同时运行触发内存分配失败，构建CLI也失败；后以单worker/限并发、顺序完成最终检查与构建，未隐藏失败事实。Vitest配置默认限制2worker以减少重复出现。
- Rust62项通过/2默认忽略；真实本地元数据+mock scrape审计已单独显式通过，另一原有live封面probe未运行。新增预检测试不发公网BT，原有loopback BT回归保留。
- 完整浏览器26项通过；最后父GID设置竞态、恢复时保留内容进度两处窄修后相关单测与[BT专项3项](../../.work/e2e/v033-bt-final.log)通过，没有把早先26项改记为再次完整运行。
- 桌面快捷方式已指向[本机升级启动脚本](../../START-ACGN-0.3.3.cmd)，运行新exe并继续使用原`release/v0.3.2/Data`。原SQLite、应用自身Local Storage和旧快捷方式已备份；没有复制浏览器Cookies。普通新版便携脚本使用新版独立Data，两个实例不要同时写原资料库。
- [release/v0.3.3](../../release/v0.3.3/使用说明.md)不附带用户Data或测试媒体。旧0.3.0/0.3.1/0.3.2发布产物hash均与各自manifest一致；原任务保持同ID/目录，数据库仍仅1条下载记录。

最终逐项校验见[verification-final.json](../../.work/v03-evidence/normal-bt-v033-final/verification-final.json)。本次真实成功证明这条原任务已修通，不承诺所有资源相同吞吐。

NDM详细核查见[评估报告](ndm-integration-assessment.md)：目前只作设计参考，没有复制项目代码或打包其程序。正式优化后的构建、扫描和原生证据已按上述身份对应。
