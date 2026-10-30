# Windows Defender 拦截与组件来源审计

最终补充（2026-10-30）：交付程序为 `1EC07CE74907FD14CE301F02906EF6D18823F27F00CFB37A5F0144231E95608B`，安装包为 `B37C1C04748C99A3ABDCA672E8DEE45FEF67B22B289C4F63B95A3E3E809A73B6`。对应 [高清预览最终扫描](../../.work/security-audit/v030-hd-preview-final-scan.json)两文件均未检出。该程序以PID23660正常运行、读取原完成记录、显示1080p资源并打开本地浏览器视频预览；无CDP/注入，防护开启，观察窗口无新增1116/1117，随后正常退出。MP4预览仅引用已通过路径校验的本地文件，不读取浏览器账号/存储，不改系统文件关联。旧CDP诊断的检测及各旧构建记录仍保留，不据此认定误报。最终证据汇总见[交付审计](../../.work/v03-evidence/hd-delivery-final.json)。

记录日期：2026-10-29。范围是本项目 0.3.0 原生程序及本机已安装的相关工具。本轮在确定拦截原因后停止重复启动被拦截 GUI；没有关闭防护、添加排除、允许威胁或改名规避检测。

## 已确认的拦截

漫画下载测试中的进程退出与 Microsoft-Windows-Windows Defender/Operational 日志逐次对应：事件 **1116** 检测到 `Behavior:Win32/LummaStealer.CER!MTB`，随后事件 **1117** 对同一程序、同一 PID 执行处置，`Action=删除`，状态 `0x00000000`（成功）。目标为本项目 `src-tauri/target/release/acgn-hub.exe`。

| 本机时间（UTC+8） | PID | 对照场景 | Defender 1117 |
| --- | ---: | --- | --- |
| 22:35:26 | 15460 | CDP 直接调用单图下载 | 删除，成功 |
| 22:39:33 | 1464 | 不隐藏窗口，单图下载 | 删除，成功 |
| 22:42:19 | 40932 | 增加原生运行阶段日志 | 删除，成功 |
| 22:43:34 | 46316 | GDB 退出函数断点对照 | 删除，成功 |
| 22:44:57 | 48672 | 脱离命令作业的诊断启动器对照 | 删除，成功 |

安全情报版本为 `1.463.16.0`，引擎版本为 `1.1.26100.4`。脱敏事件保存在 `.work/native-manga-diagnostics/defender-evidence.json`；未复制用户账户、Cookie、Token 或浏览器数据。

原生日志显示单图可以先获得 HTTP 200、读取 221,986 字节并保存成功，之后进程被结束。没有窗口 `CloseRequested`、`Destroyed`、应用 `ExitRequested`、`RunEvent::Exit` 或事件循环返回记录。GDB 在 `ntdll!RtlExitUserProcess`、`NtTerminateProcess` 的本进程断点均未触发。测试脚本的 `browser.close` 调用发生在应用退出之后。这些现象与 Defender 进程外处置一致，不能算作整章下载通过。

纯空闲对照中：无 CDP、无远程调试参数运行 30 秒保持存活；有 CDP 但不下载运行 16 秒也保持存活。**尚未验证完全无 CDP 的正常 UI 点击下载是否触发同一拦截。** 不能据此认定误报，也不能认定正常用户一定不会遇到。

## 组件来源和完整性

### 内置 aria2

