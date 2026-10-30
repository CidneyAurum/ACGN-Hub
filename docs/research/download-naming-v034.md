# 0.3.4 下载成品自动命名

记录日期：2026-10-30，Windows x64。用户明确要求“可以下载完之后将文件改名”。本轮在已修复并真实完成的 BT 下载链路上增加成品命名；不以重新下载或改界面标题代替物理文件改名。

## 当前状态

0.3.4 已完成实际命名、正式程序重启和发布验收。原北宇治第1话416,074,928字节文件在同一目录改为 `学生会也有洞！ - 第01话 [简中] [HEVC].mp4`，内容SHA256不变，397/397个原种子分片通过；下载完成状态与原名记录在发布exe重启后保留。TypeScript、282项前端测试、73项Rust测试与29项完整浏览器回归也分别通过。真实桌面与模拟浏览器证据分开记录，NSIS未实际安装。

## 最终行为

- 设置中“下载完成后自动命名”默认开启。仅已完成的 aria2 单文件任务自动处理，未完成文件不动，避免影响续传。
- 名称来自已关联作品与可靠单集信息；不调用网络翻译。保留原扩展名及已明确的清晰度、字幕或编码信息，不把未证明的1080p加到文件名。
- 仅在原目录改名，不移动到Library，不覆盖已有目标。不能确定作品或集数、合集/特典等情况保留原名并显示原因。
- 多文件任务不批量套用同一集数；用户在下载中心选择实际文件后逐项预览、编辑并确认。
- qBittorrent 任务提示在其客户端改名，保留做种与路径关联。本地MP4/CBZ/TXT生成已有标题名称，不增加第二套复杂表单。
- 下载中心保留原名和原位置记录，支持旧名与现名搜索；命名失败或冲突独立显示，不改变下载完成状态，也不重新下载。
- 原生命名期间禁止再次命名或删除本任务；恢复信息明确呈现。手动编辑必须保留原扩展名。

浏览器固定样本为 `[Kitauji] Seitokai ni mo Ana wa Aru! [01][CHS][HEVC].mp4`；真实目标原名为 `[KitaujiSub] Seitokai ni mo Ana wa Aru [01][Uncensored][WebRip][HEVC_AAC][CHS].mp4`。两者分别验证命名规则与实际改名，不能混记为同一次文件操作。

## 已完成的工程与浏览器验收

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 退出0 |
| `npx tsc --noEmit -p tests/e2e/tsconfig.json` | 退出0 |
| 命名UI专项 | 修正固定样本后3/3通过，10.6秒，单worker |
| 完整Playwright | 29/29通过，1.3分钟，单worker，退出0，无跳过 |
| 完整Vitest | 46文件/282项通过，单worker，15:49:24，18.26秒 |
| 完整Rust | 73通过、0失败、2默认忽略，0.93秒 |
| 计数回执 | [automated-checks.json](../../.work/v03-evidence/normal-naming-v034/automated-checks.json) |
| 完整回执 | [v034-naming-full.log](../../.work/e2e/v034-naming-full.log)、[HTML报告](../../.work/e2e/v034-naming-full-report/index.html) |
| 成功状态文件 | `.work/e2e/v034-naming-full-results/.last-run.json`：`status:"passed"`、`failedTests:[]` |
| 原生文件边界 | Windows junction实测通过；file symlink创建受权限1314限制，仅验证防御分支，未声称实际创建成功 |
| 最终发布构建 | 0.3.4 exe与NSIS身份见下表；均完成本轮静态扫描 |

专项检查三个场景：设置默认true并可关闭后刷新保留；单文件与多文件预览、手动编辑、缺少关联保留原名、qBittorrent不提供直接命名；原名搜索以及命名失败仍显示下载完成。浏览器确认按钮禁用，真实文件路径及字节不被测试修改。

首轮专项2过1失败。原因是“命名失败”固定样本仅改了显示filename，files仍沿用另一个Kitauji原路径，搜索Kitauji因而正确找到两行。仅修正测试样本自身路径，未改生产过滤逻辑；首轮 [v034-naming-target.log](../../.work/e2e/v034-naming-target.log)和失败trace保留，修正后 [v034-naming-target-retry.log](../../.work/e2e/v034-naming-target-retry.log)3/3通过。

## 正常桌面与发布证据

