# 0.5.1：下载、阅读与旧 WebView 修复

当前为**本地验收完成，待 GitHub 发布回验**。确定缺陷复现、源码修复和完整自动回归取得独立证据；便携包、综合清单、桌面入口和原用户资料保留均已完成。0.5.0 的发布身份保持，不移记为本版通过。

## 最终构建与原生范围

| 产物 | 字节数 | SHA256 |
| --- | --- | --- |
| Android APK | 54,977,094 | `119035B60D558102E342D103A6B6302BBA6A28EA3124F37357DC6E7A018F87A9` |
| Windows EXE | 25,972,224 | `FDDF5A077F1CF1F242D360DC8A317FE19811C2273336482F57A3233FDA799A0A` |
| Windows NSIS | 7,315,624 | `98F375449D5DA6A3AFCCAE8603013F0AF93E5EDA2C04CE24CEB640E66C23FE39` |

Android `.work/android-v051/apk-verification.json` 核对包名 `local.acgnhub.mobile`、versionName 0.5.1 / versionCode 5001、minSdk 26 / targetSdk 36、arm64-v8a + x86_64。v2 / v3 签名、CRC、16 KiB ZIP / ELF 对齐通过，证书保持 `40C95E2A527E537C9DA136667095B982F9402A969953D8F8C0D1A64BE34744A8`，无用户数据、私钥或 Windows 可执行文件。

独立 API 35、x86_64 模拟器以覆盖安装从 0.5.0 升级，14 个来源 / 其中 1 个启用的状态保留。最终 APK 实际读取蜜柑 RSS 并显示 100 项，真实 httpbin 403 显示具体 HTTP 状态；浏览器检查按钮确实被点击并启动外部浏览器，但浏览器 XML 没有正文，未宣称页面加载成功。新建 Project Gutenberg `pg11.txt` HTTP 完成 **170.2 KB / 170.2 KB**，正文《Alice's Adventures in Wonderland》实际内读、全屏和旋转后仍可读，系统选择器打开后取消无发送。横屏截图保留侧转状态，不将内容可读描述成独立布局尺寸验收。蜜柑成功只适用于本机模拟器透明出口，不外推朋友的 5G。

Windows `.work/v051-evidence/windows-native.json` 对应表中最终文件：构建退出 0，EXE / NSIS 扫描通过、无新增检测，UIAutomation 读取隔离旧资料库 4 条完成记录、39 页漫画第 2 页及小说第二章 / 滚动位置；TXT 与 CBZ 均进入 / 退出全屏，正常关闭退出 0，无 CDP / 注入。未重下成品、未启动原用户资料库，NSIS 未实际安装。本次真实样本不是短末章 fixture，短末章修复仍按浏览器回归范围记录。

最终 Android 汇总 `.work/v051-evidence/android-native.json` 为 `passedWithinDocumentedScope=true`，19 份证据按 XML、截图与最终 APK 哈希独立核对；最终 PID 4189 返回桌面后保留、HOT 重开，保留的崩溃缓冲没有该 PID 崩溃。该模拟器不是旧 WebView，旧 API 缺失由自动回归验证；实体设备、ARM64 实机及反馈 5G 未测。

本地便携 ZIP **9,689,891 字节**，SHA256 `63FE6156A89C89F8561940E110BBD8277C9A6B0D0454FB7F5DCC4A398C22C0C5`；12 白名单成员 CRC / 哈希通过。四产物综合清单、两套校验已齐，桌面0.5.1入口沿用旧Data、备份旧快捷方式。`data-preservation.json` 于 `2026-11-02T03:05:00Z` 为 passed：9表、3媒体、24旧EXE（含0.5.0）保持，数据库完整性ok。使用指南已打包冻结，剩源码 / 标签推送、9发布附件上传与实际下载回验。

## 已复现的问题与修复

