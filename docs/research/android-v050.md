# Android 0.5.0：构建与验证记录

Android 与 Windows 最终构建、静态检查、原生样本及本地打包已完成，综合清单和桌面入口已更新；仅待 GitHub 上传与附件下载回验。最终 APK 已实际完成 HTTP 暂停 / 冷启动恢复 / 续传、小说第二卷重新下载与内读、前后卷切换和既有漫画页码恢复。本文区分最终产物与此前各阶段，不将旧候选下载冒充最终包重新下载。

## 最终交付身份与原生验证

| 产物 | 字节数 | SHA256 |
| --- | --- | --- |
| Android APK | 54,866,502 | `2F8A9B9D0241561A8ABFBA88010E8EB6F734C551F924729EF02B25EFAC5D6E48` |
| Windows EXE | 25,907,200 | `3C5AF9EBB6B993A5B824FC858BEDEE0FDAF97AFEC081B388D10F8FF89B2A4D24` |
| Windows NSIS | 7,301,383 | `1516002E1E38EA46FC063D35E24C55A609A45F054EB0030AE353A47B9E481F64` |

最终 Android 原始文件为 `.work/android-v050/ACGN-Hub-0.5.0-android-delivery.apk`，回执 `apk-delivery-verification.json`。发布文件名为 `ACGN-Hub-0.5.0-android-64bit.apk`，复制后必须保持上表字节身份。包名 `local.acgnhub.mobile`、versionName 0.5.0、versionCode 5000、minSdk 26 / targetSdk 36；arm64-v8a 与 x86_64 均在包内。v2 / v3 签名、ZIP CRC、16 KiB ZIP 对齐和两种 ELF PT_LOAD 16,384 对齐通过；未发现私有签名材料、用户资料或 Windows 可执行文件。公开证书 SHA256 仍为 `40C95E2A527E537C9DA136667095B982F9402A969953D8F8C0D1A64BE34744A8`。

最终 APK 的原生样本使用独立 API 35 模拟器和普通 ADB / UIAutomator：

- **新建 HTTP 完整流程**：Project Gutenberg `pg10.txt` 约 4.2 MB，限速 64 KiB/s，约 2.3 MB 时暂停，使用 `am force-stop` 结束进程，冷启动后任务仍为暂停，继续传输至完成。实际通过阅读按钮加载正文，并打开 `pg10.txt` 系统选择器后取消，未发送。证据为 `delivery-http-new-progress.xml`、`delivery-http-paused.xml`、`delivery-paused-visible.xml`、`delivery-http-after-resume.xml`、`delivery-completion-actions.xml`、`delivery-http-export.xml` 和 `delivery-http-text-loaded.xml`。
- **小说重新下载与卷间切换**：最终 APK 新下载《文学少女》第二卷，进度 12 / 12，打开内置正文；通过上一卷 / 下一卷实际切换。证据 `delivery-volume2-download.xml`、`delivery-volume2-reader-loaded.xml` / `.png`、`delivery-series-previous.xml`、`delivery-series-next.xml`。最初 `delivery-volume2-reader.png` 只显示加载中，不作为正文已加载的依据。
- **既有进度保持**：第一卷正文恢复第二章与滚动位置，但可见章节选择器仍标第一章，此处仅按实际正文位置描述；已有第 34 话 21 页 CBZ 恢复第 3 页。这些成品来自下方阶段下载，最终包未重新下载漫画。见 `delivery-literary-restored.xml`、`delivery-manga-restored.xml`。
- **系统返回与热恢复**：首页系统返回进入后台后 PID 10317 保留，重新打开无崩溃；见 `delivery-back-background.json` / `.xml`。这不证明系统杀进程后仍在后台下载。

另一个 Gutenberg `pg2600` 文件在此前路径修复阶段完成，最终新建任务使用的是 `pg10.txt`，两次不混记。TXT / CBZ 两种格式选择器和触屏翻页的先前阶段证据保留于下表。未测试向选择器目标真正发送 / 保存文件；最终 APK 只实际打开 `pg10.txt` 选择器并取消。

