# Galgame 来源筛选与官方免费精选（0.5.3）

核验日期：2026-11-02。当前已经接入真红、ShionLib、KUN 和 VNDB；本轮寻找能够实际增加完整游戏覆盖的来源，不把新站点首页、试玩、补丁或网盘索引数量当作完整游戏下载能力。

网页搜索工具仍返回 503。本轮改用作者官网、平台公开页面、正常匿名下载流程、VNDB 官方接口和公开 GitHub 仓库核对，没有读取浏览器资料，没有登录、付款、解验证码、绕过访问限制或执行下载文件。

## 采用：itch.io 作者官方免费精选

这是一个**有限的官方免费视觉小说精选目录**，不是 itch.io 全站搜索，也不替代真红等来源的商业 Galgame 覆盖。当前严格限定三个已实测的作者及作品，按真实标题、别名、作者官方作品页定位，再刷新该作品当前免费文件列表。

| 作品 | 作者官方页 | 已确认语言范围 | 当前免费完整文件 |
| --- | --- | --- | --- |
| one night, hot springs | [npckc](https://npckc.itch.io/one-night-hot-springs) | 作者页列出简体、繁体中文等多语；不等同于付费合集 A YEAR OF SPRINGS | Windows/Linux ZIP、macOS ZIP、Android APK，当前版本 1.55 |
| 蝴蝶汤 / Butterfly Soup | [Brianna Lei](https://brianna-lei.itch.io/butterfly-soup) | 作者页列出繁体中文等多语；未标成简体中文 | Windows、macOS、Linux 三种 ZIP，当前版本 2.20 |
| missed messages. | [angela he](https://zephyo.itch.io/missed-message) | 当前只确认英文，不添加中文标签 | Windows、macOS、Linux 三种 ZIP |

作品身份另与 VNDB 公开记录核对：`v22619`、`v21875`、`v25774`。VNDB 为《Butterfly Soup》记录了繁体名称“蝴蝶湯”，应用保留该别名及英文名，中文显示名使用“蝴蝶汤”。没有编造另两部作品的官方中文名称。

作者页上可能同时列出捐助奖励、画集或其他付费内容。实际采用的文件来自“免费获取”后真正出现可点击下载按钮的列表，并进一步用当前作品已核验的文件名规则识别完整本体。付费画集、Goodies、Supporter Pack、原声、补丁、试玩和无关文件不会成为游戏本体。

## 正常匿名下载合同

本轮已确认无需账户、付款或任何 Cookie。以下操作与作者页的普通免费获取按钮一致：

1. `GET https://作者.itch.io/作品`，读取公开 JSON 初始化数据，核对作品 ID、slug、`min_price:0` 与 `actual_price:0`。
2. `GET /作品/purchase`。页面明确提供 **“No thanks, just take me to the downloads”**。只接受该普通免费入口，不提交付款表单。
3. 使用页面**实际签发**的匿名 CSRF 值，`POST /作品/download_url`，内容为普通 URL 编码表单，字段仅有 `csrf_token`。
4. 打开源站返回的 `GET /作品/download/{key}`。这里的 key 由平台正常签发，不自行构造、猜测或获取其他账户的 key。
5. 只对该页实际可下载的完整游戏 upload ID，使用页面当前 CSRF 值提交 `POST /作品/file/{uploadId}`。
6. 读取平台返回的临时 HTTPS 文件地址，交给下载器。地址指向真实 CDN 对象，不是 JSON 接口、HTML、商店页或种子。

平台公开脚本 `https://static.itch.io/checkout.min.js` 与 `https://static.itch.io/game.min.js` 中，普通 `direct_download`/`generate_download_url` 流程也是提交源站 CSRF 表单，再接收下载页或文件 URL。本工程独立实现 HTTP 合同，仅解析 JSON/HTML，不执行来源脚本。

一个真实协议细节是：`download/{key}` 的源站 key 带合法百分号编码。本轮生产适配器首次过严的白名单拒绝了它，随后按源站实际格式修复为有界、合法转义的 Base64 样式字符，并覆盖编码 key 与控制字符拒绝回归。没有通过伪造 key 解决问题。

## 真实文件检查

三部作品的 Windows 本体都通过普通匿名流程获得过实际文件地址，并以 64 字节 Range 检查归档类型。

| 作品 / Windows upload | HTTP 结果 | 实际文件总长 | 文件前缀 |
| --- | --- | ---: | --- |
| one night, hot springs / `2436127` | HTTP 206 | 75,910,032 字节 | ZIP `504b0304` |
| Butterfly Soup / `3509369` | HTTP 206 | 188,748,512 字节 | ZIP `504b0304` |
| missed messages. / `1471090` | HTTP 206 | 29,447,313 字节 | ZIP `504b0304` |

平台的 CDN 对象路径可能没有 `.zip` 后缀，真实响应的 `Content-Disposition` 给出了归档文件名。不能把对象路径末尾的数字或 `archive-default` 当作用户可认的文件名，也不能仅凭文件 URL 后缀判断归档类型。

### 完整下载的两份公开免费游戏

为区分“目录可读”“Range 能返回”与“完整文件确实可取得”，本轮还完整下载了两部合理体积的官方免费游戏。下载仅写入隔离审计目录，没有解压落盘或运行。

| 文件 | 完整字节数 | ZIP 完整性 | SHA-256（本机记录） |
| --- | ---: | --- | --- |
| one-night-hot-springs-win-linux.zip，版本 1.55 | 75,910,032 | 2,533 个条目，CRC 全部通过 | `2181c4c1c4de4d356e7612295acac9e18c4e003aa4b3688cb37d5c39ce82c049` |
| missedmessagesWindows.zip | 29,447,313 | 113 个条目，CRC 全部通过 | `a1fbe3c96305354108e7ee7af59a4b628fb267f151726ac1ddb59b0e42d12d5d` |

本机单次文件传输分别约 9.7 秒和 3.5 秒，不构成长期速度、其他地区或所有游戏的下载保证。以上 SHA-256 是本轮实物的本机记录，不是与作者公开校验和比对的结果。

第一份 ZIP 包含 Windows/Linux 启动文件及 Ren'Py 资源归档；第二份包含 Unity Windows 游戏结构。存在程序文件不代表它们已被运行或已验证安全。中文支持依据作者作品页，脚本打在资源归档内，本轮没有不安全反序列化资源索引或逐句核对翻译。

## 实现与时效地址处理

独立适配器为 `src/infrastructure/sources/itch-freeware-source-provider.ts`，来源类型为 `itch_freeware`，默认配置地址 `https://itch.io`。标题/别名搜索只在三部精选作品中定位，随后实际读取作者页；不会把“官方免费”等通用标签写成作品别名。

长期保存的资源地址采用明确的稳定作品定位，例如：

```text
https://npckc.itch.io/one-night-hot-springs?acgn_upload=2436127
```

`acgn_upload` 是应用的稳定文件定位参数，不是平台下载授权。官网原始地址另存于 `metadata.sourceUrl`/`itchGamePage`。资源 ID 带作者、作品和 upload ID，Windows、macOS、Linux、Android 不会因为共享作品页而被去重成一个文件。

资源保留 `downloadMode:direct_file`、`needsFreshDownloadTarget:true`。实际加入引擎前，由下载管理器调用 provider 从稳定身份重新执行普通免费获取，确认当前价格仍为零、该文件仍在免费列表，再领取时效地址；重试也需要刷新，避免把排队前的临时地址当作长期有效链接。

CSRF、临时下载页 key、原始 HTML 和签名地址不会写进作品候选或资源元数据。正常长期记录只保留稳定定位及公开版本信息。文件名保留中文可认的语言与平台，例如：

```text
蝴蝶汤 - 繁体中文 - Windows - v2.20.zip
one night, hot springs - 简繁中文 - Windows-Linux - v1.55.zip
missed messages. - 英文 - Windows.zip
```

### 桌面 HTTP 边界

旧 `feed_text_request` 继续严格只允许 GET，没有为此全局放开 POST。新增专用 `src-tauri/src/itch_freeware.rs` 与 `src/infrastructure/sources/itch-transport.ts`：

- 只接受三个已核验作者及对应作品路径。
- GET 仅允许公开作品页、purchase 页和源站签发的有界 download key 页。
- POST 仅允许 `download_url` 与明确的 `/file/{uploadId}`；表单只有 `csrf_token`，没有付款、reward、Cookie、Authorization 或任意请求头入口。
- 不接收浏览器登录态，不建立 Cookie 存储，不读取个人资料。
- 请求超时最高 30 秒、文本最高 3 MiB；跨出作者白名单的重定向会停止。
- 原生错误信息不输出 CSRF、key、完整签名 URL 或上游私密错误正文。

平台改为收费、移除免费文件、要求账号/验证或更改协议时应明确停止，而不是回退猜测对象地址或使用旧授权。

## 不采用的候选与原因

| 候选 | 实际发现 | 处理 |
| --- | --- | --- |
| Juniper's Knot / Dischan 旧站 | 旧子域 HTTPS 证书不匹配；`dischan.org` 重定向到 `dischan.com` 后没有核实到当前游戏文件合同；GitHub 旧页面有历史相对下载路径 | 不作为已验证可下载的新来源；旧 HTML 的相对链接不能套用 raw.githubusercontent.com 作为实际分发域 |
| her tears were my light | 作者当前桌面版要求至少 3 美元；页面还特别说明部分语言仅存在于网页版 | 不因历史免费印象标成免费桌面本体，也不把网页版繁体标签套到桌面包 |
| Syrup and the Ultimate Sweet | 作者页面可读，但本轮未完成与三个精选相同的桌面免费合同核对 | 暂不加入，避免仅按“Name your own price”把不同文件权限混为一谈 |
| Project Kat | 官方页有完整的独立序章及简繁中文，但它是 Paper Lily 的序章，类型也偏 RPG/解谜 | 本轮不拿它冒充 Paper Lily 完整系列或扩充视觉小说本体数量 |
| TouchGal | 历史核查遇访问挑战，本轮没有新的可用下载证据 | 不重复宣称挑战已解决，仍不作为新增稳定文件源 |

## 测试与生产适配器在线复核

`src/tests/itch-freeware-source-provider.test.ts` 的 **26 项测试通过**，覆盖真实标题/繁体别名、不同作者、免费本体与付费附件分离、平台文件不合并、稳定身份冷恢复、每次重新签发、转为付费停止、无免费按钮停止、错误作品身份、JSON-only 不执行脚本、HTTP/挑战/体积限制、异常 CDN、取消与超时、无 Cookie/账户字段以及健康检查不创建下载授权。

此外，使用 Vite 加载**实际生产适配器**，以普通匿名 HTTP 传输对三个作者复核：

| 查询 | 准确作品数 | 免费完整平台文件 | 新实例冷恢复 Windows 下载地址 |
| --- | ---: | ---: | --- |
| `one night hot springs` | 1 | 3 | 成功 |
| `蝴蝶湯` | 1 | 3 | 成功 |
| `missed messages` | 1 | 3 | 成功 |

共 30 次普通 HTTP 请求全部成功；`provider-live.json` 为 `allPassed:true`。这证明当前适配器可以读取实际作者页面并恢复真实文件地址，不等同于最终桌面二进制已经完成游戏传输、安装或启动。原生编译、下载管理器集成和全量回归由主任务统一记录。

## 隔离证据

证据保存在 Git 忽略目录 `.work/sources-v053/gal/`：

- `initial-pages.json`、`additional-pages.json`：公开站点候选与作者语言、免费/付费、平台声明；历史 HTML 链接不是已验证文件列表。
- `vndb-titles.json`：作品 ID、真实名称与繁体别名核对。
- `itch-normal-contract.json`：one night, hot springs 普通匿名流程、Range、完整包与 CRC。
- `itch-missed-contract.json`：第二位作者 Windows 完整包与 CRC。
- `itch-multi-contract.json`：多个作者的免费可点击 upload、平台、Windows Range 与内容处置文件名。
- `provider-live.json`：实际生产 provider 搜索、九个平台文件和三次冷恢复结果；不保存临时 key/签名。
- `downloads/`：两份未解压、未执行的公开免费归档，仅作为本机审计实物，不纳入源码或发布包。

本轮没有核验所有商业游戏、所有外部网盘、下载程序兼容性或游戏内容质量，也没有把完整 ZIP CRC 通过表述为可运行、安全扫描或每种语言都已进入游戏实测。
