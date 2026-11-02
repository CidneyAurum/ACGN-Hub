use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use zip::write::SimpleFileOptions;
mod completed_rename;
mod database;
mod diagnostics;
mod downloaded_media;
mod image_format;
mod local_viewer;
mod manga_downloads;
mod media_images;
mod mobile_http;
mod mobile_files;
mod network;
mod process_runner;
mod portable_profile;
mod public_video;
mod qbittorrent;
mod runtime;
mod safe_fs;
use safe_fs::{
    absolute_path as validate_absolute_path, has_parent_component, is_path_within, AtomicOutput,
};

#[derive(serde::Serialize)]
struct JsonHttpResponse {
    status: u16,
    body: Value,
}

#[derive(serde::Serialize)]
struct TextHttpResponse {
    status: u16,
    body: String,
}

#[derive(serde::Serialize)]
struct OrganizeFileResponse {
    status: String,
    #[serde(rename = "sourcePath")]
    source_path: String,
    #[serde(rename = "destinationPath")]
    destination_path: String,
}

#[derive(serde::Serialize)]
struct LibraryFileResponse {
    path: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: u64,
    sha256: Option<String>,
}

#[derive(serde::Serialize)]
struct MangaImagesResponse {
    #[serde(rename = "imagePaths")]
    image_paths: Vec<String>,
    #[serde(rename = "tempDirectory")]
    temp_directory: String,
}

#[derive(serde::Serialize)]
struct GameScanResponse {
    #[serde(rename = "rootPath")]
    root_path: String,
    engine: String,
    #[serde(rename = "launchCandidates")]
    launch_candidates: Vec<String>,
    #[serde(rename = "detectedFiles")]
    detected_files: Vec<String>,
}

async fn run_blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("后台文件操作失败：{error}"))?
}

#[tauri::command]
async fn metadata_json_request(
    url: String,
    method: String,
    body: Option<Value>,
    headers: Option<std::collections::HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<JsonHttpResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "元数据地址无效".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("元数据 API 只允许无内嵌凭据的 HTTPS 地址".to_string());
    }
    if !matches!(
        parsed.host_str(),
        Some("api.bgm.tv")
            | Some("api.vndb.org")
            | Some("api.github.com")
            | Some("www.kungal.com")
            | Some("shionlib.com")
            | Some("api.mangacopy.com")
            | Some("mapi.hotmangasg.com")
            | Some("mapi.hotmangasd.com")
            | Some("mapi.hotmangasf.com")
            | Some("api.2024manga.com")
            | Some("api.copy2000.online")
            | Some("api.copy202601.com")
            | Some("api.copymanga.com")
            | Some("api.copy20.com")
            | Some("mangacopy.com")
            | Some("api.mangadex.org")
            | Some("archive.org")
            | Some("api.animes.garden")
            | Some("lnovel.animes.garden")
            | Some("api.bilibili.com")
    ) {
        return Err("只允许请求已接入的元数据 API 域名".to_string());
    }
    let request_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "元数据请求方法无效".to_string())?;
    if request_method != reqwest::Method::GET && request_method != reqwest::Method::POST {
        return Err("元数据请求只允许 GET 或 POST".to_string());
    }
    if parsed.host_str() == Some("api.bilibili.com")
        && (parsed.path() != "/x/web-interface/search/type"
            || request_method != reqwest::Method::GET)
    {
        return Err("Bilibili 元数据代理仅支持公开投稿搜索 GET 接口".to_string());
    }

    let timeout = timeout_ms.unwrap_or(10_000).clamp(500, 35_000);
    let client = network::client()?;
    let mut request = client
        .request(request_method, url)
        .timeout(std::time::Duration::from_millis(timeout));
    if let Some(headers) = headers {
        for (name, value) in headers {
            let normalized = name.to_ascii_lowercase();
            if !matches!(
                normalized.as_str(),
                "accept"
                    | "content-type"
                    | "user-agent"
                    | "authorization"
                    | "version"
                    | "source"
                    | "x-requested-with"
                    | "platform"
                    | "region"
                    | "webp"
                    | "use_webp"
                    | "use_oversea_cdn"
                    | "referer"
            ) {
                continue;
            }
            if normalized == "referer" {
                let referer = reqwest::Url::parse(&value).map_err(|_| "元数据 Referer 无效")?;
                network::public_url(&referer)?;
            }
            let header_name = reqwest::header::HeaderName::from_bytes(normalized.as_bytes())
                .map_err(|_| "元数据请求头名称无效".to_string())?;
            let header_value = reqwest::header::HeaderValue::from_str(&value)
                .map_err(|_| "元数据请求头值无效".to_string())?;
            request = request.header(header_name, header_value);
        }
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network::request_error(&error))?;
    let status = response.status().as_u16();
    let bytes = read_http_bytes(response, 8 * 1024 * 1024).await?;
    let body = match serde_json::from_slice::<Value>(&bytes) {
        Ok(body) => body,
        Err(_) if !(200..300).contains(&status) => {
            serde_json::json!({"error": {"message": format!("元数据服务器返回 HTTP {status}")}})
        }
        Err(error) => return Err(format!("元数据 API 响应不是有效 JSON：{error}")),
    };
    Ok(JsonHttpResponse { status, body })
}

#[tauri::command]
async fn copymanga_login(username: String, password: String) -> Result<Value, String> {
    let username = username.trim();
    if username.is_empty() || password.is_empty() {
        return Err("拷贝漫画账号和密码不能为空".to_string());
    }
    if username.len() > 128 || password.len() > 256 {
        return Err("拷贝漫画账号或密码长度无效".to_string());
    }

    // CopyManga's mobile API expects Base64(password-salt) and a six-digit
    // salt. The plaintext password is never persisted or returned.
    let salt = 100_000_u32
        + (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| (value.as_millis() % 900_000) as u32)
            .unwrap_or_default());
    let password_with_salt = format!("{password}-{salt}");
    const COPYMANGA_API_VERSION: &str = "2024.4.28";
    use base64::Engine;
    let encoded_password = base64::engine::general_purpose::STANDARD.encode(password_with_salt);
    let salt_text = salt.to_string();
    let form = [
        ("username", username),
        ("password", encoded_password.as_str()),
        ("salt", salt_text.as_str()),
        ("version", COPYMANGA_API_VERSION),
        ("source", "Official"),
        ("platform", "3"),
    ];

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(format!("COPY/{COPYMANGA_API_VERSION}"))
        .build()
        .map_err(|error| format!("创建拷贝漫画登录客户端失败：{error}"))?;
    let response = client
        .post("https://mapi.hotmangasg.com/api/v3/login?platform=3")
        .header("version", COPYMANGA_API_VERSION)
        .header("source", "Official")
        .header("x-requested-with", "com.manga2020.app")
        .header("platform", "3")
        .header("region", "1")
        .header("webp", "1")
        .form(&form)
        .send()
        .await
        .map_err(|error| format!("拷贝漫画登录请求失败：{error}"))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("拷贝漫画登录响应不是有效 JSON：{error}"))?;
    let code = body.get("code").and_then(Value::as_i64).unwrap_or_default();
    if !status.is_success() || code != 200 {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("账号或密码错误");
        return Err(format!("拷贝漫画登录失败：{message}"));
    }
    let token = body
        .pointer("/results/token")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "拷贝漫画登录成功但未返回 Token".to_string())?;
    Ok(serde_json::json!({ "token": token }))
}