以下证据对应0.3.4本轮程序、实际文件和数据库。0.3.3的原视频已完成下载及解码，本轮仅改名，没有重新下载或重新编码；改名后再次校验内容与原种子。

改名前数据库通过在线备份保存到 `.work/v03-evidence/normal-naming-v034/backup-before/acgn-hub.db`，原任务及旧版产物摘要也已保存。原文件内容哈希与0.3.3历史成品匹配；改名后的[after.json](../../.work/v03-evidence/normal-naming-v034/after.json)、[分片校验](../../.work/v03-evidence/normal-naming-v034/piece-verification.json)、[同名确认](../../.work/v03-evidence/normal-naming-v034/idempotent.json)及[真实重启](../../.work/v03-evidence/normal-naming-v034/restart.json)已生成并通过。

| 证据项 | 本轮结果 |
| --- | --- |
| 0.3.4最终exe | `release/v0.3.4/ACGN-Hub-0.3.4.exe`，25,304,576字节，SHA256 `4CB9F77A28718A0EB307BC49BD3B5F24ACC0B63D74DEC7292FDC76AFD9D592FA`；构建时间08:10:25.376Z |
| NSIS；是否实际安装 | `release/v0.3.4/ACGN-Hub-0.3.4-x64-setup.exe`，7,021,828字节，SHA256 `1114406E109DF155FBD98E98EB08D8FA72D5F0CE27F4C6D9BBBDFBD6D88BA0FA`；未实际安装 |
| 本轮静态扫描 | [v034-naming-final-scan.json](../../.work/security-audit/v034-naming-final-scan.json)，08:10:36–08:10:37Z，exe/NSIS两项退出0、found no threats、无新增检测，防护保持开启；扫描本身不执行程序 |
| 正常窗口身份、Data | 首次运行target/release exe PID26224，08:10:44Z启动；正式发布exe PID40864，08:14:53Z启动，同一SHA256和 `D:\ACGN\release\v0.3.2\Data`，仅UIA、无CDP/远程调试/注入 |
| 任务、关联作品 | `a083f62b-c2f3-43a4-b786-5791216e8e2d`，`bangumi:554779`，下载状态一直为completed |
| 原路径及现路径 | 下方完整路径；sameDirectory=true、oldPathAbsent=true，旧文件名保留在naming记录 |
| 内容一致 | 改名前后均416,074,928字节；SHA256 `429D0C803E3772100CA04D4253D17E13793A161C0DBF035DF670D61E97C6B2FB`，397/397片匹配原种子 |
| 数据库及路径记录 | filename/files/tempPath与新名一致，finalPath保持原null；其余任务字段保持，pendingJournals=0；source_configs10行、media1行、resources1行、local_files0行与在线备份完整一致，integrity_check=ok；mappedLocalIndexRows=0，不声称发生真实索引迁移 |
| 冲突、恢复与重复操作 | 原生局部真实FS/SQL回归覆盖无覆盖与恢复/回滚；真实用户目标同名再次确认后naming/updated_at不变，未制造用户目录冲突或强制中断故障 |
| 正常关闭再启动 | 首次PID26224在08:14:36Z请求WindowPattern.Close并退出；发布PID40864重启后完成状态/原名/现名及`updated_at=2026-10-30T08:10:46.004Z`不变，restart.json通过 |
| 防护与运行观察 | 两次启动均记录Defender及实时防护true；首次08:14:22Z PID26224 alive且events=[]；重启08:16:49Z PID40864 alive且events=[]，后于08:17:11Z正常退出code0；首次进程及较旧0.3.3进程也正常退出，最终未重启用户已关闭的窗口；不推广为长期或所有操作安全结论 |
| 发布与升级入口 | [VERSION.json](../../release/v0.3.4/VERSION.json)和[SHA256SUMS.txt](../../release/v0.3.4/SHA256SUMS.txt)齐全；[桌面快捷方式](../../.work/v03-evidence/normal-naming-v034/desktop-shortcut.json)已切至START-ACGN-0.3.4.cmd并沿用原032Data，旧版产物保持 |

真实原路径（改名后已不存在，保留作为历史记录）：

```text
D:\ACGN\release\v0.3.2\Data\Files\Incoming\[KitaujiSub] Seitokai ni mo Ana wa Aru [01][Uncensored][WebRip][HEVC_AAC][CHS].mp4
```

