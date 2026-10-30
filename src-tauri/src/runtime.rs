use crate::safe_fs::{absolute_path, AtomicOutput};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use std::time::{Duration, Instant};
use tauri::Manager;

#[path = "bt_tracker_preflight.rs"]
mod bt_tracker_preflight;

const ARIA2_BYTES: &[u8] = include_bytes!("../resources/aria2c.exe");
pub const INTERNAL_ARIA2_ENDPOINT: &str = "http://127.0.0.1:16800/jsonrpc";
// aria2.shutdown itself schedules the halt 3 seconds later so the RPC response
// can be delivered (upstream RpcMethodImpl.cc). Leave time after that to flush
// control files and the DHT table instead of killing it at the scheduled halt.
const ARIA2_SHUTDOWN_GRACE: Duration = Duration::from_secs(6);
struct OwnedAria2 {
    child: Child,
    endpoint: String,
    secret: Option<String>,
    directory: PathBuf,
}
static ARIA2: OnceLock<std::sync::Mutex<Option<OwnedAria2>>> = OnceLock::new();
static STARTUP: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static DEFAULT_INCOMING: OnceLock<std::sync::Mutex<Option<PathBuf>>> = OnceLock::new();
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
fn owned_aria2() -> &'static std::sync::Mutex<Option<OwnedAria2>> {
    ARIA2.get_or_init(|| std::sync::Mutex::new(None))
}

/// A documented portable profile, covering the database, webview state and default files.
pub fn portable_data_directory() -> Result<Option<PathBuf>, String> {
    let Some(value) = std::env::var_os("ACGN_HUB_DATA_DIR") else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() || crate::safe_fs::has_parent_component(&path) {
        return Err("ACGN_HUB_DATA_DIR 必须是无 .. 片段的绝对路径".to_string());
    }
    Ok(Some(path))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDefaults {
    incoming_directory: String,
    library_directory: String,
    backup_directory: String,
    aria2_endpoint: String,
}

#[tauri::command]
pub fn get_runtime_defaults(app: tauri::AppHandle) -> Result<RuntimeDefaults, String> {
    let downloads = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|path| path.join("Downloads")))
        .map_err(|error| format!("无法定位用户下载目录：{error}"))?;
    let root = portable_data_directory()?
        .map(|profile| profile.join("Files"))
        .unwrap_or_else(|| downloads.join("ACGN"));
    let incoming = root.join("Incoming");
    *DEFAULT_INCOMING
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .map_err(|_| "下载默认目录状态不可用")? = Some(incoming.clone());
    Ok(RuntimeDefaults {
        incoming_directory: incoming.to_string_lossy().into_owned(),
        library_directory: root.join("Library").to_string_lossy().into_owned(),
        backup_directory: root.join("Backups").to_string_lossy().into_owned(),
        aria2_endpoint: INTERNAL_ARIA2_ENDPOINT.to_string(),
    })
}

pub fn local_endpoint(endpoint: &str, expected_path: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "本地服务地址无效".to_string())?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() == Some(0)
        || url.path().trim_end_matches('/') != expected_path.trim_end_matches('/')
    {
        return Err("本地服务必须使用不含认证信息的回环 HTTP 地址和标准 API 路径".to_string());
    }
    Ok(url)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("创建本地客户端失败：{error}"))
}

async fn post_rpc(
    client: &reqwest::Client,
    endpoint: &str,
    secret: Option<&str>,
    method: &str,
    params: &[Value],
) -> Result<Value, (bool, String)> {
    let mut rpc_params = Vec::with_capacity(params.len() + 1);
    if let Some(secret) = secret.filter(|value| !value.is_empty()) {
        rpc_params.push(Value::String(format!("token:{secret}")));
    }
    rpc_params.extend_from_slice(params);
    let mut response = client.post(endpoint).json(&serde_json::json!({"jsonrpc":"2.0","id":"acgn-hub","method":method,"params":rpc_params}))
        .send().await.map_err(|error| (error.is_connect(), format!("连接 aria2 失败：{error}")))?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| (false, format!("读取 aria2 RPC 响应失败：{error}")))?
    {
        if bytes.len().saturating_add(chunk.len()) > 4 * 1024 * 1024 {
            return Err((false, "aria2 RPC 响应超过 4 MB".to_string()));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = match serde_json::from_slice::<Value>(&bytes) {
        Ok(body) => body,
        Err(_) if !status.is_success() => return Err((false, format!("aria2 RPC HTTP {status}"))),
        Err(_) => return Err((false, "aria2 RPC 响应不是有效 JSON".to_string())),
    };
    // aria2 returns JSON-RPC errors such as missing GIDs and Unauthorized with HTTP 400.
    // Preserve the engine error so the download manager can distinguish a lost session.
    if let Some(error) = body.get("error") {
        if let Some(message) = error
            .get("message")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            let message = if let Some(secret) = secret.filter(|value| !value.is_empty()) {
                message.replace(secret, "[redacted]")
            } else {
                message.to_string()
            };
            let message = message
                .chars()
                .filter(|character| !character.is_control())
                .take(400)
                .collect::<String>();
            return Err((false, message));
        }
        if status.is_success() {
            return Err((false, "aria2 RPC 请求失败".to_string()));
        }
    }
    if !status.is_success() {
        return Err((false, format!("aria2 RPC HTTP {status}")));
    }
    body.get("result")
        .cloned()
        .ok_or((false, "aria2 RPC 响应缺少 result".to_string()))
}