从 [aria2 官方 1.37.0 发行页](https://github.com/aria2/aria2/releases/tag/release-1.37.0) 下载 `aria2-1.37.0-win-64bit-build1.zip`，仅在 ZIP 内读取成员并比较字节，**未运行下载归档中的程序**。

- 官方 ZIP SHA256：`67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288`
- 官方 `aria2c.exe` 与本项目嵌入文件逐字节一致，均为 5,649,408 字节。
- EXE SHA256：`be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2`
- 本机 Authenticode 检查为 `NotSigned`。来源一致只证明没有相对该官方归档的改写，不证明版本无漏洞或运行行为不会触发检测。

可复核数据：`.work/security-audit/aria2-integrity.json`。

### Python、yt-dlp 和 ffmpeg

| 组件 | 本机位置/版本 | 核验结果 |
| --- | --- | --- |
| Python | `D:\Develop\Python\python.exe`，3.12.6 | PSF Authenticode 签名有效 |
| py launcher | `C:\Windows\py.exe`，3.12.6 | PSF Authenticode 签名有效 |
| yt-dlp | 已安装 Python 包 2026.7.4；入口 `D:\Develop\Python\Scripts\yt-dlp.exe` | 启动器未签名；已安装 1,049 个代码/资源文件与 [PyPI 对应 wheel](https://pypi.org/project/yt-dlp/2026.7.4/#files) 一致 |
| imageio-ffmpeg | 已安装包 0.6.0；自带 ffmpeg 7.1 | 8 个代码/资源文件与 [PyPI Windows wheel](https://pypi.org/project/imageio-ffmpeg/0.6.0/#files) 一致，ffmpeg 二进制逐字节一致；EXE 未签名 |
| jmcomic / requests | 2.7.4 / 2.32.3 | 已安装文件与各自本机 RECORD 哈希一致；本轮未独立下载官方 wheel 比对这两项 |

yt-dlp wheel SHA256 为 `f11f2b11d5a8ac4059f9bdf29fa4407dc7c6bb00c5097e95ca22a7a9db518266`；imageio-ffmpeg wheel 为 `02fa47c83703c37df6bfe4896aab339013f62bf02c5ebf2dce6da56af04ffc0a`，下载文件均与 PyPI 发布摘要相符。已安装 ffmpeg EXE SHA256 为 `2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3`。

可复核数据：`.work/security-audit/installed-tool-signatures.json`、`python-record-integrity.json`、`python-official-wheel-integrity.json`。本轮只检查文件/包元数据和签名，没有运行新下载的 wheel 内容。

### Cargo 依赖

锁文件含 629 个包：1 个本项目包，628 个来自标准 crates.io registry，没有 Git/path 替代包。625 份本机 `.crate` 归档 SHA256 与 `Cargo.lock` 完全一致，没有发现摘要不匹配；另 3 份未缓存包是 macOS 目标的 `core-foundation`、`system-configuration`、`system-configuration-sys`，不参与本次 Windows 编译。

可复核数据：`.work/security-audit/cargo-integrity.json`。这项核验能发现归档与锁文件不一致，**不等同于完成全部依赖的恶意行为审查或漏洞审计**。逐文件源码对照属于附加核验，不作为阻塞已确认拦截事实的前提。

附加核验随后完成：625 个包的 31,943 个已解包文件与相应 `.crate` 归档逐字节比较，未发现差异；结果为 `.work/security-audit/cargo-source-integrity.json`，耗时 557 秒。该结果排除了本机已解包源码相对这些归档的改写，仍不代替代码行为或漏洞审查。

## 本项目行为边界与未确定项

已检查的 Rust/Python 源码中，未发现主动收集系统浏览器资料、密码、钱包、键盘输入或建立开机持久化的代码。网络请求用于配置的元数据/API、来源图片/内容以及本机下载引擎。漫画图片按来源响应写入自有临时目录，随后生成 CBZ，不执行下载的图片；封面缓存只通过固定哈希标识读取指定缓存目录。

需要透明说明的行为包括：嵌入的 aria2 EXE 释放到运行时目录并作为隐藏子进程运行；可选 Python 桥接脚本写入临时目录并执行；Tauri/WebView2 会创建自己的浏览器资料目录；下载会发起网络请求并写入用户指定目录。这些是实际功能行为，**是否构成此次行为模型的具体触发组合尚未确定**。签名、完整性或来源一致不能把检测直接归为误报。

已在正常功能层面取消浏览首页或保存设置时无条件启动下载引擎：只在用户主动下载 HTTP/BT 或主动测试连接时需要引擎。该调整减少无关背景工作，不代表绕过检测或保证消除告警。进一步透明架构选择可以是用户明确配置已安装工具路径、展示版本/来源/权限、将可选组件安装步骤独立说明；不应通过改名、混淆、关闭防护或排除目录来宣称解决。

## 后续可复验路径与交付限制

1. 保留本报告、匹配 PID 的 Defender 事件、发行物哈希及最小复现场景，用于正常安全软件复核流程；提交外部样本或材料前应由用户决定。
2. 安全审计完成后，如继续一次生产交互验收，采用**正常启动、不设置 WebView2 远程调试、不用 CDP 读取存储**的 UI 点击流程，同时对照 Defender 事件和正常运行日志。这是在验证真实使用差异，不能预设会通过；若再次拦截，应停止重复触发并记录结果。
3. 用户可播放成品可由已经核验来源的独立工具按明确操作取得，但这不能替代本应用的完整验收。

目前不得把被拦截的 App 标记为已可用交付。整章漫画下载/打包、真实下载取消以及防护开启时的正常交互均需取得对应证据后再报告通过。

## 正常功能更新后的文件扫描

23:33:31 生成包含公开投稿桥接、去除无关引擎自动启动等正常功能更新的 0.3.0 EXE，大小 24,498,176 字节，SHA256 为 `5aa70e23439b24cd736a8f86e05a89c63b165bfbaeedad480802f843be9305a4`。23:34:03–23:34:05 使用签名有效的 Microsoft `MpCmdRun.exe -Scan -ScanType 3 -File <该EXE>` 扫描；服务、杀毒及实时保护均开启。扫描返回 0，输出明确为 `found no threats`，该扫描期间没有针对该 EXE 的新增 1116/1117 事件。

此次未执行应用。该结果只说明此文件的本次静态扫描未检出，不表示先前行为告警已撤销、误报已确认或整章下载已经通过。记录保存在 `.work/security-audit/v030-custom-scan.json` 和 `.log`；后续正常 UI 对照需单独记录。

## 后续正常 UI 对照结果

在防护保持开启的新资料库中，后续由普通 Windows UI 点击完成了一次无 CDP、无远程调试、无脚本注入的生产交互对照：搜索《脑洞学生会》，选中对应漫画及 233 章目录，下载第 01 话 17 页。最终 CBZ 大小为 3,957,320 字节，SHA256 为 `4001481cbfccf44e5b1b73f18fdb5e255086a5ffb4ed3a914365a0e12102ecfb`；ZIP CRC 校验和 17 页图片解码均通过。

23:43:19（UTC+8）的观察记录中，PID 53276 保持存活，检测事件列表为空。证据为 `.work/v03-evidence/normal-ui/chapter-verified.json`、`manga-completed.png`、`status.json`。这证明该次正常交互完整通过，与之前受控调试场景的结果不同；**不撤销历史行为告警，也不构成安全软件误报的定论或未来所有运行均无风险的保证**。公开 MP4 的 App 集成及新构建产物仍需各自取得运行证据。

## 最终 0.3.0 构建静态扫描

23:57:22 完成最终源码冻结后的 NSIS 构建，包含共用 AVC/AAC 最高 360p 格式验证、30216 音频优先和限定 MP4/CBZ/TXT 的原生文件打开命令。前端类型检查/构建通过；Rust 全量 37 项通过、1 项外网封面测试显式忽略（此前单独实跑通过），Python 格式边界检查 9 项通过。

| 文件 | 大小（字节） | SHA256 |
| --- | ---: | --- |
| `src-tauri/target/release/acgn-hub.exe` | 24,584,192 | `876aa86a9ecb18a5b9b885e1a901ce891d1472f3fb47ee9b14d5393b4e3e84a8` |
| `src-tauri/target/release/bundle/nsis/ACGN Hub_0.3.0_x64-setup.exe` | 6,846,403 | `32d5b460ae5e6c3a563cd7edce003c124ca7cc9d9deddfb80babe83c89effbc2` |

23:57:42–23:57:47 对两个文件分别运行 Defender 自定义扫描，均返回 0 并明确 `found no threats`，无新增 1116/1117。原始记录为 `.work/security-audit/v030-final-bundle-scan.json`。此次只构建和扫描，未执行 GUI、未实际安装 NSIS、未覆盖旧 `release` 交付目录。静态扫描与后续真实交互验证应分别记录，不以扫描通过替代运行结果。

## 2026-10-30 传输恢复版构建

一次后续正常 UI 的 MP4 传输在约 40% 因 `IncompleteRead` 类错误失败，主进程正常且没有新增 Defender 检测。这属于传输可靠性问题，应与此前进程被安全软件处置区分。

恢复补丁启用同一自有暂存目录中的 `.part` 续传；明确的临时读取/连接错误最多进行 3 次外层恢复，每轮重新提取临时 URL，403/412/429、DRM、格式及目标冲突不进行外层恢复；原生整体时限为 1,800 秒。新增 4 项本地检查通过，包括真实 yt-dlp 在回环 HTTP 上断流后以非零 Range 和刷新 URL 完成的检查；另 9 项格式检查及 Rust 37 项也通过，1 项外网封面测试按约定忽略。这些局部检查不替代公开站点分轨整集传输验收。

00:30:23 生成恢复版 0.3.0，产物仍只保留在 target：

| 文件 | 大小（字节） | SHA256 |
| --- | ---: | --- |
| `src-tauri/target/release/acgn-hub.exe` | 24,588,288 | `a68d22165af939500684e5e0f429cd30722b60aff9a73523c857f33e98a3c2ea` |
| `src-tauri/target/release/bundle/nsis/ACGN Hub_0.3.0_x64-setup.exe` | 6,850,346 | `c8ed03d00defa923d7d04516a55addc4f2b3f1b4f14d7ff7d0a738b916fec48d` |

00:30:42–00:30:52 分别对两个文件自定义扫描，均返回 0、明确 `found no threats`，无新增检测。原始记录另存 `.work/security-audit/v030-recovery-bundle-scan.json` / `.log`，前次扫描记录保持不变。本轮没有启动 GUI、安装 NSIS或覆盖旧交付目录；真实恢复版运行验证由正常 UI 流程另行记录。