#[tauri::command]
async fn jmcomic_bridge(
    action: String,
    value: Option<String>,
    output_dir: Option<String>,
    incoming_root: Option<String>,
) -> Result<Value, String> {
    if cfg!(mobile) {
        return Err("JM Python 桥接仅适用于桌面端；安卓端请选择原生 HTTP 漫画来源".into());
    }
    run_blocking(move || jmcomic_bridge_impl(action, value, output_dir, incoming_root)).await
}

fn jmcomic_bridge_impl(
    action: String,
    value: Option<String>,
    output_dir: Option<String>,
    incoming_root: Option<String>,
) -> Result<Value, String> {
    if !matches!(
        action.as_str(),
        "health" | "search" | "chapters" | "download"
    ) {
        return Err("jmcomic 操作无效".to_string());
    }
    if !matches!(action.as_str(), "health") && value.as_deref().unwrap_or("").trim().is_empty() {
        return Err("jmcomic 请求缺少参数".to_string());
    }
    if value.as_ref().is_some_and(|value| value.len() > 1000) {
        return Err("jmcomic 参数过长".to_string());
    }
    if matches!(action.as_str(), "download" | "chapters")
        && !value
            .as_deref()
            .unwrap_or("")
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        return Err("jmcomic 作品或章节 ID 必须是数字".to_string());
    }
    let mut output_guard = if action == "download" {
        let raw = output_dir.as_deref().ok_or("jmcomic 下载目录缺失")?;
        let incoming = incoming_root
            .as_deref()
            .ok_or("jmcomic 下载缺少 Incoming 根目录")?;
        Some(safe_fs::MangaTempGuard::create(incoming, raw)?)
    } else {
        None
    };
    let output_path = output_guard
        .as_ref()
        .map(|guard| guard.path().to_path_buf());

    let script_path = std::env::temp_dir().join(format!(
        "acgn-jmcomic-{}-{}.py",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default()
    ));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&script_path)
        .and_then(|mut file| {
            file.write_all(include_str!("../resources/jmcomic_bridge.py").as_bytes())
        })
        .map_err(|error| format!("创建 jmcomic 临时桥接脚本失败：{error}"))?;
    let mut last_error = String::new();
    let candidates = ["py.exe", "python.exe", "py", "python"];
    let result = (|| {
        for executable in candidates {
            let mut command = Command::new(executable);
            if process_runner::python_uses_launcher(executable) {
                command.arg("-3");
            }
            command.arg(&script_path).arg(&action);
            if let Some(value) = value.as_deref() {
                command.arg(value);
            }
            if let Some(output_path) = output_path.as_ref() {
                command.arg(output_path);
            }
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            command.env("PYTHONUTF8", "1");
            let timeout =
                std::time::Duration::from_secs(if action == "download" { 900 } else { 45 });
            let output = match process_runner::run_with_timeout(&mut command, timeout) {
                Ok(output) => output,
                Err(error) => {
                    if !error.starts_with("启动子进程失败") {
                        return Err(error);
                    }
                    last_error = format!("{executable}: {error}");
                    continue;
                }
            };
            let stdout = String::from_utf8_lossy(&output.stdout);
            let payload = stdout
                .lines()
                .rev()
                .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok());
            if let Some(payload) = payload {
                if let Some(error) = payload.get("error").and_then(Value::as_str) {
                    if error.starts_with("ModuleNotFoundError:") {
                        last_error = error.to_string();
                        continue;
                    }
                    return Err(error.to_string());
                }
                if !output.status.success() {
                    return Err(format!(
                        "jmcomic 执行失败：{error_text}",
                        error_text = error_text(&output.stderr)
                    ));
                }
                return Ok(payload);
            }
            last_error = if output.status.success() {
                "jmcomic 没有返回有效 JSON".to_string()
            } else {
                format!("jmcomic 执行失败：{}", error_text(&output.stderr))
            };
        }
        Err(if last_error.is_empty() {
            "未找到 Python 3".to_string()
        } else {
            last_error
        })
    })();
    let _ = std::fs::remove_file(&script_path);
    if result.is_ok() {
        if let Some(guard) = output_guard.as_mut() {
            guard.keep();
        }
    }
    result.map(|mut payload| {
        if action == "download" {
            if let (Some(path), Some(object)) = (output_path.as_ref(), payload.as_object_mut()) {
                object.insert(
                    "tempDirectory".to_string(),
                    Value::String(path.to_string_lossy().into_owned()),
                );
            }
        }
        payload
    })
}

fn error_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    if text.is_empty() {
        "未知错误".to_string()
    } else {
        text.chars().take(800).collect()
    }
}

#[tauri::command]
async fn download_manga_images(
    app: tauri::AppHandle,
    image_urls: Vec<String>,
    incoming_root: String,
    temp_directory: String,
    referer: Option<String>,
    cookie: Option<String>,
) -> Result<MangaImagesResponse, String> {
    let mut operation =
        diagnostics::Operation::start("manga.download", &format!("pages={}", image_urls.len()));
    const MAX_IMAGES: usize = 1_000;
    const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
    const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;

    if image_urls.is_empty() {
        return Err("章节至少需要一个图片地址".to_string());
    }
    if image_urls.len() > MAX_IMAGES {
        return Err("单个章节图片数超过 1000，已拒绝下载".to_string());
    }
    let active_download = manga_downloads::ActiveDownload::start(&temp_directory)?;
    let mut temporary = safe_fs::MangaTempGuard::create(&incoming_root, &temp_directory)?;
    let temp_root = temporary.path().to_path_buf();
    let referer = validate_optional_header(referer, "Referer")?;
    let cookie = validate_optional_header(cookie, "Cookie")?;
    let result = async {
        let mut clients = std::collections::HashMap::<String, reqwest::Client>::new();
        let mut image_paths = Vec::with_capacity(image_urls.len());
        let mut total_bytes = 0_u64;
        for (index, raw_url) in image_urls.iter().enumerate() {
            active_download.check()?;
            let url =
                reqwest::Url::parse(raw_url.trim()).map_err(|_| "漫画图片地址无效".to_string())?;
            if url.scheme() != "http" && url.scheme() != "https" {
                return Err("漫画图片只支持 HTTP 或 HTTPS".to_string());
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err("漫画图片地址不能包含认证信息".to_string());
            }
            let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
            if is_private_feed_host(&host) {
                return Err("漫画图片地址不能指向本机或私有网络".to_string());
            }
            let key = format!(
                "{}://{}:{}",
                url.scheme(),
                host,
                url.port_or_known_default().unwrap_or(443)
            );
            if !clients.contains_key(&key) {
                clients.insert(key.clone(), public_http_client(&url, 30_000).await?);
            }
            let client = clients.get(&key).ok_or("漫画下载客户端不可用")?;
            let response = {
                let mut attempt = 0_u32;
                loop {
                    active_download.check()?;
                    diagnostics::record(&format!(
                        "manga.download.request.begin page={} attempt={}",
                        index + 1,
                        attempt + 1
                    ));
                    let mut request = client
                        .get(url.clone())
                        .timeout(std::time::Duration::from_secs(30));
                    if let Some(value) = referer.as_deref() {
                        request = request.header(reqwest::header::REFERER, value);
                    }
                    if let Some(value) = cookie.as_deref() {
                        request = request.header(reqwest::header::COOKIE, value);
                    }
                    match request.send().await {
                        Ok(response)
                            if (response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                                || response.status().is_server_error())
                                && attempt < 2 =>
                        {
                            attempt += 1;
                            tokio::time::sleep(std::time::Duration::from_millis(
                                250 * 2_u64.pow(attempt - 1),
                            ))
                            .await;
                        }
                        Ok(response) => break response,
                        Err(_error) if attempt < 2 => {
                            attempt += 1;
                            tokio::time::sleep(std::time::Duration::from_millis(
                                250 * 2_u64.pow(attempt - 1),
                            ))
                            .await;
                        }
                        Err(error) => return Err(format!("下载第 {} 页失败：{error}", index + 1)),
                    }
                }
            };
            diagnostics::record(&format!(
                "manga.download.request.response page={} status={}",
                index + 1,
                response.status().as_u16()
            ));
            if !response.status().is_success() {
                return Err(format!(
                    "下载第 {} 页失败：HTTP {}",
                    index + 1,
                    response.status().as_u16()
                ));
            }
            if response.content_length().unwrap_or(0) > MAX_IMAGE_BYTES {
                return Err(format!("第 {} 页超过 50 MB，已停止下载", index + 1));
            }
            let bytes = read_http_bytes(response, MAX_IMAGE_BYTES as usize)
                .await
                .map_err(|error| format!("读取第 {} 页失败：{error}", index + 1))?;
            active_download.check()?;
            diagnostics::record(&format!(
                "manga.download.request.read page={} bytes={}",
                index + 1,
                bytes.len()
            ));
            let image_size =
                u64::try_from(bytes.len()).map_err(|_| "漫画图片大小无效".to_string())?;
            if image_size > MAX_IMAGE_BYTES
                || total_bytes.saturating_add(image_size) > MAX_TOTAL_BYTES
            {
                return Err("章节图片总大小超过 500 MB，已停止下载".to_string());
            }
            total_bytes = total_bytes.saturating_add(image_size);
            let destination = save_manga_page(&temp_root, index, &bytes)?;
            image_paths.push(destination.to_string_lossy().into_owned());
            diagnostics::record(&format!(
                "manga.download.page completed={} total={}",
                index + 1,
                image_urls.len()
            ));
            use tauri::Emitter;
            let _ = app.emit(
                "manga-download-progress",
                manga_downloads::Progress {
                    temp_directory: temp_directory.clone(),
                    completed: index + 1,
                    total: image_urls.len(),
                },
            );
        }
        active_download.check()?;
        Ok(MangaImagesResponse {
            image_paths,
            temp_directory: temp_root.to_string_lossy().into_owned(),
        })
    }
    .await;

    if result.is_ok() {
        temporary.keep();
    }
    operation.finish(result.is_ok());
    result
}