fn validate_options(options: &Value, global: bool) -> Result<(), String> {
    let map = options.as_object().ok_or("aria2 选项必须是对象")?;
    if map.is_empty() || map.len() > 32 {
        return Err("aria2 选项数量无效".into());
    }
    for (name, value) in map {
        let allowed = matches!(
            name.as_str(),
            "max-download-limit"
                | "max-upload-limit"
                | "max-overall-download-limit"
                | "max-overall-upload-limit"
                | "max-concurrent-downloads"
        ) || (!global
            && matches!(
                name.as_str(),
                "dir"
                    | "out"
                    | "check-certificate"
                    | "user-agent"
                    | "max-tries"
                    | "retry-wait"
                    | "timeout"
                    | "connect-timeout"
                    | "max-connection-per-server"
                    | "split"
                    | "continue"
                    | "auto-file-renaming"
                    | "allow-overwrite"
                    | "follow-torrent"
                    | "seed-time"
                    | "bt-save-metadata"
                    | "bt-stop-timeout"
                    | "bt-max-peers"
                    | "bt-request-peer-speed-limit"
                    | "bt-tracker-connect-timeout"
                    | "bt-tracker-timeout"
                    | "bt-tracker"
                    | "bt-exclude-tracker"
            ));
        if !allowed || !value.is_string() {
            return Err(format!("不允许设置 aria2 选项：{name}"));
        }
        let value = value.as_str().unwrap();
        if name == "bt-tracker" && !bt_tracker_preflight::valid_tracker_options(value) {
            return Err("Tracker 选项必须是数量和长度受限的公共原来源地址".into());
        }
        if name == "bt-exclude-tracker" && value != "*" {
            return Err("Tracker 排序仅允许由原来源预检生成".into());
        }
        if name == "check-certificate" && value != "true" {
            return Err("不能关闭下载 HTTPS 证书验证".to_string());
        }
        if matches!(name.as_str(), "auto-file-renaming" | "allow-overwrite") && value != "false" {
            return Err("不能开启下载文件自动改名或覆盖".to_string());
        }
        let expected = match name.as_str() {
            "follow-torrent" => Some("mem"),
            "seed-time" => Some("0"),
            "bt-save-metadata" => Some("false"),
            "continue" => Some("true"),
            _ => None,
        };
        if expected.is_some_and(|expected| value != expected) {
            return Err(format!("aria2 下载选项 {name} 的值无效"));
        }
        let range = match name.as_str() {
            "max-download-limit"
            | "max-upload-limit"
            | "max-overall-download-limit"
            | "max-overall-upload-limit"
            | "bt-request-peer-speed-limit" => Some((0, 1024 * 1024 * 1024)),
            "max-concurrent-downloads" => Some((1, 20)),
            "bt-stop-timeout" => Some((0, 86_400)),
            "bt-max-peers" => Some((1, 200)),
            "bt-tracker-connect-timeout" | "bt-tracker-timeout" | "timeout" | "connect-timeout" => {
                Some((1, 600))
            }
            "max-tries" => Some((1, 20)),
            "retry-wait" => Some((0, 600)),
            "max-connection-per-server" | "split" => Some((1, 16)),
            _ => None,
        };
        if let Some((minimum, maximum)) = range {
            if value.is_empty()
                || !value.bytes().all(|byte| byte.is_ascii_digit())
                || value
                    .parse::<u64>()
                    .map_or(true, |number| number < minimum || number > maximum)
            {
                return Err(format!(
                    "aria2 选项 {name} 必须在 {minimum} 到 {maximum} 之间"
                ));
            }
        }
        if name == "user-agent"
            && (value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control))
        {
            return Err("aria2 User-Agent 无效".into());
        }
        if name == "dir" {
            absolute_path(value, "下载目录")?;
        }
        if name == "out"
            && (value.is_empty()
                || value.contains(['\\', '/', ':'])
                || value == "."
                || value == "..")
        {
            return Err("下载文件名无效".to_string());
        }
    }
    Ok(())
}

