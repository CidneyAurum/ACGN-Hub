# 浏览器端业务验收

使用本机已安装的 Chrome，以独立临时浏览器资料目录和无头模式运行，不读取个人 Chrome 登录态。

```powershell
npm run test:e2e
npx tsc --noEmit -p tests/e2e/tsconfig.json
```

默认自动启动 `127.0.0.1:1420` 的 Vite 开发服务；端口已占用时拒绝复用其他服务。验证生产构建时使用：

```powershell
$env:E2E_PREVIEW = '1'
npm run test:e2e
```

覆盖工作台搜索与查询参数、Bangumi/VNDB 详情收藏、刷新后的作品库、HTTP 下载生命周期、BT 桌面端提示、目录与引擎错误、来源编辑与停用、RSS 人工关联、空态和未知页面恢复，以及损坏设置重建后后台自动轮询完成下载。

`manga-sources.spec.ts` 覆盖 MangaBZ 地址提示、启用状态持久化、封面选择、45 章完整目录与 40+5 分页；同时检查新建及旧版升级后的来源管理、来源类型菜单和漫画选源下拉均不再提供已移除的 WeebCentral/快看，已有 MangaBZ 名称、地址及启用状态保留。刷新后验证已选作品和来源配置仍在，并按稳定作品 ID 直接重新读取章节，不再运行关键词搜索。浏览目录本身不会预先持久化全部资源行，资源记录在加入下载时保存。

仅运行新漫画源浏览器回归：

```powershell
npx playwright test tests/e2e/manga-sources.spec.ts
```

`season-discovery.spec.ts` 使用北京时间和受控时钟，覆盖默认当前季度、24→48→49 条分页、选择往季后打开详情并返回仍保留季度、跨年自动跟随及手动选择不被覆盖；刷新失败时只使用同季度缓存，无缓存的其它季度保留错误和独立周历。季度响应按请求的真实年月窗口生成，普通关键词搜索保持原固定响应。

```powershell
npx playwright test tests/e2e/season-discovery.spec.ts
```

`download-diagnostics.spec.ts` 在固定 RPC 响应中区分获取种子、磁力元数据、等待引擎名额、零节点、传输与校验；验证真实零速、Peer/做种数、校验未完成不显示完成、连接失败和鉴权错误保留原文。另检查未完成的暂停操作不会重复提交，以及切换默认 BT 引擎后已有任务仍归原引擎管理。

```powershell
npx playwright test tests/e2e/download-diagnostics.spec.ts
```

`download-naming.spec.ts` 验证默认开启的完成自动命名开关可保存；已完成 aria2 文件支持建议名称、手动修改和扩展名校验，多文件先逐项选择，缺少关联作品时保留原名，qBittorrent 仅提示由自身改名。还检查原名搜索、命名冲突仍保持下载完成状态。浏览器只允许预览，不会调用真实文件改名。

```powershell
npx playwright test tests/e2e/download-naming.spec.ts
```

所有站外请求都由 `page.route` 提供固定响应；未登记的站外请求会被阻断并使测试失败。测试不会下载真实资源，也不修改真实桌面 SQLite、Token 或媒体文件。浏览器流程不替代原生 IPC、文件系统和桌面数据库验收。

结果位于 `.work/e2e/`：页面截图、HTML 报告、每个场景的 console/pageerror 和模拟网络调用附件；失败时额外保存截图和 trace。