fn save_manga_page(directory: &Path, index: usize, bytes: &[u8]) -> Result<PathBuf, String> {
    let format = image_format::ImageFormat::detect(bytes).ok_or_else(|| {
        format!(
            "第 {} 页响应不是受支持的图片，可能是防盗链、验证码或来源错误页面，已停止下载",
            index + 1
        )
    })?;
    let destination = directory.join(format!("page-{:04}.{}", index + 1, format.extension()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| format!("保存第 {} 页失败：{error}", index + 1))?;
    file.write_all(bytes)
        .map_err(|error| format!("写入第 {} 页失败：{error}", index + 1))?;
    Ok(destination)
}

#[tauri::command]
async fn write_text_file(
    content: String,
    output_root: String,
    output_path: String,
) -> Result<(), String> {
    run_blocking(move || write_text_file_impl(content, output_root, output_path)).await
}

fn write_text_file_impl(
    content: String,
    output_root: String,
    output_path: String,
) -> Result<(), String> {
    if content.len() > 100 * 1024 * 1024 {
        return Err("轻小说正文超过 100 MB，已拒绝写入".to_string());
    }
    let output = safe_fs::output_path(&output_root, &output_path, "txt")?;
    let mut atomic = AtomicOutput::new(output)?;
    let mut file = atomic.take_file();
    file.write_all(content.as_bytes())
        .map_err(|error| format!("写入文本文件失败：{error}"))?;
    atomic.publish(file)
}

#[tauri::command]
async fn create_cbz(
    image_paths: Vec<String>,
    output_path: String,
    source_root: String,
    incoming_root: String,
    output_root: String,
) -> Result<(), String> {
    run_blocking(move || {
        create_cbz_impl(
            image_paths,
            output_path,
            source_root,
            incoming_root,
            output_root,
        )
    })
    .await
}

fn create_cbz_impl(
    image_paths: Vec<String>,
    output_path: String,
    source_root: String,
    incoming_root: String,
    output_root: String,
) -> Result<(), String> {
    const MAX_IMAGES: usize = 1_000;
    const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
    if image_paths.is_empty() || image_paths.len() > MAX_IMAGES {
        return Err("CBZ 图片数量无效".to_string());
    }
    let incoming_root =
        std::fs::canonicalize(validate_absolute_path(&incoming_root, "Incoming 根目录")?)
            .map_err(|error| format!("Incoming 根目录不可用：{error}"))?;
    let source_root = std::fs::canonicalize(validate_absolute_path(&source_root, "漫画临时目录")?)
        .map_err(|error| format!("漫画临时目录不可用：{error}"))?;
    if !is_path_within(&incoming_root, &source_root) || !source_root.is_dir() {
        return Err("漫画临时目录不是目录".to_string());
    }
    safe_fs::require_child(&incoming_root, &source_root, "漫画临时目录")?;
    safe_fs::ensure_manga_temp_owned(&source_root)?;
    let output = safe_fs::output_path(&output_root, &output_path, "cbz")?;

    let mut files = Vec::with_capacity(image_paths.len());
    let mut total_bytes = 0_u64;
    for image_path in image_paths {
        let image = std::fs::canonicalize(&image_path)
            .map_err(|error| format!("漫画图片不可用：{error}"))?;
        if !is_path_within(&source_root, &image) || !image.is_file() {
            return Err("漫画图片不在临时目录内，已拒绝打包".to_string());
        }
        let size = std::fs::metadata(&image)
            .map_err(|error| format!("读取漫画图片大小失败：{error}"))?
            .len();
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("CBZ 图片总大小超过 500 MB".to_string());
        }
        let mut input =
            std::fs::File::open(&image).map_err(|error| format!("打开漫画图片失败：{error}"))?;
        let mut prefix = vec![0_u8; 4096];
        let prefix_size = input
            .read(&mut prefix)
            .map_err(|error| format!("读取漫画图片格式失败：{error}"))?;
        let format = image_format::ImageFormat::detect(&prefix[..prefix_size])
            .ok_or("CBZ 包含非图片正文，已拒绝打包；支持 JPG、PNG、WEBP、GIF 或 AVIF")?;
        files.push((image, format));
    }
    files.sort_by(|(left, _), (right, _)| left.cmp(right));
    let mut atomic = AtomicOutput::new(output)?;
    let archive_file = atomic.take_file();
    let mut archive = zip::ZipWriter::new(archive_file);
    // JPG/PNG/WEBP are already compressed. Storing them avoids costly recompression
    // and compression-backend stack allocations on small Windows worker stacks.
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (index, (image, format)) in files.iter().enumerate() {
        archive
            .start_file(
                format!("page-{:04}.{}", index + 1, format.extension()),
                options,
            )
            .map_err(|error| format!("创建 CBZ 条目失败：{error}"))?;
        let mut input =
            std::fs::File::open(image).map_err(|error| format!("打开漫画图片失败：{error}"))?;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let count = input
                .read(&mut buffer)
                .map_err(|error| format!("读取漫画图片失败：{error}"))?;
            if count == 0 {
                break;
            }
            archive
                .write_all(&buffer[..count])
                .map_err(|error| format!("写入 CBZ 失败：{error}"))?;
        }
    }
    let file = archive
        .finish()
        .map_err(|error| format!("完成 CBZ 失败：{error}"))?;
    atomic.publish(file)?;
    let _ = safe_fs::cleanup_manga_temp(
        &incoming_root.to_string_lossy(),
        &source_root.to_string_lossy(),
    );
    Ok(())
}