fn valid_gid(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        value.len() == 16 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn validate_change_options(options: &Value) -> Result<(), String> {
    validate_options(options, false)?;
    for name in options.as_object().unwrap().keys() {
        if !matches!(
            name.as_str(),
            "max-download-limit"
                | "max-upload-limit"
                | "bt-stop-timeout"
                | "bt-max-peers"
                | "bt-request-peer-speed-limit"
                | "bt-tracker-connect-timeout"
                | "bt-tracker-timeout"
                | "timeout"
                | "connect-timeout"
                | "max-tries"
                | "retry-wait"
                | "max-connection-per-server"
                | "split"
        ) {
            return Err(format!("不能修改运行中任务的 aria2 选项：{name}"));
        }
    }
    Ok(())
}

fn validate_status_keys(value: &Value) -> Result<(), String> {
    let keys = value.as_array().ok_or("aria2 状态字段必须是数组")?;
    if keys.len() > 40
        || keys.iter().any(|key| {
            key.as_str().map_or(true, |key| {
                key.is_empty()
                    || key.len() > 64
                    || !key.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        })
    {
        return Err("aria2 状态字段无效".into());
    }
    Ok(())
}

fn validate_rpc(method: &str, params: &[Value]) -> Result<(), String> {
    if !matches!(
        method,
        "aria2.addUri"
            | "aria2.changeGlobalOption"
            | "aria2.changeOption"
            | "aria2.getOption"
            | "aria2.getGlobalOption"
            | "aria2.getGlobalStat"
            | "aria2.getPeers"
            | "aria2.tellActive"
            | "aria2.tellWaiting"
            | "aria2.tellStopped"
            | "aria2.tellStatus"
            | "aria2.pause"
            | "aria2.unpause"
            | "aria2.forceRemove"
            | "aria2.getVersion"
    ) {
        return Err("不允许调用该 aria2 RPC 方法".to_string());
    }
    if method == "aria2.addUri" {
        if params.len() != 2 {
            return Err("aria2 下载参数数量无效".into());
        }
        let urls = params
            .first()
            .and_then(Value::as_array)
            .ok_or("下载链接缺失")?;
        if urls.is_empty() || urls.len() > 10 {
            return Err("下载链接数量无效".to_string());
        }
        for url in urls {
            let url = reqwest::Url::parse(url.as_str().ok_or("下载链接无效")?)
                .map_err(|_| "下载链接无效")?;
            if !matches!(url.scheme(), "http" | "https" | "magnet")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("aria2 仅支持无内嵌凭据的 HTTP、HTTPS 或有效磁力链接".to_string());
            }
            if url.scheme() == "magnet" {
                let valid_hash = url
                    .query_pairs()
                    .filter(|(name, _)| name.eq_ignore_ascii_case("xt"))
                    .any(|(_, value)| {
                        let Some(prefix) = value.get(..9) else {
                            return false;
                        };
                        if !prefix.eq_ignore_ascii_case("urn:btih:") {
                            return false;
                        }
                        let hash = &value[9..];
                        (hash.len() == 40 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
                            || (hash.len() == 32
                                && hash.bytes().all(|byte| {
                                    byte.is_ascii_alphabetic() || (b'2'..=b'7').contains(&byte)
                                }))
                    });
                if url.as_str().len() > 16_384
                    || url.host_str().is_some()
                    || !url.path().is_empty()
                    || !valid_hash
                {
                    return Err(
                        "磁力链接必须包含有效的 40 位十六进制或 32 位 Base32 BTIH 哈希".to_string(),
                    );
                }
            }
        }
        let options = params.get(1).ok_or("下载选项缺失")?;
        if options.get("bt-tracker").is_some() || options.get("bt-exclude-tracker").is_some() {
            // Only the native preflight may derive tracker ordering from the
            // fetched original metainfo; JS cannot submit arbitrary trackers.
            return Err("Tracker 排序由原种子预检控制，不能直接指定".into());
        }
        validate_options(options, false)?;
        if params
            .get(1)
            .and_then(|options| options.get("dir"))
            .and_then(Value::as_str)
            .is_none()
        {
            return Err("下载目录缺失".to_string());
        }
    }
    if method == "aria2.changeGlobalOption" {
        if params.len() != 1 {
            return Err("aria2 全局选项参数无效".into());
        }
        validate_options(params.first().ok_or("全局选项缺失")?, true)?;
    }
    if method == "aria2.changeOption" {
        if params.len() != 2 || !valid_gid(params.first()) {
            return Err("aria2 任务编号无效".into());
        }
        validate_change_options(params.get(1).ok_or("下载选项缺失")?)?;
    }
    if matches!(
        method,
        "aria2.getVersion" | "aria2.getGlobalStat" | "aria2.getGlobalOption"
    ) && !params.is_empty()
    {
        return Err("aria2 只读全局查询不接受参数".into());
    }
    if matches!(
        method,
        "aria2.getPeers"
            | "aria2.getOption"
            | "aria2.pause"
            | "aria2.unpause"
            | "aria2.forceRemove"
    ) && (params.len() != 1 || !valid_gid(params.first()))
    {
        return Err("aria2 任务编号无效".into());
    }
    if method == "aria2.tellStatus" {
        if !(1..=2).contains(&params.len()) || !valid_gid(params.first()) {
            return Err("aria2 任务查询参数无效".into());
        }
        if let Some(keys) = params.get(1) {
            validate_status_keys(keys)?;
        }
    }
    if method == "aria2.tellActive" {
        if params.len() > 1 {
            return Err("aria2 任务查询参数无效".into());
        }
        if let Some(keys) = params.first() {
            validate_status_keys(keys)?;
        }
    }
    if matches!(method, "aria2.tellWaiting" | "aria2.tellStopped") {
        if !(2..=3).contains(&params.len())
            || params[0].as_u64().map_or(true, |offset| offset > 1_000_000)
            || params[1].as_u64().map_or(true, |count| count > 200)
        {
            return Err("aria2 分页查询参数无效".into());
        }
        if let Some(keys) = params.get(2) {
            validate_status_keys(keys)?;
        }
    }
    Ok(())
}

fn diagnostic_result(method: &str, mut result: Value) -> Value {
    if matches!(method, "aria2.getOption" | "aria2.getGlobalOption") {
        if let Some(options) = result.as_object_mut() {
            options.retain(|name, _| {
                matches!(
                    name.as_str(),
                    "max-concurrent-downloads"
                        | "max-download-limit"
                        | "max-upload-limit"
                        | "max-overall-download-limit"
                        | "max-overall-upload-limit"
                        | "bt-stop-timeout"
                        | "bt-max-peers"
                        | "bt-request-peer-speed-limit"
                        | "bt-tracker-connect-timeout"
                        | "bt-tracker-timeout"
                        | "enable-dht"
                        | "enable-dht6"
                        | "enable-peer-exchange"
                        | "dht-entry-point"
                        | "dht-listen-port"
                        | "listen-port"
                        | "check-certificate"
                        | "bt-save-metadata"
                        | "bt-load-saved-metadata"
                        | "follow-torrent"
                        | "seed-time"
                        | "continue"
                        | "timeout"
                        | "connect-timeout"
                        | "max-tries"
                        | "retry-wait"
                        | "max-connection-per-server"
                        | "split"
                        | "dir"
                        | "out"
                )
            });
        }
    }
    result
}

fn managed_recovery_allowed(endpoint: &str, managed: bool, secret: Option<&str>) -> bool {
    managed && endpoint == INTERNAL_ARIA2_ENDPOINT && secret.is_some_and(|value| !value.is_empty())
}

fn validate_rpc_secret(secret: Option<&str>) -> Result<(), String> {
    if secret.is_some_and(|secret| secret.len() > 4096 || secret.chars().any(char::is_control)) {
        return Err("aria2 连接凭据无效或过长".into());
    }
    Ok(())
}

fn recovery_directory() -> Result<PathBuf, String> {
    if let Some(directory) = owned_aria2()
        .lock()
        .map_err(|_| "aria2 进程状态不可用")?
        .as_ref()
        .filter(|owned| owned.endpoint == INTERNAL_ARIA2_ENDPOINT)
        .map(|owned| owned.directory.clone())
    {
        return Ok(directory);
    }
    DEFAULT_INCOMING
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .map_err(|_| "下载默认目录状态不可用")?
        .clone()
        .ok_or_else(|| "内置下载引擎尚未初始化，请重新打开工作台后重试".into())
}

#[tauri::command]
pub async fn aria2_rpc(
    endpoint: String,
    secret: Option<String>,
    method: String,
    mut params: Vec<Value>,
    managed: Option<bool>,
) -> Result<Value, String> {
    local_endpoint(&endpoint, "/jsonrpc")?;
    validate_rpc_secret(secret.as_deref())?;
    validate_rpc(&method, &params)?;
    if method == "aria2.addUri"
        && managed_recovery_allowed(&endpoint, managed.unwrap_or(false), secret.as_deref())
        && bt_tracker_preflight::prioritize_mikan(&mut params).await
    {
        validate_options(&params[1], false)?;
    }
    let client = client()?;
    match post_rpc(&client, &endpoint, secret.as_deref(), &method, &params).await {
        Ok(result) => Ok(diagnostic_result(&method, result)),
        Err((true, _))
            if managed_recovery_allowed(&endpoint, managed.unwrap_or(false), secret.as_deref()) =>
        {
            let directory = if method == "aria2.addUri" {
                absolute_path(params[1]["dir"].as_str().ok_or("下载目录缺失")?, "下载目录")?
            } else {
                recovery_directory()?
            };
            crate::diagnostics::record("aria2.managed_rpc.recover_connection");
            ensure_local_aria2(
                endpoint.clone(),
                secret.clone(),
                directory.to_string_lossy().into_owned(),
            )
            .await?;
            post_rpc(&client, &endpoint, secret.as_deref(), &method, &params)
                .await
                .map(|result| diagnostic_result(&method, result))
                .map_err(|(_, error)| error)
        }
        Err((_, error)) => Err(error),
    }
}

#[tauri::command]
pub async fn ensure_local_aria2(
    endpoint: String,
    secret: Option<String>,
    directory: String,
) -> Result<(), String> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err("应用正在退出，下载引擎不会重新启动".into());
    }
    let endpoint_url = local_endpoint(&endpoint, "/jsonrpc")?;
    validate_rpc_secret(secret.as_deref())?;
    let directory = absolute_path(&directory, "下载目录")?;
    let _startup = STARTUP
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err("应用正在退出，下载引擎不会重新启动".into());
    }
    {
        let mut owned = owned_aria2().lock().map_err(|_| "aria2 进程状态不可用")?;
        if let Some(owned_child) = owned.as_mut() {
            if owned_child
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                *owned = None;
            }
        }
    }
    let client = client()?;
    match post_rpc(
        &client,
        &endpoint,
        secret.as_deref(),
        "aria2.getVersion",
        &[],
    )
    .await
    {
        Ok(result) if result.get("version").and_then(Value::as_str).is_some() => return Ok(()),
        Ok(_) => return Err("RPC 端口未返回有效 aria2 版本，拒绝接管".to_string()),
        Err((false, error)) => {
            return Err(format!(
                "RPC 端口已响应但不可用，请检查地址和 Secret：{error}"
            ))
        }
        Err((true, _)) => {}
    }
    if owned_aria2()
        .lock()
        .map_err(|_| "aria2 进程状态不可用")?
        .is_some()
    {
        return Err("应用管理的 aria2 正在另一端口运行，请重启应用后切换地址".to_string());
    }
    std::fs::create_dir_all(&directory).map_err(|error| format!("创建下载目录失败：{error}"))?;
    let dht_directory = runtime_directory()?.join("aria2-state");
    std::fs::create_dir_all(&dht_directory)
        .map_err(|error| format!("创建 DHT 缓存目录失败：{error}"))?;
    let mut command = Command::new(materialize_aria2()?);
    command.args(owned_startup_arguments(
        &endpoint_url,
        &directory,
        &dht_directory,
    ));
    if let Some(secret) = secret.as_deref().filter(|value| !value.is_empty()) {
        command.arg(format!("--rpc-secret={secret}"));
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动 aria2 失败：{error}"))?;
    {
        let mut owned = owned_aria2().lock().map_err(|_| "aria2 进程状态不可用")?;
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("应用正在退出，下载引擎不会重新启动".into());
        }
        *owned = Some(OwnedAria2 {
            child,
            endpoint: endpoint.clone(),
            secret: secret.clone(),
            directory,
        });
    }
    let readiness = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| error.to_string())?;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        {
            let mut owned = owned_aria2().lock().map_err(|_| "aria2 进程状态不可用")?;
            let owned_child = owned.as_mut().ok_or("aria2 已随应用退出而停止")?;
            if let Some(status) = owned_child
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
            {
                *owned = None;
                return Err(format!("aria2 启动后退出：{status}"));
            }
        }
        if let Ok(result) = post_rpc(
            &readiness,
            &endpoint,
            secret.as_deref(),
            "aria2.getVersion",
            &[],
        )
        .await
        {
            if result.get("version").and_then(Value::as_str).is_some() {
                return Ok(());
            }
        }
    }
    stop_owned_aria2_impl(false);
    Err("aria2 启动后未就绪，请检查端口占用和防火墙".to_string())
}