最终 Windows 回执 `.work/v050-evidence/windows-delivery-native.json` 与扫描 `.work/security-audit/v050-delivery-final.json` 对应上表字节：EXE / NSIS 两项扫描退出 0、未发现威胁、防护开启、无新增事件、扫描前后哈希保持。独立资料库 UIAutomation 读取 4 项既有完成记录；39 页漫画图像可读且恢复第 2 页，小说 7 章可读并恢复第二章 / 章内滚动。没有重新下载既有成品或启动原用户资料库。正常关闭退出 0、进程结束、无新增检测；NSIS 未实际安装。

独立汇总 `.work/v050-evidence/android-delivery-native.json` 已完成，`passedWithinDocumentedScope=true`，核对 25 份 XML、截图、SHA256 及当前进程只读检查。执行 ABI 为 x86_64，arm64-v8a 完成构建和静态校验，未跑实体 ARM64。全局旧崩溃记录含早期候选 PID 的事件，没有据此声称所有候选从未崩溃；最终当前 PID 的崩溃检查无事件。

本地交付已完成：便携 ZIP **9,670,512 字节**，SHA256 `8E504D7C7A0DA396CEE04BC804811D72944D821173E39FA2AA609D3BD4D4490F`，`portable-delivery.json` 记录 12 个白名单成员、CRC / 逐项哈希通过，无用户 Data / 媒体。综合四产物清单和两套校验文件已生成，`USAGE.zh-CN.md` 与便携说明一致。桌面入口已切至 `START-ACGN-0.5.0.cmd`、新版图标，沿用原 `release/v0.3.2/Data` 并备份旧快捷方式。仅剩 GitHub 源码 / 标签与 9 附件上传回验；包内使用指南已冻结，发布后仅补简短回执。

## 阶段构建与原生样本

| 构建阶段 | 文件身份 | 已验证范围 |
| --- | --- | --- |
| Android 成品保存修复 | `ACGN-Hub-0.5.0-android-publish-fixed.apk`，54,878,790 字节；SHA256 `90F7EBE82AC59FBFF6989A7250EE83C3CC821C266F7AFC77876B9A23FD11E92C` | 普通 ADB / UIAutomator 实际下载《文学少女》首卷，进度达到 10 / 10；MangaBZ《葬送的芙莉莲》第 34 话 CBZ 为 21 页，并实际打开全屏长条滚动、按钮翻至第 2 页、触屏滑动翻至第 3 页 |
| Android 系统选择器修复 | `ACGN-Hub-0.5.0-android-share-fixed.apk`，54,878,790 字节；SHA256 `ECDB6E3220A5D08EA78EF9446F15D2FBE08835BE7978D8D1D634EBB834C5B533` | 覆盖升级保留两项已完成任务及阅读进度；TXT / CBZ 均打开系统选择器，取消后未发送。小说横屏与全屏界面已查看，首页按系统返回进入后台后，原进程保留并成功热恢复 |
| Windows 本轮桌面复验 | EXE 25,896,960 字节；SHA256 `6F8270F7B71E8944A8306956C83FF4BA8FBDB2D635F4663E0EB7A39E958D86B5`；NSIS 7,291,816 字节，SHA256 `81A8CCC090C01B35E54C1093BDAE4613F63518A6A856DCD4B6206D22B9C052E5` | UIAutomation 正常程序及正常重启，首页真实封面、4 项已有完成记录、小说第 2 章及章内滚动恢复、漫画 39 页连续阅读并恢复第 2 页；没有重新下载这四项成品 |

Android 两阶段 APK 均有独立静态回执 `apk-publish-fixed-verification.json`、`apk-share-fixed-verification.json`：双 ABI、v2 / v3 签名、CRC、16 KiB 对齐通过，签名身份保持。它们的操作截图及 UIAutomator 快照在本地 `.work/android-v050`，包括 `fixed-manga-page2.png`、`fixed-manga-swipe.xml`、`share-fixed-chooser.xml`、`share-fixed-novel-export.xml`、`share-fixed-landscape.xml` 和 `after-back-reopen.xml`。系统选择器验收只打开并取消，没有实际向其他人或应用发送文件，也不等于已保存到公共下载目录。