#[tauri::command]
async fn cleanup_manga_temp(temp_directory: String, incoming_root: String) -> Result<(), String> {
    run_blocking(move || cleanup_manga_temp_impl(temp_directory, incoming_root)).await
}

fn cleanup_manga_temp_impl(temp_directory: String, incoming_root: String) -> Result<(), String> {
    safe_fs::cleanup_manga_temp(&incoming_root, &temp_directory)
}

#[tauri::command]
async fn scan_game_installation(root_path: String) -> Result<GameScanResponse, String> {
    run_blocking(move || scan_game_installation_impl(root_path)).await
}

fn scan_game_installation_impl(root_path: String) -> Result<GameScanResponse, String> {
    let root = std::fs::canonicalize(validate_absolute_path(&root_path, "游戏目录")?)
        .map_err(|error| format!("游戏目录不可用：{error}"))?;
    if !root.is_dir() {
        return Err("游戏路径不是目录".to_string());
    }
    let mut state = GameScanState::default();
    collect_game_files(&root, &root, &mut state)?;
    if state.file_count > 5_000 {
        return Err("游戏目录文件数超过 5000，已停止扫描".to_string());
    }
    state.launch_candidates.sort();
    state.launch_candidates.truncate(20);
    state.detected_files.sort();
    state.detected_files.dedup();
    state.detected_files.truncate(100);
    let engine = if state.renpy {
        "renpy"
    } else if state.kirikiri {
        "kirikiri"
    } else if state.unity_data && (state.unity_player || !state.launch_candidates.is_empty()) {
        "unity"
    } else {
        "unknown"
    };
    Ok(GameScanResponse {
        root_path: root.to_string_lossy().into_owned(),
        engine: engine.to_string(),
        launch_candidates: state.launch_candidates,
        detected_files: state.detected_files,
    })
}

#[derive(Default)]
struct GameScanState {
    file_count: usize,
    renpy: bool,
    kirikiri: bool,
    unity_data: bool,
    unity_player: bool,
    launch_candidates: Vec<String>,
    detected_files: Vec<String>,
}

fn collect_game_files(path: &Path, root: &Path, state: &mut GameScanState) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("读取游戏目录失败：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(());
    }
    for entry in
        std::fs::read_dir(path).map_err(|error| format!("读取游戏目录条目失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取游戏目录条目失败：{error}"))?;
        let entry_type = entry
            .file_type()
            .map_err(|error| format!("读取游戏条目类型失败：{error}"))?;
        if entry_type.is_symlink() {
            continue;
        }
        let child = entry.path();
        let canonical =
            std::fs::canonicalize(&child).map_err(|error| format!("校验游戏条目失败：{error}"))?;
        if !is_path_within(root, &canonical) {
            return Err("游戏目录包含越出根目录的路径，已停止扫描".to_string());
        }
        let relative = canonical
            .strip_prefix(root)
            .unwrap_or(&canonical)
            .to_string_lossy()
            .replace('/', "\\");
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if entry_type.is_dir() {
            if name.ends_with("_data") {
                state.unity_data = true;
                state.detected_files.push(relative.clone());
            }
            if name == "renpy" {
                state.renpy = true;
                state.detected_files.push(relative.clone());
            }
            collect_game_files(&canonical, root, state)?;
            continue;
        }
        if !entry_type.is_file() {
            continue;
        }
        state.file_count += 1;
        if state.file_count > 5_000 {
            return Ok(());
        }
        let extension = Path::new(&name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if extension == "exe" {
            state
                .launch_candidates
                .push(canonical.to_string_lossy().into_owned());
        }
        if name == "renpy.exe" || extension == "rpy" || extension == "rpyc" {
            state.renpy = true;
            state.detected_files.push(relative.clone());
        }
        if extension == "xp3" || name.contains("krkr") {
            state.kirikiri = true;
            state.detected_files.push(relative.clone());
        }
        if name == "unityplayer.dll" {
            state.unity_player = true;
            state.detected_files.push(relative);
        }
    }
    Ok(())
}

#[tauri::command]
fn launch_game(root_path: String, launch_path: String) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Windows EXE 游戏只能在 Windows 端启动；安卓端可浏览和收藏 Galgame 资料".into());
    }
    let root = std::fs::canonicalize(validate_absolute_path(&root_path, "游戏目录")?)
        .map_err(|error| format!("游戏目录不可用：{error}"))?;
    if !root.is_dir() {
        return Err("游戏根路径不是目录".to_string());
    }
    let launch = std::fs::canonicalize(validate_absolute_path(&launch_path, "启动文件")?)
        .map_err(|error| format!("启动文件不可用：{error}"))?;
    if !launch.is_file()
        || !is_path_within(&root, &launch)
        || launch
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("exe"))
            != Some(true)
    {
        return Err("启动文件必须是游戏目录内的 EXE".to_string());
    }
    std::process::Command::new(&launch)
        .current_dir(&root)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动游戏失败：{error}"))
}

#[tauri::command]
async fn backup_game_saves(
    game_root: String,
    save_paths: Vec<String>,
    backup_root: String,
    backup_name: String,
) -> Result<String, String> {
    run_blocking(move || backup_game_saves_impl(game_root, save_paths, backup_root, backup_name))
        .await
}