fn runtime_directory() -> Result<PathBuf, String> {
    let root = portable_data_directory()?
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .or_else(|| std::env::var_os("TEMP"))
                .map(PathBuf::from)
        })
        .unwrap_or_else(std::env::temp_dir);
    Ok(root.join("ACGN Hub").join("runtime"))
}

fn owned_startup_arguments(
    endpoint: &reqwest::Url,
    directory: &Path,
    dht_directory: &Path,
) -> Vec<String> {
    vec![
        "--no-conf=true".into(),
        "--enable-rpc=true".into(),
        "--rpc-listen-all=false".into(),
        "--rpc-allow-origin-all=false".into(),
        format!("--stop-with-process={}", std::process::id()),
        format!(
            "--rpc-listen-port={}",
            endpoint.port_or_known_default().unwrap()
        ),
        format!("--dir={}", directory.display()),
        "--max-connection-per-server=8".into(),
        "--file-allocation=none".into(),
        "--continue=true".into(),
        "--auto-save-interval=1".into(),
        "--check-certificate=true".into(),
        "--auto-file-renaming=false".into(),
        "--allow-overwrite=false".into(),
        "--max-concurrent-downloads=3".into(),
        "--bt-stop-timeout=0".into(),
        "--enable-dht=true".into(),
        "--enable-peer-exchange=true".into(),
        // A single established public DHT bootstrap, never an unreviewed tracker list.
        "--dht-entry-point=dht.transmissionbt.com:6881".into(),
        format!(
            "--dht-file-path={}",
            dht_directory.join("dht.dat").display()
        ),
        format!(
            "--dht-file-path6={}",
            dht_directory.join("dht6.dat").display()
        ),
    ]
}

