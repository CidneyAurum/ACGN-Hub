# Galgame 来源补全与可靠性修复（0.4.0）

本轮继续检查实际的「搜索 → 精确版本 → 文件或原站获取」流程。没有新增一批仅能打开首页的来源，也没有把资源页面标成文件直链。动画和漫画来源没有改动。

## 采用：真红小站原文合集

此前只接入真红的 `shinnku` 目录，忽略了同一搜索结果中的 `galgame0` 原文合集。这会遗漏高清版、旧版、光盘版和部分未汉化作品。本轮按原站的公开路由补全两个目录，不增加新的配置类型。

原站主要依据：

- [官方 URL 映射实现](https://github.com/shinnku-nikaidou/shinnku-com/blob/9beea005e975d2bc801696d2f36a3e9e0c39b2a3/frontend/lib/url.ts)；本轮独立实现路径映射，没有执行来源脚本。
- [搜索结果的目录路由](https://github.com/shinnku-nikaidou/shinnku-com/blob/9beea005e975d2bc801696d2f36a3e9e0c39b2a3/frontend/components/search/AnswerItem.tsx)。
- [虚拟目录根的定义](https://github.com/shinnku-nikaidou/shinnku-com/blob/9beea005e975d2bc801696d2f36a3e9e0c39b2a3/backend/server/src/application/files/services/file_tree_service.rs)。

三个层次的路径有不同含义：

| 用途 | 路径 |
| --- | --- |
| 搜索结果中的文件身份 | `合集系列/浮士德galgame游戏合集/…` |
| 原站文件详情和父目录 | `https://www.shinnku.com/files/galgame0/…`，去掉上面两个虚拟根 |
| 原站公开对象文件 | `https://galgamedownload.date/`，对象路径使用原站规定的字面量前缀 `` `【合集系列】 ``，随后保留合集名称和其余目录 |

逐段 URL 编码保护中文、空格、`+`、`#` 等文件名；仅接受已经核实的合集根。没有猜测对象存储签名，没有调用登录、验证码或链接签发接口。恢复已保存版本时会重新加载准确的文件详情；RAR 和分卷仍会检查同一父目录下的全部必要文件。

2026-10-31 对下面三个版本分别进行了核对：

| 版本 | 目录声明大小 | 详情及父目录 | 文件前 64 字节 |
| --- | ---: | --- | --- |
| CLANNAD HD Edition，Steam 版归档 | 4,226,419,041 字节 | HTTP 200，精确路径存在 | HTTP 206，RAR 魔数，`Content-Range` 总大小一致 |
| ATRI -My Dear Moments-，Steam edition 归档 | 3,913,007,954 字节 | HTTP 200，精确路径存在 | HTTP 206，RAR 魔数，`Content-Range` 总大小一致 |
| Summer Pockets，初回限定光盘版归档 | 6,401,511,065 字节 | HTTP 200，精确路径存在 | HTTP 206，RAR 魔数，`Content-Range` 总大小一致 |

使用应用捆绑的 aria2 1.37.0 和实际的 `ACGN-Hub/0.2` User-Agent 对这三个 URL 分别执行 `--dry-run=true`，均以退出码 0 完成远端 HEAD 检查，返回 `application/x-rar` 和一致的容量；没有写入游戏归档。独立 Range 请求只读取 64 字节，没有下载完整游戏、解压或运行。来源对不同 HTTP 客户端的响应可能不同：Python urllib 的匿名请求曾返回 403；curl 的 Range 请求和上述 aria2 检查成功，不能据此承诺所有客户端都可达。

真实 provider 检查中，CLANNAD、ATRI、Summer Pockets 分别返回 17、4、10 个通过本地标题匹配的版本，其中原文合集分别有 6、1、3 个；从新 provider 实例恢复三个选定合集版本均成功。数量是本次访问时的快照。

原文合集不自动标记为中文，也不由合集名称推断 Windows。缺少明确标记时显示「语言待确认」「平台待确认」，同时保留来源路径、大小和原始文件名。中文 Windows 版继续优先，明确的高清版在同等匹配结果中优先；补丁、试玩、存档和运行工具分别标记。

## 保留并修复现有补充来源

| 来源 | 本轮核验与修复 | 获取边界 |
| --- | --- | --- |
| [Shionlib](https://shionlib.com/) | 修复两字中日韩作品词的局部匹配；防止 `AIR` 命中 `Hair` 这样的嵌入片段。实测「水仙」可返回水仙、水仙 2、姬子终章等独立条目；选择准确的「水仙」可读取资源清单。「AIR」「ATRI」也完成准确作品的资源查询 | 仍为原站资源详情页，需在来源完成 Cap 验证；没有提取隐藏链接或伪装为直链 |
| [鲲 Galgame](https://www.kungal.com/) | 名称分别匹配，不拼接两个别名产生虚构命中；短英文名校验字母/数字边界。修复再次搜索会清空此前资源句柄的问题；修复原生请求或 JSON 解析不返回时超时无法结束等待的问题 | 公开资源索引，网盘或其他文件入口仍在原站确认；不调用增加下载计数的接口 |
| [VNDB 发行目录](https://api.vndb.org/kana#post-vn) | `v20424` 和规范的 `https://vndb.org/v20424` 直接按作品 ID 查询，不再把 ID 当标题做全文搜索。实测 Summer Pockets 的规范 URL 返回唯一正确作品 | 官方发行、免费版和试玩的官网/商店入口；不将商店网页当作游戏文件 |

Shionlib 和鲲的请求增加可选调用方取消信号；请求和响应体都受超时/取消约束。取消不会被误报成超时；多个别名中单个来源请求失败时，仍保留成功的匹配结果。

Shionlib 的协议依据为[其公开 OpenAPI](https://github.com/Ringyuki/shionlib/blob/d38d11f78c40175aee5a0899130242b2359bf572/apps/api/openapi/openapi.json)；鲲使用[其公开 v1 接口](https://github.com/KunMoe/kun-galgame-forum/tree/366ba32457b83fc8d30fd83107ceec7b2b366326/apps/api/internal/search/apiv1)。

## 没有作为游戏本体来源加入的入口

[NekoNyan 官网](https://nekonyansoft.com/)确实链接到[官方补丁门户](https://patches.nekonyansoft.com/)。公开页面目前列出 Steam 内容补丁及版本更新补丁，不能替代完整游戏。它没有作为新的本体直链来源加入，避免用补丁数量制造资源覆盖的假象。Katawa Shoujo 官网本次普通匿名请求仍落入访问检查，没有尝试绕过，也没有宣称已经取得其正式文件。

## 本地验证记录与限制

定向测试命令：

```text
npx vitest run src/tests/shinnku-source-provider.test.ts src/tests/shionlib-source-provider.test.ts src/tests/kungal-source-provider.test.ts src/tests/vndb-release-source-provider.test.ts --maxWorkers=1
```

本轮 4 个文件、141 项测试通过，覆盖目录恢复、两个存储映射、分卷、语言边界、短标题、独立别名、取消和超时、旧句柄保留、VNDB 精确 ID。

忽略目录 `.work/gal-v040/` 保存：

- `shinnku-live.json`：真实搜索返回的公开目录与初步 Range 元数据。
- `original-verified.json`：准确文件详情、父目录及 Python 客户端的访问差异。
- `original-prefix-verified.json`：三个 64 字节 Range 响应、RAR 魔数和容量。
- `engine-dry-run.json`、`aria2-dry-run-*.log`：捆绑引擎的实际 HEAD 检查；日志中的「download completed」是 aria2 对 dry-run 的固定描述，不能当作完整游戏下载证据。
- `provider-live.json`：17 次匿名目录请求，覆盖三个真红合集冷恢复、Shionlib 三个查询及资源、鲲 AIR 查询、VNDB 精确 ID。

没有完成大体积游戏包的完整下载、校验、解压、安装、兼容性或游戏启动测试。未核验所有文件的语言、完整性、第三方发布权限和长期可用性；来源哈希、原站有效状态或一次 HEAD 成功均不能替代这些结论。