fn backup_game_saves_impl(
    game_root: String,
    save_paths: Vec<String>,
    backup_root: String,
    backup_name: String,
) -> Result<String, String> {
    if save_paths.is_empty() || save_paths.len() > 100 {
        return Err("请提供 1 到 100 个存档文件或目录".to_string());
    }
    let root = std::fs::canonicalize(validate_absolute_path(&game_root, "游戏目录")?)
        .map_err(|error| format!("游戏目录不可用：{error}"))?;
    if !root.is_dir() {
        return Err("游戏根路径不是目录".to_string());
    }
    let backup_root_path = validate_absolute_path(&backup_root, "存档备份根目录")?;
    if is_path_within(&root, &backup_root_path)
        || is_path_within(
            &root,
            &safe_fs::canonical_existing_ancestor(&backup_root_path)?,
        )
    {
        return Err("存档备份目录必须位于游戏目录外，避免递归复制".to_string());
    }
    std::fs::create_dir_all(&backup_root_path)
        .map_err(|error| format!("创建存档备份目录失败：{error}"))?;
    let backup_root = std::fs::canonicalize(&backup_root_path)
        .map_err(|error| format!("校验存档备份目录失败：{error}"))?;
    if is_path_within(&root, &backup_root) {
        return Err("存档备份目录必须位于游戏目录外，避免递归复制".to_string());
    }
    let clean_name = validate_backup_name(&backup_name)?;
    let destination = backup_root.join(clean_name);
    std::fs::create_dir(&destination)
        .map_err(|error| format!("创建本次存档备份目录失败：{error}"))?;
    let result = (|| {
        for raw_path in save_paths {
            let candidate = PathBuf::from(raw_path.trim());
            if candidate.as_os_str().is_empty() || has_parent_component(&candidate) {
                return Err("存档路径不能为空且不能包含 .. 父目录片段".to_string());
            }
            let source = if candidate.is_absolute() {
                candidate
            } else {
                root.join(candidate)
            };
            let source = std::fs::canonicalize(&source)
                .map_err(|error| format!("存档路径不可用：{error}"))?;
            if !is_path_within(&root, &source) {
                return Err("存档路径不在游戏目录内，已拒绝备份".to_string());
            }
            let relative = source
                .strip_prefix(&root)
                .map_err(|_| "无法计算存档相对路径".to_string())?;
            copy_game_path(&source, &destination.join(relative))?;
        }
        Ok(destination.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&destination);
    }
    result
}

fn copy_game_path(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(source).map_err(|error| format!("读取存档失败：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("存档目录不支持符号链接".to_string());
    }
    if metadata.is_dir() {
        std::fs::create_dir(destination).map_err(|error| format!("创建存档目录失败：{error}"))?;
        for entry in
            std::fs::read_dir(source).map_err(|error| format!("读取存档目录失败：{error}"))?
        {
            let entry = entry.map_err(|error| format!("读取存档条目失败：{error}"))?;
            copy_game_path(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err("存档路径不是文件或目录".to_string());
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建存档目录失败：{error}"))?;
    }
    let mut input =
        std::fs::File::open(source).map_err(|error| format!("打开存档失败：{error}"))?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("创建备份文件失败：{error}"))?;
    std::io::copy(&mut input, &mut output).map_err(|error| format!("复制存档失败：{error}"))?;
    Ok(())
}

fn validate_backup_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 120
        || value == "."
        || value == ".."
        || value.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
    {
        return Err("存档备份名称无效".to_string());
    }
    Ok(value.to_string())
}

fn validate_optional_header(value: Option<String>, label: &str) -> Result<Option<String>, String> {
    let value = value.filter(|item| !item.trim().is_empty());
    if let Some(value) = &value {
        if value.len() > 16 * 1024 || value.contains('\r') || value.contains('\n') {
            return Err(format!("{label}值无效或过长"));
        }
        reqwest::header::HeaderValue::from_str(value).map_err(|_| format!("{label}值无效"))?;
    }
    Ok(value)
}

#[tauri::command]
async fn feed_text_request(
    url: String,
    method: String,
    headers: Option<std::collections::HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<TextHttpResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Feed 地址无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Feed 只允许无内嵌凭据的 HTTP 或 HTTPS 地址".to_string());
    }
    if !method.eq_ignore_ascii_case("GET") {
        return Err("Feed 请求只允许 GET".to_string());
    }
    let timeout = timeout_ms.unwrap_or(10_000).clamp(500, 30_000);
    let client = public_http_client(&parsed, timeout).await?;
    let mut request = client
        .get(parsed)
        .timeout(std::time::Duration::from_millis(timeout));
    if let Some(headers) = headers {
        for (name, value) in headers {
            if !matches!(
                name.to_ascii_lowercase().as_str(),
                "accept" | "user-agent" | "referer"
            ) {
                continue;
            }
            if value.len() > 16 * 1024 || value.contains(['\r', '\n']) {
                return Err("Feed 请求头无效".to_string());
            }
            request = request.header(name, value);
        }
    }
    let response = request
        .send()
        .await
        .map_err(|error| network::request_error(&error))?;
    let status = response.status().as_u16();
    let bytes = read_http_bytes(response, 16 * 1024 * 1024).await?;
    let body = String::from_utf8(bytes).map_err(|_| "Feed 响应不是有效 UTF-8 文本")?;
    Ok(TextHttpResponse { status, body })
}

async fn public_http_client(url: &reqwest::Url, _timeout: u64) -> Result<reqwest::Client, String> {
    network::public_url(url)?;
    network::client()
}

async fn read_http_bytes(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("HTTP 响应超过允许大小".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| network::request_error(&error))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("HTTP 响应超过允许大小".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[tauri::command]
async fn organize_file(
    _task_id: String,
    source_path: String,
    destination_path: String,
    incoming_root: String,
    library_root: String,
) -> Result<OrganizeFileResponse, String> {
    run_blocking(move || {
        organize_file_impl(
            _task_id,
            source_path,
            destination_path,
            incoming_root,
            library_root,
        )
    })
    .await
}

fn organize_file_impl(
    _task_id: String,
    source_path: String,
    destination_path: String,
    incoming_root: String,
    library_root: String,
) -> Result<OrganizeFileResponse, String> {
    if has_parent_component(std::path::Path::new(&incoming_root))
        || has_parent_component(std::path::Path::new(&source_path))
        || has_parent_component(std::path::Path::new(&destination_path))
        || has_parent_component(std::path::Path::new(&library_root))
    {
        return Err("整理路径不能包含 .. 父目录片段".to_string());
    }
    let incoming = std::fs::canonicalize(&incoming_root)
        .map_err(|error| format!("Incoming 根目录不可用：{error}"))?;
    if !incoming.is_dir() {
        return Err("Incoming 根目录不是目录".to_string());
    }

    let source =
        std::fs::canonicalize(&source_path).map_err(|error| format!("源文件不可用：{error}"))?;
    if !source.is_file() {
        return Err("源路径不是文件".to_string());
    }
    if !is_path_within(&incoming, &source) {
        return Err("源文件不在 Incoming 根目录内，已拒绝整理".to_string());
    }

    let declared_library = std::path::PathBuf::from(&library_root);
    if !declared_library.is_absolute() {
        return Err("Library 根目录必须是绝对路径".to_string());
    }
    std::fs::create_dir_all(&declared_library)
        .map_err(|error| format!("创建 Library 根目录失败：{error}"))?;
    let library = std::fs::canonicalize(&declared_library)
        .map_err(|error| format!("校验 Library 根目录失败：{error}"))?;
    let destination = std::path::PathBuf::from(&destination_path);
    let parent = destination
        .parent()
        .ok_or_else(|| "整理目标缺少父目录".to_string())?;
    if !is_path_within(&declared_library, parent) && !is_path_within(&library, parent) {
        return Err("整理目标越出 Library 根目录，已拒绝整理".to_string());
    }

    if let Ok(existing) = std::fs::canonicalize(&destination) {
        if existing == source {
            return Ok(OrganizeFileResponse {
                status: "already_present".to_string(),
                source_path,
                destination_path,
            });
        }
        return Err("目标文件已存在，为避免覆盖已停止整理".to_string());
    }

    let existing_parent = safe_fs::canonical_existing_ancestor(parent)?;
    if !is_path_within(&library, &existing_parent) {
        return Err("整理目标越出 Library 根目录，已拒绝整理".to_string());
    }
    std::fs::create_dir_all(parent).map_err(|error| format!("创建 Library 子目录失败：{error}"))?;
    let canonical_parent =
        std::fs::canonicalize(parent).map_err(|error| format!("校验整理目标目录失败：{error}"))?;
    if !is_path_within(&library, &canonical_parent) {
        return Err("整理目标越出 Library 根目录，已拒绝整理".to_string());
    }
    safe_fs::move_file_no_replace(&source, &destination)?;
    Ok(OrganizeFileResponse {
        status: "moved".to_string(),
        source_path,
        destination_path,
    })
}

#[tauri::command]
async fn list_organizable_files(
    source_path: String,
    incoming_root: String,
) -> Result<Vec<String>, String> {
    run_blocking(move || list_organizable_files_impl(source_path, incoming_root)).await
}

fn list_organizable_files_impl(
    source_path: String,
    incoming_root: String,
) -> Result<Vec<String>, String> {
    if has_parent_component(std::path::Path::new(&source_path))
        || has_parent_component(std::path::Path::new(&incoming_root))
    {
        return Err("任务路径不能包含 .. 父目录片段".to_string());
    }
    let incoming = std::fs::canonicalize(&incoming_root)
        .map_err(|error| format!("Incoming 根目录不可用：{error}"))?;
    if !incoming.is_dir() {
        return Err("Incoming 根目录不是目录".to_string());
    }
    let source_metadata = std::fs::symlink_metadata(&source_path)
        .map_err(|error| format!("任务路径不可用：{error}"))?;
    if source_metadata.file_type().is_symlink() {
        return Err("不支持通过符号链接读取任务路径".to_string());
    }
    let source =
        std::fs::canonicalize(&source_path).map_err(|error| format!("任务路径不可用：{error}"))?;
    if !is_path_within(&incoming, &source) {
        return Err("任务路径不在 Incoming 根目录内，已拒绝读取".to_string());
    }

    let mut files = Vec::new();
    collect_organizable_files(&source, &incoming, &mut files)?;
    if files.len() > 5_000 {
        return Err("单个任务文件数超过 5000，已停止展开".to_string());
    }
    files.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    Ok(files
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
async fn scan_library_files(
    library_root: String,
    with_hash: bool,
) -> Result<Vec<LibraryFileResponse>, String> {
    run_blocking(move || scan_library_files_impl(library_root, with_hash)).await
}

fn scan_library_files_impl(
    library_root: String,
    with_hash: bool,
) -> Result<Vec<LibraryFileResponse>, String> {
    if has_parent_component(std::path::Path::new(&library_root)) {
        return Err("Library 根目录不能包含 .. 父目录片段".to_string());
    }
    let library = std::fs::canonicalize(&library_root)
        .map_err(|error| format!("Library 根目录不可用：{error}"))?;
    if !library.is_dir() {
        return Err("Library 根目录不是目录".to_string());
    }
    let mut paths = Vec::new();
    collect_organizable_files(&library, &library, &mut paths)?;
    if paths.len() > 20_000 {
        return Err("Library 文件数超过 20000，已停止扫描".to_string());
    }
    paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    paths
        .into_iter()
        .map(|path| {
            let size = std::fs::metadata(&path)
                .map_err(|error| format!("读取文件大小失败：{error}"))?
                .len();
            Ok(LibraryFileResponse {
                path: path.to_string_lossy().into_owned(),
                size_bytes: size,
                sha256: if with_hash {
                    Some(sha256_file(&path)?)
                } else {
                    None
                },
            })
        })
        .collect()
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("打开文件计算哈希失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = std::io::Read::read(&mut file, &mut buffer)
            .map_err(|error| format!("读取文件计算哈希失败：{error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_organizable_files(
    path: &std::path::Path,
    incoming: &std::path::Path,
    files: &mut Vec<std::path::PathBuf>,
) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("读取任务路径失败：{error}"))?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    if file_type.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    if !file_type.is_dir() {
        return Ok(());
    }

    for entry in std::fs::read_dir(path).map_err(|error| format!("读取任务目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取任务条目失败：{error}"))?;
        if entry
            .file_type()
            .map_err(|error| format!("读取任务条目类型失败：{error}"))?
            .is_symlink()
        {
            continue;
        }
        let child = entry.path();
        let canonical_child =
            std::fs::canonicalize(&child).map_err(|error| format!("校验任务条目失败：{error}"))?;
        if !is_path_within(incoming, &canonical_child) {
            return Err("任务目录包含越出 Incoming 的路径，已停止读取".to_string());
        }
        collect_organizable_files(&canonical_child, incoming, files)?;
    }
    Ok(())
}

fn is_private_feed_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(value) => {
                value.is_loopback()
                    || value.is_unspecified()
                    || value.is_private()
                    || value.is_link_local()
                    || value.is_multicast()
                    || value.is_broadcast()
                    || value.octets()[0] == 0
                    || (value.octets()[0] == 100 && (64..=127).contains(&value.octets()[1]))
            }
            std::net::IpAddr::V6(value) => {
                value.is_loopback()
                    || value.is_unspecified()
                    || value.is_unique_local()
                    || value.is_unicast_link_local()
                    || value.is_multicast()
                    || value
                        .to_ipv4_mapped()
                        .is_some_and(|mapped| is_private_feed_host(&mapped.to_string()))
            }
        };
    }
    false
}

#[tauri::command]
fn open_directory(path: String) -> Result<(), String> {
    if cfg!(mobile) {
        return Err("安卓端文件保存在应用私有目录，请从下载页使用内置阅读器打开".into());
    }
    let directory = std::path::PathBuf::from(path);
    let target = if directory.is_dir() {
        directory
    } else if directory.is_file() {
        directory
            .parent()
            .ok_or_else(|| "文件缺少可打开的父目录".to_string())?
            .to_path_buf()
    } else {
        return Err("路径不存在或不是文件/目录".to_string());
    };
    std::process::Command::new("explorer.exe")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开目录失败：{error}"))
}

#[tauri::command]
async fn delete_download_files(paths: Vec<String>, allowed_root: String) -> Result<(), String> {
    run_blocking(move || delete_download_files_impl(paths, allowed_root)).await
}

fn delete_download_files_impl(paths: Vec<String>, allowed_root: String) -> Result<(), String> {
    if paths.len() > 5_000 {
        return Err("待删除文件数超过 5000，已停止操作".to_string());
    }
    let root = std::fs::canonicalize(validate_absolute_path(&allowed_root, "下载目录")?)
        .map_err(|error| format!("下载目录不可用：{error}"))?;
    if !root.is_dir() {
        return Err("下载目录不是目录".to_string());
    }
    let mut validated_paths = Vec::with_capacity(paths.len());
    let mut planned = 0_usize;
    for raw_path in paths {
        let path = validate_absolute_path(&raw_path, "下载文件")?;
        if !path.exists() {
            continue;
        }
        validate_download_path(&path, &root, &mut planned)?;
        validated_paths.push(path);
    }
    let mut removed = 0_usize;
    for path in validated_paths {
        if path.exists() {
            delete_download_path(&path, &root, &mut removed)?;
        }
    }
    Ok(())
}

fn validate_download_path(path: &Path, root: &Path, planned: &mut usize) -> Result<(), String> {
    if *planned >= 5_000 {
        return Err("待删除文件数超过 5000，已停止操作".to_string());
    }
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("读取下载路径失败：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("下载路径包含符号链接或越出允许目录，已拒绝删除".to_string());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|error| format!("校验下载路径失败：{error}"))?;
    if canonical == root || !is_path_within(root, &canonical) {
        return Err("下载文件不在允许的下载目录内，已拒绝删除".to_string());
    }
    if metadata.is_dir() {
        for entry in
            std::fs::read_dir(path).map_err(|error| format!("读取下载目录失败：{error}"))?
        {
            let entry = entry.map_err(|error| format!("读取下载条目失败：{error}"))?;
            validate_download_path(&entry.path(), root, planned)?;
        }
    } else if !metadata.is_file() {
        return Err("下载路径不是文件或目录".to_string());
    }
    *planned += 1;
    Ok(())
}

fn delete_download_path(path: &Path, root: &Path, removed: &mut usize) -> Result<(), String> {
    if *removed >= 5_000 {
        return Err("待删除文件数超过 5000，已停止操作".to_string());
    }
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("读取下载路径失败：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("下载路径包含符号链接或越出允许目录，已拒绝删除".to_string());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|error| format!("校验下载路径失败：{error}"))?;
    if !is_path_within(root, &canonical) {
        return Err("下载路径包含符号链接或越出允许目录，已拒绝删除".to_string());
    }
    if metadata.is_dir() {
        for entry in
            std::fs::read_dir(path).map_err(|error| format!("读取下载目录失败：{error}"))?
        {
            let entry = entry.map_err(|error| format!("读取下载条目失败：{error}"))?;
            delete_download_path(&entry.path(), root, removed)?;
        }
        std::fs::remove_dir(path).map_err(|error| format!("删除下载目录失败：{error}"))?;
    } else if metadata.is_file() {
        std::fs::remove_file(path).map_err(|error| format!("删除下载文件失败：{error}"))?;
    } else {
        return Err("下载路径不是文件或目录".to_string());
    }
    *removed += 1;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let profile = runtime::portable_data_directory().expect("invalid portable data directory");
    let mut context = tauri::generate_context!();
    if profile.is_some() {
        for window in &mut context.config_mut().app.windows {
            window.create = false;
        }
    }
    let application = tauri::Builder::default()
        .on_page_load(|_webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                local_viewer::reset_local_viewer_sessions();
            }
        })
        .register_asynchronous_uri_scheme_protocol("acgn-image", |context, request, responder| {
            media_images::respond_image_protocol(context.app_handle().clone(), request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("acgn-local", |context, request, responder| {
            local_viewer::respond_local_viewer_protocol(context.app_handle().clone(), request, responder);
        })
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(mobile_files::init())
        .setup(move |app| {
            diagnostics::initialize(app.handle()).map_err(std::io::Error::other)?;
            if let Some(profile) = &profile {
                std::fs::create_dir_all(profile)?;
                for window in &app.config().app.windows {
                    tauri::WebviewWindowBuilder::from_config(app, window)?
                        .data_directory(profile.join("WebView2").join(&window.label))
                        .build()?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            completed_rename::rename_completed_download,
            completed_rename::recover_completed_download_renames,
            downloaded_media::open_downloaded_media,
            local_viewer::prepare_local_viewer,
            local_viewer::close_local_viewer,
            public_video::inspect_public_video,
            public_video::download_public_video,
            public_video::cancel_public_video,
            media_images::media_image_request,
            manga_downloads::cancel_manga_download,
            database::database_transaction,
            database::get_database_url,
            runtime::aria2_rpc,
            runtime::ensure_local_aria2,
            runtime::get_runtime_defaults,
            mobile_http::mobile_http_start,
            mobile_http::mobile_http_status,
            mobile_http::mobile_http_pause,
            mobile_http::mobile_http_resume,
            mobile_http::mobile_http_cancel,
            mobile_files::share_downloaded_file,
            portable_profile::get_portable_profile,
            portable_profile::relocate_portable_profile,
            qbittorrent::qbittorrent_request,
            metadata_json_request,
            copymanga_login,
            jmcomic_bridge,
            feed_text_request,
            download_manga_images,
            write_text_file,
            create_cbz,
            cleanup_manga_temp,
            scan_game_installation,
            launch_game,
            backup_game_saves,
            list_organizable_files,
            scan_library_files,
            organize_file,
            open_directory,
            delete_download_files
        ])
        .build(context)
        .expect("error while building ACGN Hub");
    let on_event = |_: &tauri::AppHandle, event| match event {
            tauri::RunEvent::Ready => diagnostics::record("runtime.ready"),
            tauri::RunEvent::ExitRequested { code, .. } => {
                diagnostics::record(&format!("runtime.exit_requested code={code:?}"))
            }
            tauri::RunEvent::WindowEvent { label, event, .. } => match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    diagnostics::record(&format!("window.close_requested label={label}"))
                }
                tauri::WindowEvent::Destroyed => {
                    diagnostics::record(&format!("window.destroyed label={label}"))
                }
                _ => {}
            },
            tauri::RunEvent::Exit => {
                diagnostics::record("runtime.exit");
                runtime::stop_owned_aria2();
            }
            _ => {}
        };
    // Mobile uses Tauri's native Activity event loop. Its underlying tao::run
    // exits the process when the last Activity is destroyed; MainActivity's root
    // Back fallback moves the task to the background to preserve that lifecycle.
    #[cfg(mobile)]
    application.run(on_event);
    #[cfg(not(mobile))]
    {
    let exit_code = application.run_return(on_event);
    diagnostics::record(&format!("runtime.event_loop_returned code={exit_code}"));
    runtime::stop_owned_aria2();
    std::process::exit(exit_code);
    }
}

#[cfg(test)]
mod tests {
    use super::{create_cbz_impl as create_cbz, write_text_file_impl as write_text_file};

    const JPEG_BODY: &[u8] = b"\xff\xd8\xff\xe0image bytes";
    const PNG_BODY: &[u8] = b"\x89PNG\r\n\x1a\nimage bytes";

    #[test]
    fn manga_page_rejects_non_image_bodies_before_creating_files() {
        let root = temporary_root();
        for body in [
            b"".as_slice(),
            b"<!DOCTYPE html><html>Hotlink protection</html>".as_slice(),
            b"{\"error\":\"access denied\"}".as_slice(),
            b"Please verify you are human".as_slice(),
        ] {
            let error = super::save_manga_page(&root, 2, body).unwrap_err();
            assert!(error.contains("第 3 页响应不是受支持的图片"), "{error}");
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manga_page_uses_body_format_and_preserves_existing_page() {
        let root = temporary_root();
        // A CDN URL ending in .png can return JPEG; save_manga_page has no URL
        // or Content-Type input, so only the received bytes determine its name.
        let image = super::save_manga_page(&root, 0, JPEG_BODY).unwrap();
        assert_eq!(image.file_name().unwrap(), "page-0001.jpg");
        assert_eq!(std::fs::read(&image).unwrap(), JPEG_BODY);
        assert!(super::save_manga_page(&root, 0, b"\xff\xd8\xffreplacement").is_err());
        assert_eq!(std::fs::read(&image).unwrap(), JPEG_BODY);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn temporary_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "acgn-backend-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[cfg(unix)]
    fn directory_alias(target: &std::path::Path, alias: &std::path::Path) {
        std::os::unix::fs::symlink(target, alias).unwrap();
    }

    #[cfg(windows)]
    fn directory_alias(target: &std::path::Path, alias: &std::path::Path) {
        let result = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(dunce::simplified(alias).to_string_lossy().replace('/', "\\"))
            .arg(dunce::simplified(target).to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "Could not create test directory alias: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[cfg(unix)]
    fn remove_directory_alias(alias: &std::path::Path) {
        std::fs::remove_file(alias).unwrap();
    }

    #[cfg(windows)]
    fn remove_directory_alias(alias: &std::path::Path) {
        std::fs::remove_dir(alias).unwrap();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn organize_accepts_private_root_alias_and_rejects_outside_library_ancestor() {
        let root = temporary_root();
        let actual = root.join("actual-profile");
        let alias = root.join("profile-alias");
        let incoming = actual.join("Files/Incoming");
        let library = actual.join("Files/Library");
        std::fs::create_dir_all(&incoming).unwrap();
        std::fs::create_dir_all(&library).unwrap();
        directory_alias(&actual, &alias);
        let alias_incoming = alias.join("Files/Incoming");
        let alias_library = alias.join("Files/Library");
        let source = incoming.join("download.txt");
        std::fs::write(&source, "完整下载内容").unwrap();
        let canonical_source = std::fs::canonicalize(&source).unwrap();
        let destination = alias_library.join("Books/作品/第一卷.txt");
        let organized = super::organize_file_impl(
            "alias-test".into(),
            canonical_source.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
            alias_incoming.to_string_lossy().into_owned(),
            alias_library.to_string_lossy().into_owned(),
        ).unwrap();
        assert_eq!(organized.status, "moved");
        assert!(!source.exists());
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "完整下载内容");

        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let link = library.join("OutsideLink");
        directory_alias(&outside, &link);
        std::fs::write(&source, "保留源文件").unwrap();
        let result = super::organize_file_impl(
            "outside-test".into(),
            source.to_string_lossy().into_owned(),
            alias_library.join("OutsideLink/new-directory/book.txt").to_string_lossy().into_owned(),
            alias_incoming.to_string_lossy().into_owned(),
            alias_library.to_string_lossy().into_owned(),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "保留源文件");
        assert!(!outside.join("new-directory").exists());
        remove_directory_alias(&link);
        remove_directory_alias(&alias);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_novel_text_into_a_named_child_directory() {
        let root = std::env::temp_dir().join(format!(
            "acgn-hub-novel-write-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        let output = root.join("测试轻小说").join("第一卷.txt");
        let result = write_text_file(
            "测试正文\n".to_string(),
            root.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            std::fs::read_to_string(&output).expect("read text"),
            "测试正文\n"
        );
        std::fs::remove_dir_all(&root).expect("cleanup test files");
    }

    #[test]
    fn existing_novel_is_preserved_and_no_partial_is_left() {
        let root = temporary_root();
        let output = root.join("volume.txt");
        std::fs::write(&output, "original").unwrap();
        assert!(write_text_file(
            "replacement".into(),
            root.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned()
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "original");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cbz_publishes_complete_archive_and_cleans_only_owned_chapter() {
        let root = temporary_root();
        let incoming = root.join("Incoming");
        let source = incoming.join("chapter");
        let library = root.join("Library");
        let output = library.join("chapter.cbz");
        let source =
            crate::safe_fs::create_manga_temp(incoming.to_str().unwrap(), source.to_str().unwrap())
                .unwrap();
        let first = source.join("001.jpg");
        let second = source.join("002.png");
        std::fs::write(&first, JPEG_BODY).unwrap();
        std::fs::write(&second, PNG_BODY).unwrap();
        create_cbz(
            vec![
                second.to_string_lossy().into_owned(),
                first.to_string_lossy().into_owned(),
            ],
            output.to_string_lossy().into_owned(),
            source.to_string_lossy().into_owned(),
            incoming.to_string_lossy().into_owned(),
            library.to_string_lossy().into_owned(),
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        let mut first_body = Vec::new();
        std::io::Read::read_to_end(
            &mut archive.by_name("page-0001.jpg").unwrap(),
            &mut first_body,
        )
        .unwrap();
        assert_eq!(first_body, JPEG_BODY);
        assert!(archive.by_name("page-0002.png").is_ok());
        drop(archive);
        assert!(!source.exists());
        assert!(incoming.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cbz_conflict_preserves_existing_file_and_unconsumed_images() {
        let root = temporary_root();
        let incoming = root.join("Incoming");
        let source = incoming.join("chapter");
        let library = root.join("Library");
        let source =
            crate::safe_fs::create_manga_temp(incoming.to_str().unwrap(), source.to_str().unwrap())
                .unwrap();
        std::fs::create_dir(&library).unwrap();
        let output = library.join("chapter.cbz");
        std::fs::write(&output, b"existing archive").unwrap();
        let image = source.join("001.jpg");
        std::fs::write(&image, JPEG_BODY).unwrap();
        assert!(create_cbz(
            vec![image.to_string_lossy().into_owned()],
            output.to_string_lossy().into_owned(),
            source.to_string_lossy().into_owned(),
            incoming.to_string_lossy().into_owned(),
            library.to_string_lossy().into_owned()
        )
        .is_err());
        assert_eq!(std::fs::read(output).unwrap(), b"existing archive");
        assert!(image.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cbz_rejects_disguised_error_body_without_publishing_or_consuming_images() {
        let root = temporary_root();
        let incoming = root.join("Incoming");
        let source = incoming.join("chapter");
        let library = root.join("Library");
        let output = library.join("chapter.cbz");
        let source =
            crate::safe_fs::create_manga_temp(incoming.to_str().unwrap(), source.to_str().unwrap())
                .unwrap();
        let image = source.join("001.jpg");
        for body in [b"<html>Access denied</html>".as_slice(), b"".as_slice()] {
            std::fs::write(&image, body).unwrap();
            let result = create_cbz(
                vec![image.to_string_lossy().into_owned()],
                output.to_string_lossy().into_owned(),
                source.to_string_lossy().into_owned(),
                incoming.to_string_lossy().into_owned(),
                library.to_string_lossy().into_owned(),
            );
            assert!(result.unwrap_err().contains("CBZ 包含非图片正文"));
            assert!(!output.exists());
            assert!(image.exists());
            assert_eq!(std::fs::read_dir(&library).unwrap().count(), 0);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cbz_corrects_mislabelled_jpeg_and_accepts_avif_image_body() {
        let root = temporary_root();
        let incoming = root.join("Incoming");
        let source = incoming.join("chapter");
        let library = root.join("Library");
        let output = library.join("chapter.cbz");
        let source =
            crate::safe_fs::create_manga_temp(incoming.to_str().unwrap(), source.to_str().unwrap())
                .unwrap();
        let jpeg = source.join("001.png");
        let avif = source.join("002.avif");
        std::fs::write(&jpeg, JPEG_BODY).unwrap();
        let avif_body = b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00miafavif";
        std::fs::write(&avif, avif_body).unwrap();
        create_cbz(
            vec![
                avif.to_string_lossy().into_owned(),
                jpeg.to_string_lossy().into_owned(),
            ],
            output.to_string_lossy().into_owned(),
            source.to_string_lossy().into_owned(),
            incoming.to_string_lossy().into_owned(),
            library.to_string_lossy().into_owned(),
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        assert!(archive.by_name("page-0001.jpg").is_ok());
        assert!(archive.by_name("page-0001.png").is_err());
        assert!(archive.by_name("page-0002.avif").is_ok());
        drop(archive);
        assert!(!source.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cbz_packaging_and_sha256_fit_in_a_256_kib_thread_stack() {
        std::thread::Builder::new()
            .name("small-stack-cbz".into())
            .stack_size(256 * 1024)
            .spawn(|| {
                let root = temporary_root();
                let incoming = root.join("Incoming");
                let source = incoming.join("chapter");
                let library = root.join("Library");
                let output = library.join("small-stack.cbz");
                let source = crate::safe_fs::create_manga_temp(
                    incoming.to_str().unwrap(),
                    source.to_str().unwrap(),
                )
                .unwrap();
                let image = source.join("001.png");
                let mut body = PNG_BODY.to_vec();
                body.resize(200 * 1024, 42);
                std::fs::write(&image, body).unwrap();
                create_cbz(
                    vec![image.to_string_lossy().into_owned()],
                    output.to_string_lossy().into_owned(),
                    source.to_string_lossy().into_owned(),
                    incoming.to_string_lossy().into_owned(),
                    library.to_string_lossy().into_owned(),
                )
                .unwrap();
                let digest = super::sha256_file(&output).unwrap();
                assert_eq!(digest.len(), 64);
                let archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
                assert_eq!(archive.len(), 1);
                drop(archive);
                std::fs::remove_dir_all(root).unwrap();
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn game_backup_rejects_destination_inside_game_without_creating_it() {
        let root = temporary_root();
        let game = root.join("Game");
        std::fs::create_dir(&game).unwrap();
        std::fs::write(game.join("save.dat"), b"preserve").unwrap();
        let backup = game.join("Backups");
        let result = super::backup_game_saves_impl(
            game.to_string_lossy().into_owned(),
            vec![".".into()],
            backup.to_string_lossy().into_owned(),
            "backup".into(),
        );
        assert!(result.is_err());
        assert!(!backup.exists());
        assert_eq!(std::fs::read(game.join("save.dat")).unwrap(), b"preserve");
        std::fs::remove_dir_all(root).unwrap();
    }
}