fn materialize_aria2() -> Result<PathBuf, String> {
    let directory = runtime_directory()?;
    let digest = format!("{:x}", Sha256::digest(ARIA2_BYTES));
    let path = directory.join(format!("aria2c-1.37.0-{}.exe", &digest[..16]));
    if let Ok(bytes) = std::fs::read(&path) {
        if Sha256::digest(&bytes) == Sha256::digest(ARIA2_BYTES) {
            return Ok(path);
        }
        return Err("内置 aria2 文件校验失败，请移除损坏的运行时文件后重试".to_string());
    }
    std::fs::create_dir_all(directory).map_err(|error| format!("创建运行时目录失败：{error}"))?;
    let mut output = AtomicOutput::new(path.clone())?;
    let mut file = output.take_file();
    file.write_all(ARIA2_BYTES)
        .map_err(|error| format!("写入 aria2 失败：{error}"))?;
    output.publish(file)?;
    Ok(path)
}

pub fn stop_owned_aria2() {
    stop_owned_aria2_impl(true);
}

fn stop_owned_aria2_impl(final_shutdown: bool) {
    if final_shutdown {
        SHUTTING_DOWN.store(true, Ordering::SeqCst);
    }
    if let Some(state) = ARIA2.get() {
        let owned = state.lock().ok().and_then(|mut state| state.take());
        if let Some(mut owned) = owned {
            if matches!(owned.child.try_wait(), Ok(Some(_))) {
                return;
            }
            // No async runtime/block_on here: this is also called from Tauri's
            // synchronous exit callback. Only the recorded, owned local child
            // receives shutdown; raw requests/credentials are never logged.
            crate::diagnostics::record("aria2.owned_shutdown.begin");
            let _ = request_owned_shutdown(
                &owned.endpoint,
                owned.secret.as_deref(),
                Duration::from_millis(350),
            );
            let deadline = Instant::now() + ARIA2_SHUTDOWN_GRACE;
            loop {
                match owned.child.try_wait() {
                    Ok(Some(_)) => {
                        crate::diagnostics::record("aria2.owned_shutdown.graceful");
                        return;
                    }
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(40))
                    }
                    _ => break,
                }
            }
            crate::diagnostics::record("aria2.owned_shutdown.force_owned_child");
            let _ = owned.child.kill();
            let _ = owned.child.wait();
        }
    }
}

