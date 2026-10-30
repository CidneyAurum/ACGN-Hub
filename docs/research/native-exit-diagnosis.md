# 漫画下载进程退出诊断

日期：2026-10-29，程序版本 0.3.0。测试仅使用 `.work/native-manga-diagnostics/` 下的新资料库，不读取正常用户资料库，不修改系统安全设置。

## 结论

下载期间的 `exit code 0` 已与 Windows Defender 行为检测及处置事件逐次对应。程序被进程外结束；不能将该结果称为漫画下载完成，也不能仅凭行为告警就断言一定是误报。

Defender Operational 的事件 1116/1117 记录威胁名 `Behavior:Win32/LummaStealer.CER!MTB`，目标进程为本项目 `src-tauri/target/release/acgn-hub.exe`，处置结果为成功。对应 PID 包括 40932、46316、48672；这三次分别是普通直接调用、附加 GDB、脱离 Windows 作业对象的对照运行。脱敏原始事件位于 `.work/native-manga-diagnostics/defender-evidence.json`。

## 对照与排除

| 对照 | 结果 |
| --- | --- |
| 无 CDP、无远程调试参数，空闲 30 秒 | 保持运行，最后由测试脚本定点结束 |
| CDP 连接保持，空闲 16 秒 | 保持运行，`browser.close` 后也未自行退出 |
| 直接调用原生漫画下载一张公开图片 | 可先成功返回 1 页，随后进程退出 0；部分轮次在返回前被结束 |
| 不隐藏窗口，直接调用同一下载 | 同样退出，排除隐藏窗口自身导致 |
| 测试启动器使用 `CREATE_BREAKAWAY_FROM_JOB` | 同样被 Defender 处置，排除普通执行作业的生命周期清理 |
| GDB 附加，断在 `ntdll!RtlExitUserProcess` / `NtTerminateProcess` | 无内部退出断点触发，收到进程正常结束通知，与外部终止相符 |

脚本为 `src-tauri/scripts/diagnose-manga.mjs`，每次单一 Node 进程保持应用子进程及 CDP 连接，记录 `page.close`、`browser.disconnected`、`browser.close` 调用栈和最后的脚本定点终止。各次 `browser.close` 发生在异常退出之后，未把清理动作误判成原因。

## 原生运行日志

新增正常诊断日志 `<profile>/Logs/runtime.log`；未设置便携资料库时位于应用本地数据目录的 `Logs` 子目录。记录启动、主线程/工作线程、窗口关闭请求/销毁、应用退出请求/事件循环返回，以及漫画请求开始、HTTP 状态、字节数、逐页成功和结束。轮转上限 4 MiB，不记录 URL、Cookie、Token 或响应正文。

在 PID 40932 一轮中：主线程为 `main/ThreadId(1)`，漫画开始在 `tokio-rt-worker/ThreadId(35)`，读取及完成在工作线程 34；HTTP 200，读取 221,986 字节，1 页保存成功。随后没有 `CloseRequested`、`Destroyed`、`ExitRequested`、`RunEvent::Exit` 或 `run_return` 返回日志。Defender 在同一时间窗口先记 1116，再记 1117 处置该 PID。

## 当前验收界限

已证明单图请求和落盘可完成，且“下载触发应用退出”的直接机制是安全软件处置。尚未证明整章下载、打包及取消在本机防护保持开启时完整通过。没有关闭实时保护、添加排除、允许威胁、改名规避或更换目录逃避检测。下一步需要继续分析检测触发条件和发行物可信度，并按正常安全软件复核流程处理；诊断日志应保留，以便后续核对。
