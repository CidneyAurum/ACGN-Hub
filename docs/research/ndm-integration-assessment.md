# NDM 只读集成评估

核查时间：2026-10-30。只读取官方 `fttawa/NDM` 源码/API；没有下载运行二进制、安装依赖、执行构建脚本或递归获取第三方模块。审查固定于 commit [`c0ca689ba5b789760795bfac5480b24a3d8e3021`](https://github.com/fttawa/NDM/commit/c0ca689ba5b789760795bfac5480b24a3d8e3021)（2026-10-30 04:51:27 UTC，版本0.3.2）。官方文件的本地只读副本见[研究目录](../../.work/ndm-research/)。

## 结论

用户已明确本轮只参考 NDM；不复制其项目代码，不导入安装程序或 helper 二进制。本轮继续独立改进 ACGN 现有下载链路，以下集成分析保留为研究依据。

NDM 是独立的 Windows Tauri 下载管理器，有自写 HTTP/HLS 引擎和 libtorrent BT 内核，并非 aria2 换界面。其 BT 内核的配置、元数据校验、恢复、Peer/Tracker 诊断值得采用类似设计，但现成 NDM 程序不能直接接成 ACGN 的完整下载后端。主要障碍是外部接口不完整、主程序耦合、端口冲突，以及未找到 NDM 自有代码的明确开源许可证。

底层 libtorrent 的 BSD-3-Clause 授权与 NDM 自有 wrapper 的授权是两件事：依赖 notice 没有给整个 NDM 项目授予复用许可。未找到 GPL 声明，也不能据此把项目当作 MIT/Apache 项目复制分发。可以继续研究 libtorrent 官方 API，以独立实现方式接入已有 ACGN DownloadEngine；直接复制 NDM wrapper 或打包其 helper 前应先取得明确授权。

## 架构与能力证据

| 项目 | 官方源码证据 | 对 ACGN 的含义 |
| --- | --- | --- |
| 独立 GUI | [`src-tauri/src/lib.rs`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/src-tauri/src/lib.rs) 的 `run()` 创建 Tauri app/Manager/tray/bridge；内部模块都是私有 `mod`。 | `[lib]` 虽产出 staticlib/cdylib/rlib，但没有面向外部的独立下载SDK。不能简单添加Cargo依赖就复用。 |
| HTTP | [`engine.rs`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/src-tauri/src/engine.rs) 使用 reqwest、多段Range、Content-Range、If-Range/ETag/Last-Modified校验；NoRange退回单连接。 | 可借鉴续传和真实文件身份处理，现有aria2不会被NDM复用。HTTP改动不能自动解决BT无节点。 |
| BT | [`libtorrent.rs`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/src-tauri/src/libtorrent.rs)、[`native/bt/engine.cpp`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/native/bt/engine.cpp) | 独立 `ndm-bt-engine.exe`，静态libtorrent2.1.1，隐藏子进程私有stdin/stdout换行JSON；不用aria2或Python，不开放BT控制TCP端口。 |
| BT 协议 | native inspect支持v1/v2/hybrid，元数据hash/path验证；元数据最长16MiB；取得元数据后上层验证输出路径，再发送start。 | 相比现有aria2不支持纯v2，可扩充协议范围；需要重新实现ACGN任务与安全文件边界适配。 |
| 状态 | helper推送 `metadata/progress/complete/stopped/error`；details含phase、peers、seeds、DHT节点数、分片/文件进度、Tracker状态；checking时不冒充payload速度。 | 能解决现有UI把metadata、waiting、0连接都呈现为“下载中”的可观察性问题。 |
| 可配置联网 | [`bt_config.rs`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/src-tauri/src/bt_config.rs) 的DHT/PEX/LSD/UPnP、Peer上限、上传限速、自定义bootstrap/Tracker、独立SOCKS5。 | 可以改善不同网络下的连接路径与诊断；不等于资源一定有在线Peer。private种子不自动追加公共Tracker，代理失败不回退直连。 |
| 无节点 | helper元数据阶段180秒超时，报 `Magnet metadata timed out; no metadata peer found`；README明确无在线Peer须等待。 | NDM同样不能制造做种者。没有对当前蜜柑条目进行公网对照测试，不能承诺换内核必然提速。 |

## 现成对外接口为何不足

[`bridge.rs`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/src-tauri/src/bridge.rs) 默认监听 `127.0.0.1:16800`，可用 `NDM_BRIDGE_PORT` 覆盖。支持 `GET /ping`、`POST /add`、`POST /batch`，写入使用 `/ping` 返回的启动期 `X-NDM-Token`；允许浏览器扩展Origin或无Origin的本机客户端。

实际限制：

- `/add` 的 `accept()` 明确仅接收HTTP/HTTPS，拒绝magnet；`/batch`同样只筛HTTP链接。
- 没有公开任务列表/状态/暂停/继续/取消/删除API。Tauri `get_tasks`、`pause_tasks`、`bt_details` 仅供NDM自己的WebView调用。
- `Manager::add_tasks()` 仅magnet进入BT分支；HTTP `.torrent` 地址仍是普通HTTP下载，桥接不会自动下载其中payload。原生GUI的本地种子入口先读文件、解析元数据，再转换成带缓存元数据的magnet任务。
- 单实例回调忽略 `_args`，没有可直接传magnet的CLI入口；未发现deep-link注册。
- 桥接默认16800与ACGN内置aria2 RPC端口相同。即使改桥接端口，也仍缺完整任务管理接口。

因此外部桥接最多先提供“把HTTP下载交给另一个NDM应用”的有限功能；它不能满足“在ACGN中管理蜜柑BT下载与进度”的要求。

## Windows 与构建影响

[`README`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/README.md)说明Windows10/11 x64、WebView2；[`release.yml`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/.github/workflows/release.yml)仅Windows runner/NSIS发布。helper使用Win32 HANDLE、PeekNamedPipe、ReadFile，CMake含MSVC专用选项，不是现成跨平台包。

[`build-bt-helper.ps1`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/scripts/build-bt-helper.ps1)要求Visual Studio C++ Build Tools、Windows SDK、CMake/Ninja、Perl/NASM/nmake/git/tar，首次构建静态OpenSSL3.5.9、Boost1.88、固定libtorrent2.1.1 revision及try_signal模块、nlohmann/json3.12。脚本带部分归档SHA256和固定revision；本次只读未执行。本机ACGN实际使用`x86_64-pc-windows-msvc` Rust与MSVC/Windows SDK（`rustc -vV`已核对）；该helper仍会新增CMake等依赖和静态库构建流程，不能按“同为Tauri所以零成本集成”估计。

## 许可证核查边界

官方根目录树未列出LICENSE/COPYING；`/LICENSE`返回404，GitHub repo API `license:null`；Cargo manifest不含license字段，README未声明项目授权。存在的 [`THIRD-PARTY-NOTICES`](https://github.com/fttawa/NDM/blob/c0ca689ba5b789760795bfac5480b24a3d8e3021/src-tauri/licenses/THIRD-PARTY-NOTICES.txt)只覆盖依赖：libtorrent/try_signal BSD-3-Clause，Boost BSL1.0，OpenSSL Apache2.0，nlohmann/json MIT。该核查未发现NDM自有代码GPL义务，也未发现足以允许直接复制分发的项目许可证；应说明“授权未确认”，不能擅自认定GPL、MIT或项目已许可。

## 建议落地顺序

1. 当前aria2链路先修真实阶段/Peer/Tracker/错误与无连接诊断、并发设置同步；用同一蜜柑infohash作真实网络对照，区分可连接性与资源热度。
2. 同时评估独立libtorrent backend，保留现有HTTP/漫画/小说/视频流程；以ACGN的operation registry、固定根目录、取消/重启恢复与SQLite任务模型驱动它。
3. 若要直接采用NDM helper源码或二进制，先确认作者授权，再把私有JSON协议转成ACGN DownloadEngine，保持任务引擎归属，不悄悄迁移正在运行任务。仅公开可复现源码和本机fixture验证尚不能证明当前公网资源性能，需要正常运行与Defender开启状态下的集成验收。