fn request_owned_shutdown(
    endpoint: &str,
    secret: Option<&str>,
    timeout: Duration,
) -> Result<(), String> {
    let url = local_endpoint(endpoint, "/jsonrpc")?;
    let ip = if url.host_str() == Some("[::1]") {
        "::1"
    } else {
        "127.0.0.1"
    };
    let address = SocketAddr::new(ip.parse().unwrap(), url.port_or_known_default().unwrap());
    let mut stream =
        TcpStream::connect_timeout(&address, timeout).map_err(|_| "内置引擎关闭连接不可用")?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|_| "内置引擎关闭写入超时设置失败")?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|_| "内置引擎关闭读取超时设置失败")?;
    let params: Vec<String> = secret
        .filter(|secret| !secret.is_empty())
        .map(|secret| vec![format!("token:{secret}")])
        .unwrap_or_default();
    let body = serde_json::json!({"jsonrpc":"2.0", "id":"acgn-hub-owned-shutdown", "method":"aria2.shutdown", "params":params}).to_string();
    let request = format!("POST /jsonrpc HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", address, body.len(), body);
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "内置引擎关闭请求失败")?;
    let mut response = [0_u8; 512];
    let count = stream
        .read(&mut response)
        .map_err(|_| "内置引擎关闭响应不可用")?;
    if count == 0 || !response[..count].starts_with(b"HTTP/1.1 200") {
        return Err("内置引擎未确认关闭".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    async fn fake_rpc_error(status: &str, body: String, secret: Option<&str>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/jsonrpc", listener.local_addr().unwrap());
        let status = status.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let error = post_rpc(
            &client().unwrap(),
            &endpoint,
            secret,
            "aria2.tellStatus",
            &[Value::String("0123456789abcdef".into())],
        )
        .await
        .unwrap_err();
        server.join().unwrap();
        assert!(!error.0);
        error.1
    }

    #[tokio::test]
    async fn http_400_preserves_missing_gid_for_download_recovery() {
        let error = fake_rpc_error("400 Bad Request", serde_json::json!({"jsonrpc":"2.0","id":"acgn-hub","error":{"code":1,"message":"GID 0123456789abcdef is not found"}}).to_string(), None).await;
        assert_eq!(error, "GID 0123456789abcdef is not found");
    }

    #[tokio::test]
    async fn rpc_error_preserves_unauthorized_but_redacts_secrets_and_controls() {
        let error = fake_rpc_error(
            "400 Bad Request",
            serde_json::json!({"error":{"message":"Unauthorized token:example-secret\r\n"}})
                .to_string(),
            Some("example-secret"),
        )
        .await;
        assert_eq!(error, "Unauthorized token:[redacted]");
    }

    #[tokio::test]
    async fn http_error_without_valid_rpc_error_falls_back_to_status() {
        let error = fake_rpc_error("502 Bad Gateway", "not json".into(), None).await;
        assert_eq!(error, "aria2 RPC HTTP 502 Bad Gateway");
    }
    #[test]
    fn local_endpoint_rejects_redirectable_or_remote_addresses() {
        for url in [
            "https://localhost:6800/jsonrpc",
            "http://example.com/jsonrpc",
            "http://user@localhost/jsonrpc",
            "http://localhost/jsonrpc?target=x",
            "http://localhost/other",
        ] {
            assert!(local_endpoint(url, "/jsonrpc").is_err(), "{url}");
        }
        assert!(local_endpoint(INTERNAL_ARIA2_ENDPOINT, "/jsonrpc").is_ok());
    }
    #[test]
    fn rpc_rejects_hooks_and_disabled_tls() {
        assert!(validate_rpc(
            "aria2.changeGlobalOption",
            &[serde_json::json!({"on-download-complete":"cmd.exe"})]
        )
        .is_err());
        assert!(
            validate_options(&serde_json::json!({"check-certificate":"false"}), false).is_err()
        );
        assert!(validate_rpc("aria2.addTorrent", &[]).is_err());
    }
    #[test]
    fn complete_frontend_download_options_are_accepted_without_overwriting() {
        let directory = std::env::temp_dir().join("acgn-contract");
        let options = serde_json::json!({
            "dir": directory.to_string_lossy(), "out":"example.zip", "check-certificate":"true",
            "user-agent":"ACGN-Hub/0.2", "continue":"true", "auto-file-renaming":"false", "allow-overwrite":"false",
            "max-tries":"5", "retry-wait":"3", "timeout":"60", "connect-timeout":"15", "max-download-limit":"1024"
        });
        assert!(validate_rpc(
            "aria2.addUri",
            &[
                serde_json::json!(["https://example.org/example.zip"]),
                options
            ]
        )
        .is_ok());
        assert!(validate_options(&serde_json::json!({"allow-overwrite":"true"}), false).is_err());
        assert!(
            validate_options(&serde_json::json!({"auto-file-renaming":"true"}), false).is_err()
        );
    }

    #[test]
    fn bt_options_and_magnet_hashes_are_strictly_validated() {
        let directory = std::env::temp_dir();
        let options = serde_json::json!({"dir":directory.to_string_lossy(), "follow-torrent":"mem", "seed-time":"0", "bt-save-metadata":"false", "bt-stop-timeout":"0"});
        for uri in [
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            "magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
            "https://example.org/file.torrent",
        ] {
            assert!(
                validate_rpc("aria2.addUri", &[serde_json::json!([uri]), options.clone()]).is_ok(),
                "{uri}"
            );
        }
        for uri in [
            "magnet:?dn=missing-hash",
            "magnet:?xt=urn:btih:short",
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef0123456!",
            "file:///C:/example.torrent",
        ] {
            assert!(
                validate_rpc("aria2.addUri", &[serde_json::json!([uri]), options.clone()]).is_err(),
                "{uri}"
            );
        }
        for option in [
            serde_json::json!({"seed-time":"60"}),
            serde_json::json!({"follow-torrent":"true"}),
            serde_json::json!({"bt-save-metadata":"true"}),
            serde_json::json!({"bt-stop-timeout":"-1"}),
            serde_json::json!({"bt-stop-timeout":"86401"}),
        ] {
            assert!(validate_options(&option, false).is_err());
        }
    }

    #[test]
    fn transfer_settings_are_numeric_bounded_and_can_clear_rate_limits() {
        for options in [
            serde_json::json!({"max-concurrent-downloads":"1", "max-overall-download-limit":"0"}),
            serde_json::json!({"max-concurrent-downloads":"20", "max-overall-upload-limit":"1073741824"}),
        ] {
            assert!(validate_options(&options, true).is_ok());
        }
        assert!(validate_change_options(&serde_json::json!({"max-download-limit":"0", "max-upload-limit":"1024", "bt-stop-timeout":"0"})).is_ok());
        for options in [
            serde_json::json!({"max-concurrent-downloads":"0"}),
            serde_json::json!({"max-concurrent-downloads":"21"}),
            serde_json::json!({"max-download-limit":"1073741825"}),
            serde_json::json!({"max-download-limit":"-1"}),
            serde_json::json!({"max-download-limit":"1M"}),
            serde_json::json!({"max-download-limit":1024}),
            serde_json::json!({"max-download-limit":"1\n"}),
        ] {
            assert!(validate_options(&options, true).is_err(), "{options}");
        }
        for options in [
            serde_json::json!({"dir":std::env::temp_dir().to_string_lossy()}),
            serde_json::json!({"bt-tracker":"https://example.com/announce"}),
            serde_json::json!({"on-download-complete":"cmd.exe"}),
            serde_json::json!({"check-certificate":"false"}),
            serde_json::json!({"allow-overwrite":"true"}),
        ] {
            assert!(validate_change_options(&options).is_err(), "{options}");
        }
    }

    #[test]
    fn managed_recovery_requires_explicit_mode_exact_endpoint_and_credentials() {
        assert!(managed_recovery_allowed(
            INTERNAL_ARIA2_ENDPOINT,
            true,
            Some("session-secret")
        ));
        for endpoint in [
            "http://localhost:16800/jsonrpc",
            "http://127.0.0.1:6800/jsonrpc",
            "http://127.0.0.1:16800/jsonrpc/",
        ] {
            assert!(!managed_recovery_allowed(
                endpoint,
                true,
                Some("session-secret")
            ));
        }
        assert!(!managed_recovery_allowed(
            INTERNAL_ARIA2_ENDPOINT,
            false,
            Some("session-secret")
        ));
        assert!(!managed_recovery_allowed(
            INTERNAL_ARIA2_ENDPOINT,
            true,
            None
        ));
        assert!(!managed_recovery_allowed(
            INTERNAL_ARIA2_ENDPOINT,
            true,
            Some("")
        ));
        assert!(validate_rpc_secret(Some("session-secret")).is_ok());
        assert!(validate_rpc_secret(Some("bad\nsecret")).is_err());
        assert!(validate_rpc_secret(Some(&"x".repeat(4097))).is_err());
    }

    #[test]
    fn owned_startup_isolated_from_host_configuration_and_bootstraps_dht() {
        let root = std::env::temp_dir().join("acgn-owned-runtime-contract");
        let incoming = root.join("Incoming");
        let state = root.join("Runtime").join("aria2-state");
        let args = owned_startup_arguments(
            &reqwest::Url::parse(INTERNAL_ARIA2_ENDPOINT).unwrap(),
            &incoming,
            &state,
        );
        for expected in [
            "--no-conf=true",
            "--bt-stop-timeout=0",
            "--enable-dht=true",
            "--enable-peer-exchange=true",
            "--check-certificate=true",
            "--allow-overwrite=false",
            "--auto-file-renaming=false",
            "--rpc-listen-all=false",
            "--rpc-allow-origin-all=false",
            "--dht-entry-point=dht.transmissionbt.com:6881",
        ] {
            assert!(args.iter().any(|arg| arg == expected), "{expected}");
        }
        assert!(args.contains(&format!(
            "--dht-file-path={}",
            state.join("dht.dat").display()
        )));
        assert!(args.contains(&format!(
            "--dht-file-path6={}",
            state.join("dht6.dat").display()
        )));
        assert!(!args
            .iter()
            .any(|arg| arg.starts_with("--bt-tracker=") || arg.starts_with("--rpc-secret=")));
        assert!(
            !root.exists(),
            "Argument construction must not create user directories"
        );
    }

    #[test]
    fn readonly_diagnostics_and_task_controls_require_valid_arguments() {
        let gid = serde_json::json!("0123456789abcdef");
        for method in [
            "aria2.getPeers",
            "aria2.getOption",
            "aria2.pause",
            "aria2.unpause",
            "aria2.forceRemove",
        ] {
            assert!(validate_rpc(method, &[gid.clone()]).is_ok(), "{method}");
            assert!(
                validate_rpc(method, &[serde_json::json!("invalid")]).is_err(),
                "{method}"
            );
            assert!(validate_rpc(method, &[]).is_err(), "{method}");
        }
        for method in [
            "aria2.getGlobalStat",
            "aria2.getGlobalOption",
            "aria2.getVersion",
        ] {
            assert!(validate_rpc(method, &[]).is_ok());
            assert!(validate_rpc(method, &[gid.clone()]).is_err());
        }
        assert!(validate_rpc(
            "aria2.tellStatus",
            &[
                gid.clone(),
                serde_json::json!(["connections", "numSeeders", "bittorrent", "infoHash"])
            ]
        )
        .is_ok());
        assert!(validate_rpc(
            "aria2.changeOption",
            &[gid, serde_json::json!({"max-download-limit":"0"})]
        )
        .is_ok());
        assert!(validate_rpc(
            "aria2.tellStopped",
            &[serde_json::json!(0), serde_json::json!(201)]
        )
        .is_err());
        assert!(validate_rpc(
            "aria2.tellStatus",
            &[
                serde_json::json!("0123456789abcdef"),
                serde_json::json!(["bad\nfield"])
            ]
        )
        .is_err());
        assert!(validate_rpc("aria2.shutdown", &[]).is_err());
        assert!(validate_rpc("aria2.forceShutdown", &[]).is_err());
    }

    #[test]
    fn diagnostic_options_never_expose_credentials_or_hook_commands() {
        let raw = serde_json::json!({"rpc-secret":"private", "all-proxy-passwd":"proxy-private", "http-user":"private-user", "on-download-complete":"private-command", "max-download-limit":"0", "enable-dht":"true", "bt-stop-timeout":"0"});
        let expected = serde_json::json!({"max-download-limit":"0", "enable-dht":"true", "bt-stop-timeout":"0"});
        assert_eq!(diagnostic_result("aria2.getOption", raw.clone()), expected);
        assert_eq!(diagnostic_result("aria2.getGlobalOption", raw), expected);
    }

    #[test]
    fn original_tracker_preflight_options_are_internal_initial_options_only() {
        let prepared = serde_json::json!({"bt-tracker":"https://first.example/announce,udp://fallback.example:6969/announce", "bt-exclude-tracker":"*", "bt-tracker-connect-timeout":"5", "bt-tracker-timeout":"10"});
        assert!(validate_options(&prepared, false).is_ok());
        assert!(validate_options(&prepared, true).is_err());
        assert!(validate_change_options(&prepared).is_err());
        let mut direct = prepared;
        direct["dir"] = serde_json::json!(std::env::temp_dir().to_string_lossy());
        assert!(validate_rpc("aria2.addUri", &[serde_json::json!(["https://mikanani.me/Download/20261007/0123456789abcdef0123456789abcdef01234567.torrent"]), direct]).is_err());
        for value in [
            "http://127.0.0.1/announce",
            "udp://127.1:6969/announce",
            "https://user:pass@example.com/announce",
            "https://localhost./announce",
            "https://first.example/announce\n",
            "",
        ] {
            assert!(
                validate_options(&serde_json::json!({"bt-tracker":value}), false).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn graceful_shutdown_uses_only_local_rpc_with_recorded_token() {
        assert!(ARIA2_SHUTDOWN_GRACE > Duration::from_secs(3));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/jsonrpc", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 1024];
            let payload = loop {
                let size = stream.read(&mut buffer).unwrap();
                assert!(size > 0 && bytes.len() + size <= 8192);
                bytes.extend_from_slice(&buffer[..size]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    assert!(headers.starts_with("POST /jsonrpc HTTP/1.1\r\n"));
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("Content-Length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length])
                            .unwrap();
                    }
                }
            };
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            payload
        });
        request_owned_shutdown(&endpoint, Some("owned-test-token"), Duration::from_secs(1))
            .unwrap();
        let payload = server.join().unwrap();
        assert_eq!(payload["method"], "aria2.shutdown");
        assert_eq!(
            payload["params"],
            serde_json::json!(["token:owned-test-token"])
        );
        assert!(request_owned_shutdown(
            "http://example.org/jsonrpc",
            None,
            Duration::from_millis(1)
        )
        .is_err());
    }

    #[tokio::test]
    async fn embedded_aria2_accepts_magnet_and_follows_local_torrent_without_public_peers() {
        struct Engine {
            process: Child,
            directory: PathBuf,
        }
        impl Drop for Engine {
            fn drop(&mut self) {
                let _ = self.process.kill();
                let _ = self.process.wait();
                let _ = std::fs::remove_dir_all(&self.directory);
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "acgn-bt-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/aria2c.exe");
        let mut command = Command::new(executable);
        command
            .args([
                "--enable-rpc=true",
                "--rpc-listen-all=false",
                "--enable-dht=false",
                "--enable-dht6=false",
                "--enable-peer-exchange=false",
                "--bt-enable-lpd=false",
                "--seed-time=0",
                "--console-log-level=error",
            ])
            .arg(format!("--rpc-listen-port={port}"))
            .arg(format!("--dir={}", directory.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let engine = Engine {
            process: command.spawn().unwrap(),
            directory: directory.clone(),
        };
        let endpoint = format!("http://127.0.0.1:{port}/jsonrpc");
        let client = client().unwrap();
        let mut ready = false;
        for _ in 0..30 {
            if post_rpc(&client, &endpoint, None, "aria2.getVersion", &[])
                .await
                .is_ok()
            {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(ready, "isolated aria2 did not start");
        let options = serde_json::json!({"dir":directory.to_string_lossy(), "follow-torrent":"mem", "seed-time":"0", "bt-save-metadata":"false", "bt-stop-timeout":"120", "allow-overwrite":"false", "auto-file-renaming":"false"});
        let magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
        let magnet_params = vec![serde_json::json!([magnet]), options.clone()];
        validate_rpc("aria2.addUri", &magnet_params).unwrap();
        let magnet_gid = post_rpc(&client, &endpoint, None, "aria2.addUri", &magnet_params)
            .await
            .unwrap();
        assert_eq!(magnet_gid.as_str().unwrap().len(), 16);
        let _ = post_rpc(
            &client,
            &endpoint,
            None,
            "aria2.forceRemove",
            std::slice::from_ref(&magnet_gid),
        )
        .await;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let torrent_url = format!("http://{}/fixture.torrent", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut torrent =
                b"d4:infod6:lengthi1e4:name9:empty.txt12:piece lengthi16384e6:pieces20:".to_vec();
            torrent.extend_from_slice(&[
                0x11, 0xf6, 0xad, 0x8e, 0xc5, 0x2a, 0x29, 0x84, 0xab, 0xaa, 0xfd, 0x7c, 0x3b, 0x51,
                0x65, 0x03, 0x78, 0x5c, 0x20, 0x72,
            ]);
            torrent.extend_from_slice(b"7:privatei1eee");
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/x-bittorrent\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", torrent.len()).unwrap();
            stream.write_all(&torrent).unwrap();
        });
        let torrent_params = vec![serde_json::json!([torrent_url]), options];
        validate_rpc("aria2.addUri", &torrent_params).unwrap();
        let parent_gid = post_rpc(&client, &endpoint, None, "aria2.addUri", &torrent_params)
            .await
            .unwrap();
        let mut child = None;
        for _ in 0..50 {
            let status = post_rpc(
                &client,
                &endpoint,
                None,
                "aria2.tellStatus",
                &[
                    parent_gid.clone(),
                    serde_json::json!(["status", "followedBy", "errorMessage"]),
                ],
            )
            .await
            .unwrap();
            if let Some(gid) = status
                .get("followedBy")
                .and_then(Value::as_array)
                .and_then(|values| values.first())
                .and_then(Value::as_str)
            {
                child = Some(gid.to_string());
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let child = child.expect("torrent URL did not produce a followedBy child GID");
        let status = post_rpc(
            &client,
            &endpoint,
            None,
            "aria2.tellStatus",
            &[
                Value::String(child),
                serde_json::json!(["status", "totalLength", "files"]),
            ],
        )
        .await
        .unwrap();
        assert_eq!(status.get("totalLength").and_then(Value::as_str), Some("1"));
        assert!(status
            .get("files")
            .and_then(Value::as_array)
            .is_some_and(|files| !files.is_empty()));
        server.join().unwrap();
        drop(engine);
    }
}
