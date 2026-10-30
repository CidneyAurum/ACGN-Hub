# 原生网络与封面加载研究

记录时间：2026-10-29。本轮针对 0.2.0 用户反馈的封面、详情及资源访问问题；公开接口探测不使用账号、Token 或 Cookie。

## 成熟项目的处理方式

- [Mihon NetworkHelper](https://github.com/mihonapp/mihon/blob/main/core/common/src/main/kotlin/eu/kanade/tachiyomi/network/NetworkHelper.kt)：统一 OkHttp 客户端，连接与读取超时各 30 秒，整体请求上限 2 分钟，配置网络缓存与 User-Agent。可借鉴连接池和统一网络策略。
- [Mihon MangaCoverFetcher](https://github.com/mihonapp/mihon/blob/main/app/src/main/java/eu/kanade/tachiyomi/data/coil/MangaCoverFetcher.kt)：封面使用来源自己的客户端及 headers，按图片 URL 缓存，合并并发重复请求；网络响应写入磁盘后供图片解码器加载。
- [Mihon HttpSource](https://github.com/mihonapp/mihon/blob/main/source-api/src/main/kotlin/eu/kanade/tachiyomi/source/online/HttpSource.kt)：章节页、图片地址解析与最终图片请求分层；最终图片请求继续使用来源 headers。
- [Suwayomi Page](https://github.com/Suwayomi/Suwayomi-Server/blob/master/server/src/main/kotlin/suwayomi/tachidesk/manga/impl/Page.kt)：先获取真实图片 URL，再使用来源网络能力下载，缓存文件并向前端提供图片流和 MIME。API 章节记录不等于图片可以立即下载。

上述实现说明封面不宜全部依赖 WebView 直接请求远程 `<img>`；来源 headers、缓存及图片加载结果应由应用掌握。本项目采用 Rust 获取图片、验证图片字节、磁盘缓存、自定义协议提供缓存的方式。

## 已确认的接口结果与缺陷

1. `GET https://api.bgm.tv/v0/subjects/253` 返回 200，包含 `lain.bgm.tv` 的封面 URL；直接请求原图返回 200、`image/jpeg`、77,719 字节。`GET https://api.bgm.tv/v0/subjects/253/image?type=medium` 实际返回 302 到 `lain.bgm.tv/r/800/...`。原先原生公共网络统一拒绝重定向，确实无法处理该官方图片接口。
2. CopyManga 公开搜索 `mapi.hotmangasg.com/api/v3/search/comic` 使用来源移动端 headers 返回 200。封面来自动态 CDN `so.mangafunb.fun`，实测 200、102,437 字节，但 Content-Type 为 `binary/octet-stream`。仅固定 CDN 域名或仅接受 `image/*` 会拒绝合法封面，需检查实际图片文件签名。
3. MangaDex 公开搜索返回 200；One Piece 的语言筛选 feed 返回 15 章，部分是 `pages=0`、外部 MangaPlus 链接，不能当成本地可下载章节。另一个 feed 中 `pages=14` 的章节调用 `/at-home/server/<id>` 仍返回 404。UI 必须区分外部阅读、无图片、图片服务不可用，不能把所有空资源都归因网络。
4. 0.2 的 `public_http_client` 禁用代理并手动固定 DNS，而 metadata 使用另一套客户端。这使 API、封面和章节下载的网络策略不一致；使用代理时还可能提前在本机 DNS 阶段失败。
5. Cargo 对 reqwest 设置 `default-features=false`，仅启用了 JSON/multipart/rustls，未启用 `system-proxy`。因此移除 `.no_proxy()` 本身仍不足以读取 Windows 系统代理。现已显式启用该功能。
6. 原生 API 出错时如果返回 HTML，旧实现会把所有 HTTP 错误变成“不是有效 JSON”。现保留实际 HTTP 状态；只有成功 HTTP 响应不是 JSON 才报格式错误。

## 本轮实现与契约

- `media_image_request({url, referer?}) -> {cacheKey, mimeType}`。库中仍保存来源原 URL，不保存 base64。
- Windows 图片地址为 `http://acgn-image.localhost/<cacheKey>`；自定义协议只接受 64 位十六进制缓存标识，读取指定图片缓存目录。
- 自动选择 Bangumi、MangaDex、CopyManga Referer；允许来源显式提供 Referer。检查 JPEG、PNG、GIF、WEBP、AVIF 文件签名，拒绝 HTML 错误页。
- 同一封面并发请求合并；磁盘缓存上限 256 MiB / 1,500 张，单图 12 MiB。写入使用已有无覆盖原子文件发布。
- 元数据、封面、章节图片共享连接池，尊重已配置代理和正常 DNS，最多跟随 5 次有效 HTTP(S) 重定向。跨域敏感头由 reqwest 的重定向规则移除；本机 RPC 继续只访问回环地址并禁用代理。

## 验证记录

公开接口及开源实现通过 `curl.exe` 读取；web 工具当时返回 503，因此引用的是实际访问的 GitHub 原始源码及官方接口。原生单元测试包含图片签名、来源 Referer、动态 CDN 地址、已有文件安全边界；真实并发封面探测以及桌面自定义协议解码结果在实际运行后追加，不能用单元测试替代。

原生 `live_covers_and_redirect_are_cached_as_real_images` 已显式运行成功：三来源同时使用本项目 Rust 客户端下载并读取磁盘缓存，2.03 秒内全部完成。Bangumi 官方 302 图片接口最终得到 JPEG 67,795 字节；CopyManga 动态 CDN 得到 JPEG 102,437 字节；MangaDex 封面得到 JPEG 56,745 字节。普通原生测试 28 项通过，`cargo check --all-targets` 通过；WebView 自定义协议图片实际解码仍需桌面联调确认。
