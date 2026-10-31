# v0.3.6 本地漫画阅读器：官方项目参考

研究日期：2026-10-31。范围仅为已下载 CBZ 的阅读方式、缩放、阅读方向、进度和失败恢复；没有引入第三方阅读器、复制实现代码或增加依赖。下列“可落地结论”是根据官方源码作出的工程判断，不代表已经实现全部功能。

本次尝试使用 web 工具搜索及直接打开官方文档/GitHub 页面，均返回 `503 web search is unavailable for this session right now`。随后用 GitHub 官方 REST API 只读访问同一项目的仓库、许可证、提交及文件内容。下面全部为实际读取过的第一手源码链接，并固定本次读取的提交，避免把未能访问的文档写作证据。Komga 的当前官方仓库为 `gotson/komga`；`komga/komga` API 返回 404。

## 已阅读的项目

| 项目 | 本次固定提交 | 实际读取的主要内容 | 仓库声明的许可证 |
| --- | --- | --- | --- |
| [Komga](https://github.com/gotson/komga) | `25c67d14eb748dd3fb9f6612c099959a077fc850` | Vue 分页阅读器、缩放枚举、阅读设置/进度恢复、LTR/RTL 键盘映射 | [MIT](https://github.com/gotson/komga/blob/25c67d14eb748dd3fb9f6612c099959a077fc850/LICENSE) |
| [Kavita](https://github.com/Kareadita/Kavita) | `3c9ddb4a6db7c918a6dba2d5d234a61dd2ed848c` | 漫画阅读组件、独立缩放与方向枚举、章节进度恢复和末页处理 | [GPL-3.0](https://github.com/Kareadita/Kavita/blob/3c9ddb4a6db7c918a6dba2d5d234a61dd2ed848c/LICENSE) |
| [Mihon](https://github.com/mihonapp/mihon) | `e588e04359fe1058206a2cbac1b01018ad787359` | 图片失败页、当前页重试、默认阅读模式与缩放偏好 | [Apache-2.0](https://github.com/mihonapp/mihon/blob/e588e04359fe1058206a2cbac1b01018ad787359/LICENSE) |

## 五条可落地结论

1. **首先把“适合高度/宽度”做可靠，原始尺寸作为独立选项。** Komga 明确区分适应屏幕、宽度、仅缩小到宽度、高度和原始大小；Kavita 也把高度、宽度、原始大小、自动作为不同枚举。两者都没有把图像变换和分页混为一个选项。对本应用，当前高度/宽度切换已经足够完成 CBZ 主流程，后续可在现有设置里增加“原始尺寸”，仍直接使用原图，不进行重编码或另存低分辨率版本；不必立即搬入复杂手势/画布引擎。证据：[Komga 缩放枚举](https://github.com/gotson/komga/blob/25c67d14eb748dd3fb9f6612c099959a077fc850/komga-webui/src/types/enum-reader.ts)、[Komga 对应图像样式](https://github.com/gotson/komga/blob/25c67d14eb748dd3fb9f6612c099959a077fc850/komga-webui/src/components/readers/PagedReader.vue#L205)、[Kavita 缩放枚举](https://github.com/Kareadita/Kavita/blob/3c9ddb4a6db7c918a6dba2d5d234a61dd2ed848c/UI/Web/src/app/_models/preferences/scaling-option.ts)。

2. **阅读方向应改变交互映射，不能倒排 CBZ 的物理页序。** Komga 为 LTR、RTL 和纵向阅读使用明确的快捷键映射，左右移动最终转成逻辑上一页/下一页；Kavita 也把 LTR/RTL 定义为独立方向。对本应用，后续的最小改动是一个“从左向右/从右向左”设置，让箭头键和点击区域共享同一方向函数，页面索引和已读页保持原样。当前版本的上一页/下一页、页码输入与 Home/End 已可使用，尚未提供 RTL/双页模式，不在本轮冒充已完成。证据：[Komga 快捷键映射](https://github.com/gotson/komga/blob/25c67d14eb748dd3fb9f6612c099959a077fc850/komga-webui/src/functions/shortcuts/paged-reader.ts)、[Komga turnLeft/turnRight](https://github.com/gotson/komga/blob/25c67d14eb748dd3fb9f6612c099959a077fc850/komga-webui/src/components/readers/PagedReader.vue#L229)、[Kavita 方向枚举](https://github.com/Kareadita/Kavita/blob/3c9ddb4a6db7c918a6dba2d5d234a61dd2ed848c/UI/Web/src/app/_models/preferences/reading-direction.ts)。

3. **恢复进度必须先确认页数，并明确“末页”和“已读完”的区别。** Komga 在获取实际页列表后才校验跳转页或恢复未完成的进度；Kavita 明确处理 0 起始图片索引、末页和完成标记的边界。这说明页码存储不能直接当成任意数组索引使用。对本应用，当前保留“文件路径 + 大小 + 修改时间 + 类型”的阅读位置键，恢复时限制在实际页数内，并且只在页图成功加载后保存页码，可防止损坏页被误记为读到。未来若加入“已读完”，应单独表示，覆盖单页书和最后一页测试；本轮没有新增完成标记。证据：[Komga 获取页与恢复位置](https://github.com/gotson/komga/blob/25c67d14eb748dd3fb9f6612c099959a077fc850/komga-webui/src/views/DivinaReader.vue#L707)、[Komga 进度写入](https://github.com/gotson/komga/blob/25c67d14eb748dd3fb9f6612c099959a077fc850/komga-webui/src/views/DivinaReader.vue#L902)、[Kavita 进度和末页恢复](https://github.com/Kareadita/Kavita/blob/3c9ddb4a6db7c918a6dba2d5d234a61dd2ed848c/UI/Web/src/app/manga-reader/_components/manga-reader/manga-reader.component.ts#L1160)、[Kavita 末页写入语义](https://github.com/Kareadita/Kavita/blob/3c9ddb4a6db7c918a6dba2d5d234a61dd2ed848c/UI/Web/src/app/manga-reader/_components/manga-reader/manga-reader.component.ts#L1789)。

4. **失败恢复应从当前页开始，重新打开整本作为第二入口。** Mihon 的失败页直接将重试交给这一页所属的加载器，并显示具体错误；只有来源为 HTTP 的图片才提供站外网页入口。对本应用的本地 CBZ，当前“重试这一页”和“重新打开文件”两个入口正好对应局部解码故障与文件移动/改变两类恢复，不应在坏页时重下整章或自动启动浏览器。现有会话关闭、迟到响应丢弃与当前文件归属复核继续保留。证据：[Mihon ReaderPageError](https://github.com/mihonapp/mihon/blob/e588e04359fe1058206a2cbac1b01018ad787359/app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/ReaderPageError.kt)。

5. **预取只覆盖附近页，真实桌面 URL 也必须纳入验收。** Komga 的分页器只把当前位置附近两组页设为 eager load，体现有限预取的做法。对本应用，当前只预取相邻前后页，避免解码整本；离开页面时释放会话和预取引用。另一本轮实际发现、与参考项目无关的问题是 Tauri 的 `convertFileSrc` 会编码整个参数：必须只转换会话 token，再追加真实 `/page/N` 路由分隔符。浏览器替身若不模拟整参数编码，会漏掉真实桌面失败，因此 E2E 已改为准确编码并精确检查图片/视频 URL，仍须完成原生 CBZ 观看验证。证据：[Komga eagerLoad 范围](https://github.com/gotson/komga/blob/25c67d14eb748dd3fb9f6612c099959a077fc850/komga-webui/src/components/readers/PagedReader.vue#L220)；Tauri 部分为本工程本轮实测结论，不归因于 Komga。

## 本轮采用范围

本轮已有单页漫画、宽度/高度适配、键盘与页码跳转、成功页恢复、当前页重试、有限预取与会话清理。根据用户随后给出的明确反馈，另补充默认连续纵向阅读、模式切换及包含工具栏/翻页按钮/页码输入的全屏容器；连续页仅装载当前前后邻页，离远保留尺寸占位。上述补充已经写入实现，正在单独进行自动化与真实桌面验收，本文不代替通过回执。RTL、原始尺寸和双页排版仍是后续选择，不能作为 v0.3.6 已交付能力。没有下载或粘贴上述项目的实现文件；许可证链接用于标明参考来源，不代表已将其代码集成进本工程。
