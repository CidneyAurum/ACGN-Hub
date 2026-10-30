# ACGN Hub：从后台页面转向番剧追踪界面的参考研究

研究日期：2026-10-29。方向已经由用户确定：**番剧追踪风，封面墙、角色感、精致轻盈；只使用真实作品封面和元数据，不使用 AI 角色、AI 图片或字方块装饰。** 本次只研究官方仓库、README、官网截图和相关实现；截图用于本地设计研究，未将第三方代码或美术并入应用。

## 1. 参考来源与实看素材

| 产品 | 官方来源 | 已下载并实际查看的截图 | 适用范围 |
| --- | --- | --- | --- |
| Animeko | [仓库及 README](https://github.com/open-ani/animeko)、[官网](https://animeko.org/) | [桌面首页](assets/animeko-pc-home.png)、[桌面搜索](assets/animeko-pc-search.png)、[分栏详情](assets/animeko-pc-detail.png)、[资源选择](assets/animeko-resource-selector.png)、[追番库](assets/animeko-collection.png)、[缓存管理](assets/animeko-downloads.png) | 本项目最主要参考：番剧信息、追踪、资源和缓存的完整关系 |
| BangumiN | [仓库](https://github.com/edwardez/BangumiN)、[官网](https://bangumin.github.io/) | [官方落地页预览](assets/bangumin-landing.png) | 轻盈白底、粉色点缀、人物头像与作品信息的比例；移动端样式不能直接放大成桌面 |
| Mihon | [仓库](https://github.com/mihonapp/mihon)、[官网](https://mihon.app/) | [浅色书库](assets/mihon-phone-light.webp)、[深色书库](assets/mihon-phone-dark.webp) | 漫画／小说书架：封面是主要入口，状态只是角标 |
| Miru | [仓库](https://github.com/miru-project/miru-app)、[官网](https://miru.js.org/) | [官方多端总览](assets/miru-overview.webp) | 多内容类型、多来源检索；来源分组可以解释资源来自哪里 |
| Vnite | [仓库](https://github.com/ximu3/vnite)、[官网](https://vnite.ximu.dev/) | [浅色游戏详情](assets/vnite-light.png) | 游戏详情的真实作品背景、封面、启动按钮层级；不是本轮首页与导航的主方向 |

所有截图直接来自官方 README 链接或官网：Animeko `.readme/images/features/`；Miru `assets/screenshot/screenshot.webp`；Mihon 官网 `/home/phone.light.webp`、`/home/phone.dark.webp`；BangumiN `/assets/images/showcase/landing.png`；Vnite README 所引 `https://img.timero.xyz/i/2025/07/31/688b0d5d5511e.png`。它们展示的是各项目文档发布时的界面，不据此声称与当前发布版每一处细节相同。

## 2. 实看结论

### Animeko：围绕“我在追什么”，而不是围绕工具模块

![Animeko 桌面首页](assets/animeko-pc-home.png)

首页左侧只有少量高频导航，内容区首先出现横向作品图，然后是“继续观看”的竖海报。首屏绝大部分有效面积由真实作品占据。按钮和辅助文字附着在作品上：用户看到的单位是番剧，下一步是继续某一集。截图是深色主题，但真正值得借鉴的是内容层级和操作位置；本项目应按用户偏好改为浅白、浅紫灰和少量珊瑚粉。

![Animeko 搜索](assets/animeko-pc-search.png)

搜索首先是一条可见输入框和紧凑筛选，其下即是六列封面。封面下方／底部仅放作品名，信息不分割成很多白卡。搜索结果可以切换成左列表右详情：选中作品后，搜索上下文仍留在左边，右侧立即给出大封面、评分、追番状态和简介。

![Animeko 分栏详情](assets/animeko-pc-detail.png)

详情的顺序是“这是什么作品 → 是否值得看／我看到哪 → 立刻行动 → 更多资料”。角色头像、标题、评分属于同一内容世界，用户无需先穿过外部 ID、原始 JSON 或来源配置。资源选择另开面板：明确“已查询多少来源”“有哪些结果”“当前筛选掉了多少”，能把无结果与查询失败区分开。

![Animeko 追番库](assets/animeko-collection.png)

追番库用“想看／在看／搁置／看完”等状态组织，并把进度和“继续下一集”放在作品旁边。下载／缓存按作品分组，再展开单集，不用原始 URL 作为主要标题。

### Mihon：封面就是交互主体

![Mihon 浅色书库](assets/mihon-phone-light.webp)

浅色书库几乎没有独立的说明卡、统计卡；一屏即可看到多个可辨认的书封。标题覆在封面底部，未读数量是小角标，筛选／搜索是顶栏动作。可以学习紧凑的封面密度与稳定比例，但本项目桌面版需要更宽松的列距和键盘焦点。

### Miru：多内容、多来源也可以是内容页面

![Miru 官方多端总览](assets/miru-overview.webp)

Miru 把“影视／漫画／小说”放为同页小筛选，结果按来源横向分组，每组仍是封面。来源是结果解释，而不是让用户先填完管理表单才能看到内容。适合本项目“同页选择适用来源、确认后启用并检索”的改造。

### Vnite 与 BangumiN：各取适用部分

Vnite 的浅色详情使用真实作品横幅、渐变过渡、右侧封面以及明确的启动按钮。视觉角色感来自作品原画，适合游戏／作品详情，不必为“二次元感”额外造一个人物。BangumiN 的官网预览证明白底也能有鲜明的 Bangumi 气质：粉色品牌、小头像、作品状态和轻分隔线；但其动态社交流不是本地下载工具必须照搬的首页。

## 3. 源码核对：图片与详情为什么不能互相阻塞

仅下载和阅读，未复制代码进 `src`。参考文件保存于 `.work/references/`。

| 官方实现 | 实际观察 | ACGN Hub 应自己实现的行为 |
| --- | --- | --- |
| [Animeko SubjectCoverCard](https://github.com/open-ani/animeko/blob/main/app/shared/ui-foundation/src/commonMain/kotlin/ui/subject/SubjectCoverCard.kt) | 封面本体处在可点击 Surface 内；固定海报比例与 placeholder 分支 | **封面、标题和卡片主体均能打开详情**，收藏按钮独立且不能遮挡导航；键盘同样可达 |
| [Animeko NavRoutes](https://github.com/open-ani/animeko/blob/main/app/shared/app-platform/src/commonMain/kotlin/navigation/NavRoutes.kt) | 详情路由保存稳定 `subjectId`，可选轻量 `SubjectDetailPlaceholder` 带名称、中文名、封面 | 点击时用已存在的搜索候选立刻显示首屏；URL 是稳定身份，不能仅依赖一次性列表状态 |
| [Animeko SubjectDetailsViewModel](https://github.com/open-ani/animeko/blob/main/app/shared/ui-subject/src/commonMain/kotlin/ui/subject/details/SubjectDetailsViewModel.kt) | subjectId 与 placeholder 进入独立 state loader，load/reload 分离 | 详情基本资料、角色资料、库状态、资源检索分别加载，任何一个失败不抹掉整页 |
| [Animeko AsyncImage](https://github.com/open-ani/animeko/blob/main/app/shared/ui-foundation/src/commonMain/kotlin/ui/foundation/AsyncImage.kt) | 单独 loading/success/error 状态、placeholder/error/fallback、按显示尺寸请求、可选淡入与缓存 | 统一海报组件，固定尺寸防跳动，加载失败显示可读标题与重试，不显示坏图标或无限空白；桌面代理可作为传输增强，不把内容身份绑到图片请求 |
| [BangumiN SubjectSearchResultWidget](https://github.com/edwardez/BangumiN/blob/develop/app/lib/widgets/search/SubjectSearchResultWidget.dart) | 整个结果是 InkWell，携带 subject ID 点击导航 | 搜索页不应只剩一个很小的“详情”文字链接能点 |
| [BangumiN CachedRoundedCover](https://github.com/edwardez/BangumiN/blob/develop/app/lib/widgets/shared/cover/CachedRoundedCover.dart) | 海报独立组件，使用缓存图片与固定尺寸 | 一致的作品海报基础组件；其旧实现的透明缺图处理过弱，不应照搬成空白 |

许可证核对：Animeko、Miru 为 AGPL-3.0；Vnite 为 GPL-3.0；Mihon 为 Apache-2.0；BangumiN 为 MIT。本研究提炼交互与布局，应用代码自行实现；截图不作为本产品自有图像分发。

## 4. 0.2 为什么仍像后台

1. 首页重心是口号、配置入口、计数和流程指南，作品封面要等收藏后才出现，真实内容在首屏几乎缺席。即使颜色变浅，也只是在给管理后台换主题。
2. 侧栏把来源、订阅、下载、整理、漫画工具、游戏工具等实现模块平铺；用户先面对系统结构，尚未进入一部番剧。
3. 每块内容都套白卡、边框、说明文字，首屏密度分给了容器，标题、封面和角色反而不突出。
4. 搜索海报与标题没有真实点击导航，只有很小的“查看详情”可点。视觉上看起来是作品卡，行为却不像作品卡，这直接造成“搜到也进不去”。
5. 元数据、SQLite 收藏状态和图片加载的等待关系过紧。慢／损坏的本地库可能挡住本已有的搜索候选；补充角色失败不应该让基本详情消失。
6. 来源全部停用后，资源检索依赖跨页配置，用户在作品详情只看到“没有资源”。未启用、来源超时、关键词无匹配和文件失效并非同一个状态。
7. 下载主要按任务 UUID、URL、引擎名呈现；从作品详情跳来时，用户失去了“这是谁的第几集”这个上下文。

以上视觉诊断是对界面和实现的观察；不是已复现所有运行故障的根因结论。图片、详情、资源、下载的实际故障仍需在真实桌面版逐条复现。

## 5. 可落地的本轮设计

### 导航与首页

主导航收敛成“发现／追番库／下载”，更多工具进入次级入口，设置留在底部。首页开场直接显示真实番剧：有收藏时优先“继续追番”，没有收藏时展示来自已验证元数据的发现内容和搜索框。不要使用固定假番单、虚假播放按钮、AI 看板娘或字块占位。暂缺真实数据时用简短、明确且可操作的空态。

### 搜索

顶栏统一大搜索框；动画／漫画／小说／Galgame 是轻量分段，不再是表单字段。结果 5～7 列，竖海报比例约 2:3，间距 18～24px，标题最多两行，年份／评分至多一行。主卡不放长简介。封面与标题构成真实导航，角落收藏按钮独立。搜索失败可以保留已载入结果，清楚显示补充失败。

### 作品详情

首屏使用真实封面虚化形成浅色横幅，下方是 180～220px 海报、作品名、短别名、评分／年份／类型、收藏／追番状态和一个明确资源 CTA。简介只显示有限行，角色以头像横条出现。扩展 ID 和开发信息折叠到末端。图片或角色缺失时，标题、路由、收藏和资源 CTA 继续可用。

点击“查找资源”后同页显示适用来源。已配置来源直接查；未启用来源需一次明确的“启用并搜索”，不静默启用，也不踢到另一个管理页。列表显示每个来源的查询阶段和结果数量，区分“尚未查询／未启用／查询失败／无匹配”。资源行用字幕组、清晰度、语言、体积和来源帮助判断，原始协议与地址进入次级信息。

### 追番库

海报墙为主，有状态能力后使用“全部／想看／在看／看完”分段。当前只有收藏字段的版本先提供真实收藏，不绘制假的观看进度。扫描本地文件、哈希和整理按钮折叠到“本地文件”区，避免盖住作品墙。

### 下载

作品海报缩略图＋作品名作为任务组，集数／资源名作为子项；保留真实速度、剩余时间与进度。失败组给清楚重试动作和具体错误。RPC、引擎端点、清理路径只在需要排障时展开。下载能力不可用时提供本页连接修复入口，而不是用“就绪”标签遮住失败。

### 视觉约束

- 底色浅白与浅紫灰，重点使用珊瑚粉 `#fb7299` 或偏紫 `#8b7cf8`，不要同时铺满两种强色。
- 圆角以 14～18px 为主，海报边缘保持干净；阴影轻，减少三层套卡。
- 作品本身提供丰富色彩；全局 UI 退后。角色感来自真实作品／角色图片，图片没有授权或数据时就不添加。
- 鼠标 hover 轻微抬升并显示动作，focus-visible 同等清晰；reduced-motion 下关闭非必要动效。

## 6. 本轮验收必须以用户路径结束

必须在真实桌面程序中完成：打开→真实封面出现→搜索真实作品→点击封面→详情首屏立即出现→同页启用合适来源→资源有结果或明确失败→确认下载→任务进入真实引擎→能暂停／取消／重试。测试不能只证明 DOM 存在或小链接能点击。界面研究不能替代这条可用性闭环。