Windows 阶段原生回执为 `.work/v050-evidence/windows-release-native-final.json`。虽然文件名带 `final`，它只适用于上表 `6F8270…` 程序；后续最终产物是本文首表 `3C5AF9…`。该阶段两次正常关闭事件循环退出码均为 0，无新增 Defender 检测，NSIS 未实际安装。

原生 HTTP 曾因应用私有目录等价路径被边界检查拒绝，之后修复并取得最终 APK 的 `pg10.txt` 完整独立样本。TXT / CBZ 专用下载和 HTTP 引擎分开验证，不相互替代。

## 修复前 APK 候选的静态身份

下表仅保留 `2026-11-01T15:33:26Z` 生成的 `apk-final-verification.json` 回执所对应候选。虽然本地回执名含 `final`，它仍未通过原生完整下载，不能作为修复后发布包的最终身份。

| 项目 | 结果 |
| --- | --- |
| 校验输入文件名 | `ACGN-Hub-0.5.0-android-final.apk` |
| 大小 | 54,800,966 字节 |
| 文件 SHA256 | `838E5481DDE3DD5AC89A9DDD69EBF1A2C72F9BBEEB8B210F22F21E3A7CB79FCF` |
| 包名 | `local.acgnhub.mobile` |
| 更新身份 | versionName 0.5.0，versionCode 5000 |
| SDK | minSdk 26，targetSdk 36 |
| 原生 ABI | arm64-v8a、x86_64 |
| 签名 | APK Signature Scheme v2 / v3 验证通过 |
| 公开证书 SHA256 | `40C95E2A527E537C9DA136667095B982F9402A969953D8F8C0D1A64BE34744A8` |
| 静态对齐 | APK ZIP 16 KiB 对齐；两种 ELF 的全部 PT_LOAD 对齐均为 16,384 |
| 内容检查 | ZIP CRC 通过；未发现签名材料、用户数据库、下载资料或 Windows 可执行文件 |

原始回执位于本地 `.work/android-v050/apk-final-verification.json`。文件 SHA256 与证书指纹分别用于识别 APK 字节和公开签名身份，不是私钥或口令。下方原生库是该候选 APK 中的实际成员：

| APK 内成员 | ELF machine | 字节数 | SHA256 |
| --- | --- | --- | --- |
| `lib/arm64-v8a/libacgn_hub_lib.so` | 183 | 26,330,072 | `144F2A24282FA4A64E4BBBC7098CBD5882D48E96A1DA0F756E478EAF088AAA86` |
| `lib/x86_64/libacgn_hub_lib.so` | 62 | 25,707,136 | `DA9E8860757222A5783D79557DE60AF0A4B1FBC4D964FEAED035DFFA263F7529` |

上述对齐是静态结构检查，没有据此宣称完成 ARM64 实体手机、全部 API 26+ 系统或 16 KiB 页面设备验收。

后续 `2026-11-01T23:40:36Z` 的 `apk-final2-verification.json` 对应 `ACGN-Hub-0.5.0-android-candidate-final2.apk`，54,796,870 字节、SHA256 `04B8F26CA0AD6ADD21DB4A1BB17E7FBC6A648B92B21A181EDB2796E2FA9F0E2D`，静态签名及对齐同样通过。该候选正常进入作品详情并列出小说分卷，但下载最终发布失败，界面记录为 `novel-download-error.xml`。这些候选不能因包名和版本号相同而互换；修复后的 APK 需另行建立静态和原生运行回执。

## 构建方法与环境

本轮使用 JDK 17、Android SDK Platform 36、NDK 28.2.13676358、Gradle Wrapper 8.14.3、Android Gradle Plugin 8.11.0 与 Kotlin 插件 2.2.21。Windows 主机构建还需要 Rust MSVC 工具链、C++ Build Tools 和 Windows SDK；Android 目标为 `aarch64-linux-android` 与 `x86_64-linux-android`。路径通过 `JAVA_HOME`、`ANDROID_HOME` 和 `NDK_HOME` 提供。

```powershell
npm ci
powershell -NoProfile -File .\src-tauri\scripts\build-android.ps1 -Action info
powershell -NoProfile -File .\src-tauri\scripts\build-android.ps1 -Action build
```