实际现路径：

```text
D:\ACGN\release\v0.3.2\Data\Files\Incoming\学生会也有洞！ - 第01话 [简中] [HEVC].mp4
```

[verification-final.json](../../.work/v03-evidence/normal-naming-v034/verification-final.json)汇总核对`allChecksPassed=true`：发布4个文件逐一匹配VERSION/SHA256SUMS，数据库完整性及非命名记录保持，0.3.0–0.3.3旧版产物摘要未变。说明中的原生证据标题改为“本次原生桌面验收证据”后重新打包辅助文件并再核对通过，exe/NSIS没有重编译且哈希保持。当前发布exe与媒体内容SHA256另经只读复核一致。[final-runtime.json](../../.work/v03-evidence/normal-naming-v034/final-runtime.json)及[normal-exits.json](../../.work/v03-evidence/normal-naming-v034/normal-exits.json)记录进程正常退出；验收期间不能声称没有旧版实例，曾有较旧0.3.3进程直到08:17:12Z正常关闭，但最终数据库及文件检查没有发现旧值写回。

UI证据：[展开原名](../../.work/v03-evidence/normal-naming-v034/original-name-expanded.png)、[手动名称预览](../../.work/v03-evidence/normal-naming-v034/manual-name-preview.png)、[发布版重启完成页](../../.work/v03-evidence/normal-naming-v034-restart/completed-after-release-restart.png)。首次辅助脚本选错18px helper窗口导致空白截图，随后改为优先选择名称为ACGN Hub的真实窗口；原名summary须执行ExpandCollapse.Expand而不是Invoke。它们只修验收辅助脚本，没有为此重编译应用。

一次同名确认的JSON误用stage=restart，已标`validForRestart:false`并保留在[invalid-restart-label-before-actual-restart.json](../../.work/v03-evidence/normal-naming-v034/invalid-restart-label-before-actual-restart.json)，不计为重启证据。真正重启依据restart.json及前后不同PID、对应launch记录、关闭/启动时序；原0.3.3文件路径已更名，历史记录不回写。

## 发布说明生成检查

`scripts/package-verified-release.ps1` 已将说明更新为本轮命名行为，并在 `VERSION.json` 的releaseScope及completedDownloadNaming字段明确自动范围、保留扩展、冲突不覆盖、原名记录与物理验收边界。未改构建、文件复制、扫描校验或旧版覆盖保护流程。脚本仍全部ASCII，中文说明使用UTF-8 Base64保存；PowerShell静态解析0错误，说明可解码，版本/扫描/原生证据占位符完整。仅做静态检查，没有执行打包。

根目录 `START-ACGN-0.3.4.cmd` 继续读取 `release/v0.3.2/Data`，桌面快捷方式已在真实验收后切换。普通交付目录的 `START-PORTABLE.cmd` 使用该目录自身的Data，两者用途不可混同。

## 构建版本预检补正

首轮0.3.4打包时发现 `src-tauri/tauri.conf.json` 仍为0.3.3，导致产物版本标签错误。该批产物未执行、未扫描、未发布，也未用于升级用户资料库；配置修正为0.3.4后重新完整构建并按上述身份扫描、验收。错误安装包独立保留为 `.work/v03-evidence/normal-naming-v034/mislabeled-first-bundle.exe`。构建缓存中的0.3.3安装包已从原release恢复至历史SHA256 `88160BCDEFE63562F584557A78F927D5BB90F1FAB978F8665A22AAEE80F39E04`，[cache-restoration.json](../../.work/v03-evidence/normal-naming-v034/cache-restoration.json)记录恢复过程，旧发布产物未变。

为防止再次漏改，`src-tauri/scripts/build-desktop.ps1` 在读取工具链或启动编译前，先核对 `package.json`、`tauri.conf.json` 和 `Cargo.toml` 的 `[package]` version；不一致会用英文错误逐一列明三个版本并立即停止。只增加轻量文本/JSON预检，不运行构建或改写版本文件。静态验证结果：PowerShell解析0错误、脚本全部ASCII；真实三个0.3.4值通过，分别只在内存修改package/tauri/Cargo为0.0.0均被拒绝，依赖表的9.9.9版本不会误当包版本。验证仅提取执行该预检函数，没有触发工具链或编译。