| 流程 | 失败复现 | 修复与已通过范围 |
| --- | --- | --- |
| 成功 HTTP 后元数据 / 来源失败 | 将 `structuredClone` 设为缺失，成功响应随后在 `MemoryCache.set` 抛 TypeError；作者检索同样失败，浏览器作品详情不能加载角色 | 明确元数据克隆 helper，现代环境优先原生；旧环境只复制普通 JSON / optional undefined，隔离嵌套修改，不静默转换 Date / 循环对象。Bangumi / VNDB、RSS / 蜜柑和 LNovel 等共享缓存调用均核对为普通数据 |
| 旧 WebView 的请求 / 历史功能 | API 直接调用依赖 `AbortSignal.timeout/any/throwIfAborted`、`Object.hasOwn`、`Array.at`；旧引擎可在请求或反序列化阶段失败 | 提供局部请求取消 / 超时 fallback，清理自身计时器与监听，保留取消原因；消除生产 `.at()`、`Object.hasOwn()` 硬依赖。任务诊断和命名仍按白名单读取，未知 JSON 键不能覆盖任务身份 |
| 阅读目录和末页 | 短末章已在视口且滚到底，目录被顶部 75px 标记回退到前章；短横向漫画末页已可见但页码变成前页，阻断接续 | 在真实滚到底且末尾可见时识别末章 / 末页，保存正确进度；新增失败前 trace 和修复后的完整阅读器场景 |
| 全屏 / 旋转进度 | 小说末章进入全屏后容器高度改变，scrollTop 被钳制，退出和重开会丢失原位置 | 按会话保存阅读比例，ResizeObserver 恢复视口变化，过渡期不保存被截断的新位置；覆盖浏览器全屏、WebView 回退、系统退出 / Escape、横竖屏 |
| Android HTTP 与完成边界 | 响应范围 / 声明长度不一致、实体标识变化与发布恢复存在独立边界；任务最后写入后暂停 / 取消可能覆盖已完成结果 | 增强 Content-Range、ETag 与实际长度核验，恢复发布阶段并校验成品归属；下载管理器对已完成操作保留状态，后续刷新完成、不移除成品 |
| 网络诊断与来源检查 | 通用连接失败混淆 DNS / TLS；慢检查返回时可能覆盖其间停用或地址修改 | 原生根据错误链分出可确认类别，界面不显示私有 URL；普通浏览器信息不足时保留通用失败。来源检查只合并同地址的健康结果，保留启用状态；地址已改变则忽略旧结果 |

生产构建目标调整为 Chrome 87，用于覆盖较旧语法支持；这不能替代旧 WebView 实体运行验证。无全局 API polyfill，不放宽下载文件归属、来源身份或目录边界。

## 测试红绿与现有证据

- **元数据兼容失败前**：新增两项单测在成功响应后分别以 `TypeError: structuredClone is not a function` 失败；浏览器打开详情后角色区域缺失，trace 位于本地 `.work/legacy-webview/before-cache-fix`。
- **兼容修复后**：9 文件 / 154 项相关单测及类型检查通过。浏览器同时删除 `structuredClone`、`Object.hasOwn`、`Array.at`、AbortSignal 三种新方法，2 项通过，覆盖首页封面 → 详情角色 → 漫画来源章节，以及 LNovel 作者返回作品 → 两卷 → 返回后缓存复用；`.work/legacy-webview/final-results.json` 为 2 通过、0 失败 / 跳过 / flaky。
- **阅读器失败前**：`.work/reader-audit/short-final-before` 保存短末章预期第二章、实际第一章的失败；`end-pages` 保存漫画末页预期页 3、实际页 2；`end-pages-fixed` 保存加入全屏后重开末章不在视口的失败。
- **阅读器修复后**：完整 19 项浏览器通过，`.work/reader-audit/final-results.json` 为 19 通过、0 失败 / 跳过 / flaky。覆盖位置恢复、短末页、两种全屏、取消接续、重开时无用户阅读不自动跳转，真实再阅读到底才接续。固定本地响应测试不等于 Android / Windows 最终程序已实测。
- **来源检查**：`.work/v051-evidence/source-management-fixed.json` 为 3 项通过，包含慢检查期间停用和改地址；首次测试失败与后续修正分别保留，不把测试控件定位修正误写成产品修复。
- **本版完整源码回归**：`unit-final.json` 为 68 个唯一文件 / 714 项通过、0 失败，退出 0；`native-tests.log` 为 118 通过 / 2 默认忽略 / 0 失败。完整浏览器 `browser-final.json` 为 99 / 99 通过、退出 0，包含本轮兼容、阅读和来源检查场景。最终文件身份和原生验收取得后另补，不把固定响应自动化写成实体机通过。

回执均在本地 `.work`，不随公开源码上传。新 helper 的循环 / Date 拒绝是旧环境范围限定；有原生 `structuredClone` 时保留原有语义，缓存并未改用 JSON stringify 丢失 undefined。

## 手机蜜柑反馈的诊断边界

已知反馈是手机蜜柑来源访问失败，尚无设备型号、Android / WebView 版本或手机浏览器公开地址结果。已证明旧 API 缺失可以让网络响应成功后功能仍失败，并修复这一类确定缺陷；**不能据此认定就是反馈手机的根因，也不能写成实体手机已经修复**。

本机 Windows 在透明路由 / 代理环境中对来源取得 HTTP 200，只能证明当时这台机器的路线可达；`198.18.*` 类地址结果不能外推到手机运营商 5G 或 Wi-Fi。DNS、TLS、连接、读取、HTTP 拒绝和 JS 兼容分别记录，不把一个成功请求扩展为全网可用率。普通浏览器被 CORS 拒绝时往往只给 `Failed to fetch`，不能凭文字猜出网络层根因。

手机排查建议见[使用指南](../releases/v0.5.1-usage.md)：公开主页 / RSS 的手机浏览器结果、网络类型、设备及 WebView 版本和应用错误原文即可，不需要 Cookie、Token 或私有订阅。最终实体设备、所有厂商 WebView、后台下载、所有来源和完整 Galgame 运行均未取得本版验收结论。