Windows 的 Tauri CLI 在本机构建原生库后，因无符号链接权限而无法将库链接至 JNI 目录。脚本仅识别这一具体失败，随后校验并复制原生库，再由 Gradle 封装 APK。没有为此开启开发者模式、修改全局符号链接权限或系统防护。`.work/android-build/native-libraries.json` 保存复制校验，`-PackageOnly` 仅重新封装这些已校验副本；源码变化后应完整构建。

横屏修复后阶段构建回执 `.work/android-v050/android-build-result.json` 于 `2026-11-01T12:08:24Z` 完成、退出 0。后续各次成品发布与路径修复均重新构建，最终身份以本文首表和 `apk-delivery-verification.json` 为准。旧回执不覆盖新实现；此前符号链接、Kotlin 配置与内存不足失败日志保留，不算通过。

构建使用单 Cargo job、单 Gradle worker 和受限堆内存。浏览器回归、重型构建与模拟器避免同时运行，以减少本机内存不足导致的无报告退出。

签名使用 [sign-android-apk.ps1](../../scripts/sign-android-apk.ps1)，仅传入实际未签名 APK 与输出路径；签名材料保存在被 Git 忽略的独立 `.local/android-signing`，与可清理的 `.work` 构建缓存分开，并需私下备份。后续更新必须保留同一签名身份。脚本执行 ZIP 对齐、v2 / v3 签名及验证，不把口令写进命令输出。

## 静态核验方式

[verify-android-apk.py](../../scripts/verify-android-apk.py) 使用 Android SDK 的 `aapt2`、`apksigner`、`zipalign` 与 Python 标准库：

```powershell
python .\scripts\verify-android-apk.py `
  .\release\v0.5.0\ACGN-Hub-0.5.0-android-64bit.apk `
  --version 0.5.0 --version-code 5000 `
  --receipt .\.work\android-v050\apk-verification.json
```

SDK 路径来自 `ANDROID_HOME`，也可通过 `--sdk` 指定。脚本核对应用身份、SDK 下限和目标版本、签名、ZIP 完整性、64 位 ABI 集合及 ELF 结构，再检查不应进入 APK 的文件名和目录。不读取签名私钥、口令或用户设备数据，也不安装或运行 APK。

## 工程回归与验证边界

最终 `.work/v050-evidence/unit-delivery.json` 为 **65 个文件、670 项通过、0 失败**，`success=true`；`native-delivery.log` 为 **109 通过、2 默认忽略、0 失败**。新增检查覆盖等价私有目录、整理边界、Android 不支持入口及任务可选状态。Windows 主机测试不代替 Android 设备运行。

最近完整浏览器 **91 项全部通过**，`.work/v050-evidence/browser-frozen.json` 的 `expected=91`、`unexpected=0`、`flaky=0`、`skipped=0`，退出 0，包含手机布局与阅读器交互。其后最终单测只补任务可选状态与管理器测试，没有布局变化，未宣称重新跑过最终 670 项对应的整轮浏览器。上一阶段 666 / 669 单测、105 Rust 和浏览器记录分别保留，不相加；类型检查会话 99882 退出 0。固定响应测试不证明真实来源完整可用。

早期完整浏览器运行共 89 项，结果为 **88 通过、1 失败**，保留于 `browser-final.json` 与 `.log`。唯一失败为 844 × 390 横屏菜单遮挡，CSS 修复后定向 **6 项通过**，见 `mobile-landscape-final.json`。这些旧失败与定向修复不合并成一次通过，最终 91 项是后续独立完整运行。

另一次全屏阅读器定向回归 **4 项通过**，见 `.work/v050-evidence/reader-fullscreen-final.json`。该轮只覆盖阅读器相关交互，不增加完整浏览器运行的通过数量。

先前使用 `E2E_PREVIEW` 静态预览时，既有 `/src/...` 原生边界模拟 fixture 无法按开发模块路径工作，该轮已明确中止，保留 `browser-preview-cancelled.json` 和 `browser-preview-incompatible.log`；没有为迁就该测试模式修改应用源码。该轮及此前内存不足中断的执行不计入成功数量。

候选安装启动、早期失败、阶段修复与最终产物分别保留；最终原生样本和文件身份见本文首节。全程只使用独立 API 35 模拟器与普通 ADB / UIAutomator，没有安装到个人手机或读取原有设备资料。Windows 使用 UIAutomation 与独立资料库，没有 CDP 或脚本注入。

Android HTTP 下载属于应用内前台引擎，没有系统后台下载服务。已实现最多 3 个任务、64 GiB 单文件上限，以及重启暂停恢复；实际续传取决于上游 Range / 实体校验条件。原生 HTTP 引擎、漫画 CBZ 生成、小说 TXT 生成是不同流程，不能用一个文件的成功替代另两项验收。

Android 不运行捆绑 Windows aria2、磁力 / Torrent、qBittorrent、Python / JMComic 或 Windows 游戏工具。系统分享通过用户选择器交出完成文件，不自动向任何接收方发送。完整 Galgame 下载、安装运行、所有视频编码、持续后台传输与跨平台资料自动同步均未取得本版原生验收结论。

## Windows 0.5.0 同轮样本与最终待验项

此前 Windows bundle 于 `2026-11-01T12:00:21Z` 成功完成，`.work/v050-evidence/desktop-build-result.json` 退出 0。以下仅为该次候选身份；最终构建、扫描及原生复验已经完成，身份见本文首表，不将本表旧候选哈希当作交付文件：

| 产物 | 字节数 | SHA256 |
| --- | --- | --- |
| EXE | 25,901,568 | `7A4BFD2372B7C91D5A198A49A4B51BD2D15234C819EDB2E31653E045947C9CFB` |
| NSIS setup | 7,301,250 | `4C0124B65AEEA86EBD611E16ABB0A23011E553CB03EC4EAC5D9BEEA04FDF16DB` |

`.work/security-audit/v050-final.json` 记录两项 Defender 扫描退出 0、未发现威胁、防护开启、无新增检测，扫描后文件与扫描前哈希一致。该静态扫描没有安装 NSIS。

独立资料库的正常 Windows UI 已显示真实首页封面，按 LNovel 88 检索《文学少女》，重新生成两卷完整 TXT 并打开内置阅读器；`.work/v050-evidence/windows-novel-outputs.json` 核对首卷 242,459 字节 / 83,192 字符、SHA256 `BBECC758D436BBB17BD23825F8A81A796A49F88C83D65F074F612149091D8ACE`，第二卷 342,612 字节 / 118,813 字符、SHA256 `C03EB70D352FCF9954434A9276F450A55ED85469BEAA468AFCA65378D73D89FA`。两卷与此前完整来源样本一致，本次正常 UI 下载和阅读证据单独保留，没有移用旧版 GUI 结论。

Windows 正常 UI 还完成《葬送的芙莉莲》一话 CBZ 下载及内置阅读。`.work/v050-evidence/windows-comic-outputs.json` 核对 9,357,847 字节、39 页、ZIP CRC 通过，SHA256 `2738AB0F7A1E2851C34D5B2F6ECEA78C517E377B0D6122F55ED5CE24629E9773`；`windows-comic-reader.png` 保存实际阅读界面。首次批量任务在取得样本后主动终止，没有将未下载的其余章节记为完成。

原生正常重启后已打开原有下载记录与小说阅读界面，快照为 `windows-restart-downloads.json`、`windows-reader-restored.json`。全屏交互另有 `windows-reader-fullscreen.json`；这些实际操作与定向浏览器回归分别记录，不将截图本身当作所有交互都已自动断言通过。

本轮 `.work/v050-evidence/data-preservation.json` 最后 `2026-11-02T00:48:32Z` 记录 `allPreserved=true`、数据库完整性 `ok`；9 个数据库表、3 个原媒体和 22 个旧 EXE 与基线保持，不记录私有值，也未沿用旧版结果。

阶段 `6F8270…` 和最终 `3C5AF9…` Windows 程序的正常原生复验分别记录，最终包已通过扫描与样本复验，便携包、综合清单和桌面入口已完成。仅 GitHub 上传与附件实际下载回验待做，不提前写发布完成。0.4.0 证据保持原身份，不移记到本版。公开源码不含本地回执、签名材料或用户媒体；状态见 [VERIFICATION.md](../../VERIFICATION.md)，用法见[使用指南](../releases/v0.5.0-usage.md)。
