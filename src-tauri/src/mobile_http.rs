//! Foreground HTTP downloads for Android. Records and partial files stay in the
//! app's private Files area; an interrupted process is restored as paused.
use crate::{network, safe_fs};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
#[cfg(not(unix))]
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MAX_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_ACTIVE: usize = 3;
static NONCE: AtomicU64 = AtomicU64::new(0);
static TASKS: OnceLock<Mutex<HashMap<String, Arc<Task>>>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    engine_task_id: String,
    filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    directory: Option<String>,
    state: String,
    total_bytes: u64,
    completed_bytes: u64,
    speed_bytes_per_second: u64,
    files: Vec<String>,
    stage: String,
    connections: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    id: String,
    url: String,
    directory: String,
    filename: String,
    headers: HashMap<String, String>,
    speed_limit: u64,
    etag: Option<String>,
    last_modified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    publication_identity: Option<PublicationIdentity>,
    status: Status,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationIdentity {
    device: u64,
    inode: u64,
    size: u64,
}

struct Task {
    root: PathBuf,
    record: Mutex<Record>,
    // 0: running, 1: pause requested, 2: cancel requested.
    control: AtomicU8,
    running: AtomicBool,
    changed: tokio::sync::Notify,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Task>>> {
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn private_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if !cfg!(mobile) {
        return Err("原生前台 HTTP 引擎用于安卓端，Windows 请使用内置下载引擎".into());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("files")
        .join("Files");
    fs::create_dir_all(root.join(".http-tasks"))
        .map_err(|error| format!("创建下载控制目录失败：{error}"))?;
    fs::canonicalize(&root).map_err(|error| format!("校验应用下载目录失败：{error}"))?;
    // Keep the native-declared spelling too: /data/user/0 can alias /data/data.
    // destination() accepts only this trusted root or its canonical spelling.
    Ok(root)
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("安卓下载任务编号无效".into());
    }
    Ok(())
}

fn valid_filename(name: &str) -> Result<(), String> {
    if name.trim().is_empty()
        || name.len() > 220
        || matches!(name, "." | "..")
        || name.chars().any(|value| {
            value.is_control()
                || matches!(value, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        || name.starts_with('.')
        || name.ends_with([' ', '.'])
    {
        return Err("下载文件名无效，请使用不含目录分隔符的文件名".into());
    }
    Ok(())
}

fn destination(root: &Path, record: &Record) -> Result<PathBuf, String> {
    valid_filename(&record.filename)?;
    let directory = crate::mobile_files::checked_private_path(
        root,
        &record.directory,
        "安卓下载目录",
        true,
    )?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let ancestor = safe_fs::canonical_existing_ancestor(&directory)?;
    if !safe_fs::is_path_within(&root, &ancestor) {
        return Err("下载目录越出应用私有目录".into());
    }
    fs::create_dir_all(&directory).map_err(|error| format!("创建下载目录失败：{error}"))?;
    let directory = fs::canonicalize(directory).map_err(|error| error.to_string())?;
    if !safe_fs::is_path_within(&root, &directory) {
        return Err("下载目录越出应用私有目录".into());
    }
    Ok(directory.join(&record.filename))
}

fn normalize_record_destination(root: &Path, record: &mut Record) -> Result<PathBuf, String> {
    let target = destination(root, record)?;
    record.directory = target
        .parent()
        .ok_or("下载文件缺少父目录")?
        .to_string_lossy()
        .into_owned();
    record.status.directory = Some(record.directory.clone());
    Ok(target)
}

fn record_path(root: &Path, id: &str) -> PathBuf {
    root.join(".http-tasks").join(format!("{id}.json"))
}
fn partial_path(root: &Path, id: &str) -> PathBuf {
    root.join(".http-tasks").join(format!("{id}.part"))
}

fn persist(root: &Path, record: &Record) -> Result<(), String> {
    let path = record_path(root, &record.id);
    if fs::symlink_metadata(&path)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("下载控制文件不是普通文件".into());
    }
    let temporary = root.join(".http-tasks").join(format!(
        ".{}-{}-{}.tmp",
        record.id,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, record).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        replace_record_file(&temporary, &path).map_err(|error| format!("保存下载进度失败：{error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_record_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace_record_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0x9) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn same_published_file(part: &Path, target: &Path) -> Result<bool, String> {
    let left = fs::symlink_metadata(part).map_err(|error| error.to_string())?;
    let right = fs::symlink_metadata(target).map_err(|error| error.to_string())?;
    if !left.is_file()
        || !right.is_file()
        || left.file_type().is_symlink()
        || right.file_type().is_symlink()
        || left.len() != right.len()
    {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Legacy hard-link publications may leave two names for one inode.
        return Ok(left.dev() == right.dev() && left.ino() == right.ino());
    }
    #[cfg(not(unix))]
    {
        let mut left = fs::File::open(part).map_err(|error| error.to_string())?;
        let mut right = fs::File::open(target).map_err(|error| error.to_string())?;
        let mut first = [0; 64 * 1024];
        let mut second = [0; 64 * 1024];
        loop {
            let count = left.read(&mut first).map_err(|error| error.to_string())?;
            right
                .read_exact(&mut second[..count])
                .map_err(|error| error.to_string())?;
            if first[..count] != second[..count] {
                return Ok(false);
            }
            if count == 0 {
                return Ok(true);
            }
        }
    }
}

#[cfg(target_os = "android")]
fn publication_identity(path: &Path) -> Result<PublicationIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("发布文件不是普通文件".into());
    }
    Ok(PublicationIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
    })
}

#[cfg(target_os = "android")]
fn matches_publication_identity(
    path: &Path,
    expected: &PublicationIdentity,
) -> Result<bool, String> {
    let found = publication_identity(path)?;
    Ok(found.device == expected.device
        && found.inode == expected.inode
        && found.size == expected.size)
}

/// Only a durable 'checking' record authorizes recovery of a published file.
/// A same-named user file is never accepted as this task's output.
fn recover_publication(root: &Path, record: &mut Record) -> Result<bool, String> {
    if record.status.state == "cancelled"
        || record.status.stage != "checking"
        || record.status.completed_bytes == 0
        || record.status.completed_bytes != record.status.total_bytes
    {
        return Ok(false);
    }
    let part = partial_path(root, &record.id);
    let target = destination(root, record)?;
    #[cfg(target_os = "android")]
    if !part.exists() {
        // renameat2 consumes the staging name. The durable checking journal
        // identifies the exact inode, so a crash after rename remains recoverable.
        let Some(identity) = record.publication_identity.as_ref() else {
            return Ok(false);
        };
        if !target.exists() || !matches_publication_identity(&target, identity)? {
            return Err("发布恢复目标与下载临时文件身份不一致，未认定为完成".into());
        }
        finish_publication(root, record, &target)?;
        return Ok(true);
    }
    let metadata = match fs::symlink_metadata(&part) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != record.status.total_bytes
    {
        return Err("发布恢复时临时文件不完整，未认定为已完成".into());
    }
    if target.exists() {
        if !same_published_file(&part, &target)? {
            return Err("目标已被其他文件占用，未覆盖或认定为下载完成".into());
        }
    } else {
        safe_fs::publish_no_replace(&part, &target)
            .map_err(|error| format!("恢复发布文件失败：{error}"))?;
    }
    finish_publication(root, record, &target)?;
    let _ = fs::remove_file(part);
    Ok(true)
}

fn finish_publication(root: &Path, record: &mut Record, target: &Path) -> Result<(), String> {
    record.status.state = "completed".into();
    record.status.stage = "completed".into();
    record.status.files = vec![target.to_string_lossy().into_owned()];
    record.status.directory = Some(record.directory.clone());
    record.status.error = None;
    record.status.speed_bytes_per_second = 0;
    record.status.connections = 0;
    persist(root, record)?;
    Ok(())
}

fn cleanup_completed_partial(root: &Path, record: &Record) -> Result<bool, String> {
    if record.status.state != "completed" {
        return Ok(false);
    }
    let part = partial_path(root, &record.id);
    if !part.exists() {
        return Ok(false);
    }
    let target = destination(root, record)?;
    if !target.exists() || !same_published_file(&part, &target)? {
        return Ok(false);
    }
    fs::remove_file(part).map_err(|error| error.to_string())?;
    Ok(true)
}

async fn until_stopped<F: std::future::Future>(task: &Task, work: F) -> Option<F::Output> {
    tokio::pin!(work);
    loop {
        if task.control.load(Ordering::Acquire) != 0 {
            return None;
        }
        tokio::select! {
            biased;
            _ = task.changed.notified() => {},
            value = &mut work => return Some(value),
        }
    }
}

fn headers(raw: Option<HashMap<String, String>>) -> Result<HashMap<String, String>, String> {
    let mut output = HashMap::new();
    for (name, value) in raw.unwrap_or_default() {
        let name = name.to_ascii_lowercase();
        if !matches!(name.as_str(), "accept" | "referer" | "user-agent") {
            return Err(format!("安卓下载不接受请求头：{name}"));
        }
        if value.len() > 4096 {
            return Err("下载请求头过长".into());
        }
        reqwest::header::HeaderValue::from_str(&value).map_err(|_| "下载请求头无效")?;
        if name == "referer" {
            network::public_url(&reqwest::Url::parse(&value).map_err(|_| "下载 Referer 无效")?)?;
        }
        output.insert(name, value);
    }
    Ok(output)
}

fn load(app: &tauri::AppHandle, id: &str) -> Result<Arc<Task>, String> {
    valid_id(id)?;
    if let Some(task) = registry()
        .lock()
        .map_err(|_| "下载任务状态不可用")?
        .get(id)
        .cloned()
    {
        return Ok(task);
    }
    let root = private_root(app)?;
    let path = record_path(&root, id);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "没有找到安卓下载记录；请从资源页重新添加")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32 * 1024 {
        return Err("安卓下载记录无效".into());
    }
    let mut record: Record =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|_| "安卓下载记录损坏")?;
    if record.version != 1 || record.id != id {
        return Err("安卓下载记录版本或编号不匹配".into());
    }
    network::public_url(&reqwest::Url::parse(&record.url).map_err(|_| "下载记录地址无效")?)?;
    record.headers = headers(Some(record.headers))?;
    let target = normalize_record_destination(&root, &mut record)?;
    recover_publication(&root, &mut record)?;
    if record.status.state == "completed" && !target.is_file() {
        record.status.state = "failed".into();
        record.status.error = Some("已下载文件已移动或删除".into());
        record.status.files.clear();
    } else if record.status.state == "completed" {
        record.status.files = vec![target.to_string_lossy().into_owned()];
    }
    // A crash after recording completion but before unlinking the staging name
    // must not keep the whole file alive after the user later removes its output.
    let _ = cleanup_completed_partial(&root, &record);
    if matches!(
        record.status.state.as_str(),
        "downloading" | "queued" | "paused"
    ) {
        record.status.state = "paused".into();
        record.status.stage = "queued_engine".into();
        record.status.error = Some("应用曾退出，前台下载已暂停；点击继续可断点续传".into());
        record.status.completed_bytes = fs::metadata(partial_path(&root, id))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
    }
    record.status.speed_bytes_per_second = 0;
    record.status.connections = 0;
    // Persist normalization of pre-fix aliases as well as interrupted state.
    persist(&root, &record)?;
    let task = Arc::new(Task {
        root,
        record: Mutex::new(record),
        control: AtomicU8::new(1),
        running: AtomicBool::new(false),
        changed: tokio::sync::Notify::new(),
    });
    let mut tasks = registry().lock().map_err(|_| "下载任务状态不可用")?;
    Ok(tasks.entry(id.to_string()).or_insert(task).clone())
}

fn snapshot(task: &Task) -> Result<Status, String> {
    Ok(task
        .record
        .lock()
        .map_err(|_| "下载进度不可用")?
        .status
        .clone())
}

fn launch(task: Arc<Task>) -> Result<Status, String> {
    {
        let tasks = registry().lock().map_err(|_| "下载任务状态不可用")?;
        let active = tasks
            .values()
            .filter(|task| task.running.load(Ordering::Acquire))
            .count();
        if active >= MAX_ACTIVE {
            return Err("最多同时下载 3 个文件，请暂停其他任务后继续".into());
        }
        task.running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "上一个下载请求仍在停止，请稍后再继续")?;
    }
    task.control.store(0, Ordering::Release);
    let status = {
        let mut record = task.record.lock().map_err(|_| "下载进度不可用")?;
        record.status.state = "downloading".into();
        record.status.stage = "connecting".into();
        record.status.error = None;
        if let Err(error) = persist(&task.root, &record) {
            task.running.store(false, Ordering::Release);
            return Err(error);
        }
        record.status.clone()
    };
    tauri::async_runtime::spawn(async move {
        let result = transfer(&task).await;
        if let Ok(mut record) = task.record.lock() {
            let control = task.control.load(Ordering::Acquire);
            if record.status.state == "completed" {
                // Completion and stop requests are serialized by this record lock.
            } else if control != 0 {
                record.status.state = if control == 2 { "cancelled" } else { "paused" }.into();
                record.status.error = None;
                if control == 2 {
                    let _ = fs::remove_file(partial_path(&task.root, &record.id));
                }
            } else if let Err(error) = result {
                record.status.state = "failed".into();
                record.status.error = Some(error);
            }
            record.status.speed_bytes_per_second = 0;
            record.status.connections = 0;
            let _ = persist(&task.root, &record);
        }
        task.running.store(false, Ordering::Release);
    });
    Ok(status)
}

async fn transfer(task: &Task) -> Result<(), String> {
    let record = task.record.lock().map_err(|_| "下载任务不可用")?.clone();
    let target = destination(&task.root, &record)?;
    if target.exists() {
        return Err("目标文件已存在，未覆盖；请修改文件名后重试".into());
    }
    let part = partial_path(&task.root, &record.id);
    if fs::symlink_metadata(&part)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("下载临时文件无效".into());
    }
    let mut offset = fs::metadata(&part)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if offset > MAX_BYTES {
        return Err("临时文件超过 64 GiB 限制".into());
    }
    if record.status.total_bytes > 0 && offset == record.status.total_bytes {
        // The previous process may have received the last byte before it could
        // durably mark 'checking'. Re-fetch instead of issuing an invalid EOF range.
        offset = 0;
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(45))
        .redirect(network::redirect_policy())
        .referer(false)
        .user_agent(network::USER_AGENT)
        .build()
        .map_err(|error| format!("创建下载客户端失败：{error}"))?;
    let mut request = client
        .get(&record.url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    for (name, value) in &record.headers {
        request = request.header(name, value);
    }
    // Without a server identity, resuming could silently concatenate two versions.
    let validator = record
        .etag
        .as_deref()
        .filter(|value| !value.starts_with("W/"))
        .or(record.last_modified.as_deref());
    if offset > 0 && validator.is_some() {
        request = request
            .header(reqwest::header::RANGE, format!("bytes={offset}-"))
            .header(reqwest::header::IF_RANGE, validator.unwrap());
    } else {
        offset = 0;
    }
    let Some(response) = until_stopped(task, request.send()).await else {
        return Ok(());
    };
    let mut response = response.map_err(|error| format!("连接下载来源失败：{error}"))?;
    if task.control.load(Ordering::Acquire) != 0 {
        return Ok(());
    }
    if !response.status().is_success() {
        return Err(format!("下载来源返回 HTTP {}", response.status()));
    }
    let total = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let range = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .ok_or("续传响应缺少 Content-Range")?;
        let (start, end, total) = parse_range(range)?;
        if start != offset || end < start {
            return Err("来源返回了错误的续传位置，未拼接文件".into());
        }
        total
    } else {
        offset = 0;
        response.content_length().unwrap_or(0)
    };
    if total > MAX_BYTES {
        return Err("单个文件超过 64 GiB，未开始下载".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("text/html") {
        return Err("来源返回的是网页或验证页面，没有可下载文件".into());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(&part)
        .map_err(|error| format!("创建下载临时文件失败：{error}"))?;
    {
        let mut current = task.record.lock().map_err(|_| "下载任务不可用")?;
        current.etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        current.last_modified = response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        current.status.total_bytes = total;
        current.status.completed_bytes = offset;
        current.status.stage = "downloading".into();
        current.status.connections = 1;
        persist(&task.root, &current)?;
    }
    let began = Instant::now();
    let mut completed = offset;
    let mut checkpoint = Instant::now();
    loop {
        let Some(next) = until_stopped(task, response.chunk()).await else {
            file.sync_all().map_err(|error| error.to_string())?;
            return Ok(());
        };
        let Some(chunk) = next.map_err(|error| format!("下载连接中断，可点击继续重试：{error}"))?
        else {
            break;
        };
        if task.control.load(Ordering::Acquire) != 0 {
            file.sync_all().map_err(|error| error.to_string())?;
            return Ok(());
        }
        completed = completed
            .checked_add(chunk.len() as u64)
            .ok_or("文件大小超出范围")?;
        if completed > MAX_BYTES || (total > 0 && completed > total) {
            return Err("下载文件超过来源声明的大小，未发布文件".into());
        }
        file.write_all(&chunk)
            .map_err(|error| format!("写入下载文件失败，请检查剩余空间：{error}"))?;
        if record.speed_limit > 0 {
            let expected =
                Duration::from_secs_f64((completed - offset) as f64 / record.speed_limit as f64);
            loop {
                let wait = expected.saturating_sub(began.elapsed());
                if wait.is_zero() {
                    break;
                }
                if until_stopped(task, tokio::time::sleep(wait.min(Duration::from_secs(1))))
                    .await
                    .is_none()
                {
                    file.sync_all().map_err(|error| error.to_string())?;
                    return Ok(());
                }
            }
        }
        let mut current = task.record.lock().map_err(|_| "下载任务不可用")?;
        current.status.completed_bytes = completed;
        current.status.speed_bytes_per_second =
            ((completed - offset) as f64 / began.elapsed().as_secs_f64().max(0.001)) as u64;
        if checkpoint.elapsed() >= Duration::from_secs(2) {
            persist(&task.root, &current)?;
            checkpoint = Instant::now();
        }
    }
    if completed == 0 || (total > 0 && completed != total) {
        return Err("文件未完整传输，保留临时文件以便继续".into());
    }
    file.sync_all()
        .map_err(|error| format!("保存下载文件失败：{error}"))?;
    drop(file);
    let mut current = task.record.lock().map_err(|_| "下载任务不可用")?;
    if task.control.load(Ordering::Acquire) != 0 {
        return Ok(());
    }
    let checked = destination(&task.root, &current)?;
    if checked != target {
        return Err("下载目标目录发生变化，未发布文件".into());
    }
    current.status.stage = "checking".into();
    current.status.total_bytes = completed;
    current.status.completed_bytes = completed;
    #[cfg(target_os = "android")]
    {
        current.publication_identity = Some(publication_identity(&part)?);
    }
    persist(&task.root, &current)?;
    recover_publication(&task.root, &mut current)?;
    Ok(())
}

fn parse_range(value: &str) -> Result<(u64, u64, u64), String> {
    let (range, total) = value
        .strip_prefix("bytes ")
        .and_then(|value| value.split_once('/'))
        .ok_or("续传 Content-Range 无效")?;
    let (start, end) = range.split_once('-').ok_or("续传 Content-Range 无效")?;
    let start = start.parse::<u64>().map_err(|_| "续传起点无效")?;
    let end = end.parse::<u64>().map_err(|_| "续传终点无效")?;
    let total = total.parse::<u64>().map_err(|_| "续传总长度无效")?;
    if end < start || end >= total || total > MAX_BYTES {
        return Err("续传长度不一致".into());
    }
    Ok((start, end, total))
}

#[tauri::command]
pub fn mobile_http_start(
    app: tauri::AppHandle,
    url: String,
    directory: String,
    filename: Option<String>,
    headers: Option<HashMap<String, String>>,
    speed_limit_bytes_per_second: Option<u64>,
) -> Result<Status, String> {
    let root = private_root(&app)?;
    if url.len() > 16_384 {
        return Err("下载地址过长".into());
    }
    let parsed = reqwest::Url::parse(&url).map_err(|_| "下载地址无效")?;
    network::public_url(&parsed)?;
    let filename = filename
        .or_else(|| {
            parsed
                .path_segments()
                .and_then(|mut value| value.next_back())
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "download.bin".into());
    valid_filename(&filename)?;
    let id = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                NONCE.fetch_add(1, Ordering::Relaxed)
            )
            .as_bytes()
        )
    );
    let mut record = Record {
        version: 1,
        id: id.clone(),
        url,
        directory,
        filename: filename.clone(),
        headers: self::headers(headers)?,
        speed_limit: speed_limit_bytes_per_second.unwrap_or(0),
        etag: None,
        last_modified: None,
        publication_identity: None,
        status: Status {
            engine_task_id: id.clone(),
            filename,
            directory: None,
            state: "queued".into(),
            total_bytes: 0,
            completed_bytes: 0,
            speed_bytes_per_second: 0,
            files: Vec::new(),
            stage: "queued_engine".into(),
            connections: 0,
            error: None,
        },
    };
    if normalize_record_destination(&root, &mut record)?.exists() {
        return Err("目标文件已存在，未覆盖；请修改文件名后重试".into());
    }
    persist(&root, &record)?;
    let task = Arc::new(Task {
        root,
        record: Mutex::new(record),
        control: AtomicU8::new(1),
        running: AtomicBool::new(false),
        changed: tokio::sync::Notify::new(),
    });
    registry()
        .lock()
        .map_err(|_| "下载任务状态不可用")?
        .insert(id, task.clone());
    launch(task)
}

#[tauri::command]
pub fn mobile_http_status(app: tauri::AppHandle, task_id: String) -> Result<Status, String> {
    let task = load(&app, &task_id)?;
    snapshot(&task)
}

#[tauri::command]
pub fn mobile_http_resume(app: tauri::AppHandle, task_id: String) -> Result<Status, String> {
    let task = load(&app, &task_id)?;
    {
        let mut record = task.record.lock().map_err(|_| "下载任务不可用")?;
        recover_publication(&task.root, &mut record)?;
    }
    if snapshot(&task)?.state == "completed" {
        return snapshot(&task);
    }
    launch(task)
}

async fn stop(app: tauri::AppHandle, id: String, cancel: bool) -> Result<Status, String> {
    let task = load(&app, &id)?;
    stop_task(task, cancel).await
}

async fn stop_task(task: Arc<Task>, cancel: bool) -> Result<Status, String> {
    {
        let mut record = task.record.lock().map_err(|_| "下载任务不可用")?;
        if record.status.state == "completed" {
            return Ok(record.status.clone());
        }
        task.control
            .store(if cancel { 2 } else { 1 }, Ordering::Release);
        task.changed.notify_one();
        record.status.state = if cancel { "cancelled" } else { "paused" }.into();
        record.status.speed_bytes_per_second = 0;
        record.status.connections = 0;
        record.status.error = None;
        record.status.completed_bytes = fs::metadata(partial_path(&task.root, &record.id))
            .map(|metadata| metadata.len())
            .unwrap_or(record.status.completed_bytes);
        if cancel && !task.running.load(Ordering::Acquire) {
            let _ = fs::remove_file(partial_path(&task.root, &record.id));
        }
        persist(&task.root, &record)?;
    }
    task.changed.notify_one();
    // Return only after the current socket/sleep/file handle is released, so an
    // immediate 'resume' is safe. A bounded failure is explicit to the caller.
    let deadline = Instant::now() + Duration::from_secs(3);
    while task.running.load(Ordering::Acquire) {
        if Instant::now() >= deadline {
            return Err("下载任务正在停止，请稍后重试".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    snapshot(&task)
}

#[tauri::command]
pub async fn mobile_http_pause(app: tauri::AppHandle, task_id: String) -> Result<Status, String> {
    stop(app, task_id, false).await
}
#[tauri::command]
pub async fn mobile_http_cancel(app: tauri::AppHandle, task_id: String) -> Result<Status, String> {
    stop(app, task_id, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn fixture(url: String, speed_limit: u64) -> Arc<Task> {
        let root = std::env::temp_dir().join(format!(
            "acgn-mobile-http-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join(".http-tasks")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        Arc::new(Task {
            record: Mutex::new(Record {
                version: 1,
                id: "a".repeat(64),
                url,
                directory: root.join("Incoming").to_string_lossy().into_owned(),
                filename: "archive.zip".into(),
                headers: HashMap::new(),
                speed_limit,
                etag: None,
                last_modified: None,
                publication_identity: None,
                status: Status {
                    engine_task_id: "a".repeat(64),
                    filename: "archive.zip".into(),
                    directory: None,
                    state: "downloading".into(),
                    total_bytes: 0,
                    completed_bytes: 0,
                    speed_bytes_per_second: 0,
                    files: Vec::new(),
                    stage: "connecting".into(),
                    connections: 0,
                    error: None,
                },
            }),
            root,
            control: AtomicU8::new(0),
            running: AtomicBool::new(true),
            changed: tokio::sync::Notify::new(),
        })
    }

    #[cfg(unix)]
    fn directory_alias(target: &Path, alias: &Path) {
        std::os::unix::fs::symlink(target, alias).unwrap();
    }

    #[cfg(windows)]
    fn directory_alias(target: &Path, alias: &Path) {
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
    fn remove_directory_alias(alias: &Path) {
        fs::remove_file(alias).unwrap();
    }

    #[cfg(windows)]
    fn remove_directory_alias(alias: &Path) {
        fs::remove_dir(alias).unwrap();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn private_directory_alias_normalizes_new_and_restored_records_without_allowing_child_links() {
        let task = fixture("https://example.org/archive.zip".into(), 0);
        let alias = task.root.with_extension("profile-alias");
        directory_alias(&task.root, &alias);
        let mut record = task.record.lock().unwrap().clone();
        record.directory = alias.join("Library/Books/NewSeries").to_string_lossy().into_owned();
        let target = normalize_record_destination(&alias, &mut record).unwrap();
        assert_eq!(target, task.root.join("Library/Books/NewSeries/archive.zip"));
        assert_eq!(Path::new(&record.directory), target.parent().unwrap());
        assert_eq!(record.status.directory.as_deref(), Some(record.directory.as_str()));
        persist(&alias, &record).unwrap();
        let mut legacy_json: serde_json::Value = serde_json::from_slice(
            &fs::read(record_path(&task.root, &record.id)).unwrap(),
        ).unwrap();
        legacy_json["status"].as_object_mut().unwrap().remove("directory");
        let mut restored: Record = serde_json::from_value(legacy_json).unwrap();
        assert!(restored.status.directory.is_none());
        assert_eq!(normalize_record_destination(&alias, &mut restored).unwrap(), target);
        assert_eq!(restored.status.directory.as_deref(), Some(restored.directory.as_str()));
        // Existing task JSON from before the fix still contains the raw alias.
        restored.directory = alias.join("Library/Books/NewSeries").to_string_lossy().into_owned();
        assert_eq!(normalize_record_destination(&alias, &mut restored).unwrap(), target);
        assert_eq!(Path::new(&restored.directory), target.parent().unwrap());

        for directory in [
            alias.join(".http-tasks"),
            alias.join("Library/.hidden"),
            alias.join("../outside"),
            task.root.with_extension("outside"),
        ] {
            record.directory = directory.to_string_lossy().into_owned();
            assert!(destination(&alias, &record).is_err());
        }
        let external = task.root.with_extension("outside");
        fs::create_dir_all(&external).unwrap();
        let external_link = task.root.join("ExternalLink");
        let internal_link = task.root.join("InternalLink");
        directory_alias(&external, &external_link);
        directory_alias(&task.root.join("Library"), &internal_link);
        for directory in [alias.join("ExternalLink"), alias.join("InternalLink/Books")] {
            record.directory = directory.to_string_lossy().into_owned();
            assert_eq!(destination(&alias, &record).unwrap_err(), "安卓下载目录路径不能包含符号链接");
        }
        remove_directory_alias(&external_link);
        remove_directory_alias(&internal_link);
        remove_directory_alias(&alias);
        fs::remove_dir_all(&external).unwrap();
        fs::remove_dir_all(&task.root).unwrap();
    }

    fn http_server(
        body: Vec<u8>,
        declared_size: usize,
        stall: bool,
    ) -> (
        String,
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, receiver) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut headers = [0; 8192];
            let _ = socket.read(&mut headers).unwrap();
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {declared_size}\r\nETag: \"fixture-v1\"\r\nConnection: close\r\n\r\n").unwrap();
            socket.write_all(&body).unwrap();
            socket.flush().unwrap();
            if stall {
                let _ = receiver.recv_timeout(Duration::from_secs(4));
            }
        });
        (format!("http://{address}/archive.zip"), release, thread)
    }

    fn spawn_transfer(task: Arc<Task>) -> tokio::task::JoinHandle<Result<(), String>> {
        tokio::spawn(async move {
            let result = transfer(&task).await;
            task.running.store(false, Ordering::Release);
            result
        })
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn private_root_alias_download_publishes_to_canonical_path() {
        let (url, _, server) = http_server(vec![6; 16], 16, false);
        let fixture_task = fixture(url, 0);
        let alias = fixture_task.root.with_extension("profile-alias");
        directory_alias(&fixture_task.root, &alias);
        let mut record = fixture_task.record.lock().unwrap().clone();
        record.directory = alias.join("Incoming").to_string_lossy().into_owned();
        normalize_record_destination(&alias, &mut record).unwrap();
        let task = Task {
            root: alias.clone(),
            record: Mutex::new(record),
            control: AtomicU8::new(0),
            running: AtomicBool::new(true),
            changed: tokio::sync::Notify::new(),
        };
        transfer(&task).await.unwrap();
        let target = fixture_task.root.join("Incoming/archive.zip");
        assert_eq!(fs::read(&target).unwrap(), vec![6; 16]);
        let status = snapshot(&task).unwrap();
        assert_eq!(status.state, "completed");
        assert_eq!(status.files, vec![target.to_string_lossy().into_owned()]);
        assert_eq!(status.directory.as_deref(), target.parent().unwrap().to_str());
        server.join().unwrap();
        remove_directory_alias(&alias);
        fs::remove_dir_all(&fixture_task.root).unwrap();
    }

    async fn wait_for_partial(task: &Task) {
        let path = partial_path(&task.root, &"a".repeat(64));
        tokio::time::timeout(Duration::from_secs(3), async {
            while !fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the mock source never produced a partial file");
    }

    #[tokio::test]
    async fn paused_stalled_response_releases_worker_without_publishing() {
        let (url, release, server) = http_server(vec![5; 8], 128, true);
        let task = fixture(url, 0);
        let worker = spawn_transfer(task.clone());
        wait_for_partial(&task).await;
        let began = Instant::now();
        assert_eq!(
            stop_task(task.clone(), false).await.unwrap().state,
            "paused"
        );
        assert!(
            began.elapsed() < Duration::from_secs(1),
            "pause waited for the read timeout"
        );
        worker.await.unwrap().unwrap();
        assert!(!task.root.join("Incoming/archive.zip").exists());
        assert!(
            fs::metadata(partial_path(&task.root, &"a".repeat(64)))
                .unwrap()
                .len()
                > 0
        );
        let _ = release.send(());
        server.join().unwrap();
        fs::remove_dir_all(&task.root).unwrap();
    }

    #[tokio::test]
    async fn paused_throttle_sleep_is_interruptible_and_never_publishes_partial() {
        let (url, _, server) = http_server(vec![7; 8192], 8192, false);
        let task = fixture(url, 1);
        let worker = spawn_transfer(task.clone());
        wait_for_partial(&task).await;
        let began = Instant::now();
        assert_eq!(
            stop_task(task.clone(), false).await.unwrap().state,
            "paused"
        );
        assert!(began.elapsed() < Duration::from_secs(1));
        worker.await.unwrap().unwrap();
        assert!(!task.root.join("Incoming/archive.zip").exists());
        server.join().unwrap();
        fs::remove_dir_all(&task.root).unwrap();
    }

    #[tokio::test]
    async fn throttled_download_obeys_full_wait_before_completion() {
        let (url, _, server) = http_server(vec![4; 8], 8, false);
        let task = fixture(url, 16);
        let began = Instant::now();
        transfer(&task).await.unwrap();
        assert!(began.elapsed() >= Duration::from_millis(450));
        assert_eq!(snapshot(&task).unwrap().state, "completed");
        assert_eq!(
            fs::read(task.root.join("Incoming/archive.zip")).unwrap(),
            vec![4; 8]
        );
        server.join().unwrap();
        fs::remove_dir_all(&task.root).unwrap();
    }

    #[test]
    fn publication_recovery_proves_ownership_and_rejects_unrelated_target() {
        let task = fixture("https://example.org/archive.zip".into(), 0);
        let mut record = task.record.lock().unwrap();
        record.status.stage = "checking".into();
        record.status.total_bytes = 8;
        record.status.completed_bytes = 8;
        let part = partial_path(&task.root, &record.id);
        let target = destination(&task.root, &record).unwrap();
        fs::write(&part, b"complete").unwrap();
        fs::write(&target, b"personal").unwrap();
        assert!(recover_publication(&task.root, &mut record).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"personal");
        fs::remove_file(&target).unwrap();
        fs::hard_link(&part, &target).unwrap();
        assert!(recover_publication(&task.root, &mut record).unwrap());
        assert_eq!(record.status.state, "completed");
        assert_eq!(fs::read(&target).unwrap(), b"complete");
        assert!(!part.exists());
        drop(record);
        fs::remove_dir_all(&task.root).unwrap();
    }

    #[test]
    fn cancelled_publication_stays_cancelled_and_completed_orphans_are_proven_before_cleanup() {
        let task = fixture("https://example.org/archive.zip".into(), 0);
        let mut record = task.record.lock().unwrap();
        record.status.state = "cancelled".into();
        record.status.stage = "checking".into();
        record.status.total_bytes = 8;
        record.status.completed_bytes = 8;
        let part = partial_path(&task.root, &record.id);
        let target = destination(&task.root, &record).unwrap();
        fs::write(&part, b"complete").unwrap();
        assert!(!recover_publication(&task.root, &mut record).unwrap());
        assert!(!target.exists());
        assert_eq!(record.status.state, "cancelled");
        record.status.state = "completed".into();
        record.status.stage = "completed".into();
        fs::hard_link(&part, &target).unwrap();
        assert!(cleanup_completed_partial(&task.root, &record).unwrap());
        assert!(!part.exists());
        assert_eq!(fs::read(&target).unwrap(), b"complete");
        fs::write(&part, b"personal").unwrap();
        assert!(!cleanup_completed_partial(&task.root, &record).unwrap());
        assert_eq!(fs::read(&part).unwrap(), b"personal");
        drop(record);
        fs::remove_dir_all(&task.root).unwrap();
    }

    #[tokio::test]
    async fn completed_status_survives_late_stop_and_omits_nullable_error() {
        let task = fixture("https://example.org/archive.zip".into(), 0);
        task.record.lock().unwrap().status.state = "completed".into();
        task.running.store(false, Ordering::Release);
        let status = stop_task(task.clone(), true).await.unwrap();
        assert_eq!(status.state, "completed");
        assert_eq!(task.control.load(Ordering::Acquire), 0);
        assert!(serde_json::to_value(status).unwrap().get("error").is_none());
        fs::remove_dir_all(&task.root).unwrap();
    }
    #[test]
    #[cfg(target_os = "android")]
    fn android_rename_publication_recovers_after_part_name_is_consumed() {
        let task = fixture("https://example.org/archive.zip".into(), 0);
        let mut record = task.record.lock().unwrap();
        record.status.stage = "checking".into();
        record.status.total_bytes = 8;
        record.status.completed_bytes = 8;
        let part = partial_path(&task.root, &record.id);
        let target = destination(&task.root, &record).unwrap();
        fs::write(&part, b"complete").unwrap();
        record.publication_identity = Some(publication_identity(&part).unwrap());
        persist(&task.root, &record).unwrap();
        safe_fs::publish_no_replace(&part, &target).unwrap();
        assert!(!part.exists());
        assert!(recover_publication(&task.root, &mut record).unwrap());
        assert_eq!(record.status.state, "completed");
        assert_eq!(fs::read(&target).unwrap(), b"complete");
        drop(record);
        fs::remove_dir_all(&task.root).unwrap();
    }

    #[test]
    fn resume_ranges_reject_invalid_lengths_and_offsets() {
        assert_eq!(parse_range("bytes 100-199/200").unwrap(), (100, 199, 200));
        for range in [
            "bytes 0-200/200",
            "bytes 200-100/300",
            "bytes 0-1/*",
            "items 0-1/2",
            "bytes -1-2/3",
        ] {
            assert!(parse_range(range).is_err());
        }
    }
    #[test]
    fn output_names_and_headers_cannot_escape_private_storage() {
        for name in [
            "../test.zip",
            "test/file.zip",
            "test\\file.zip",
            ".http-tasks",
            "a:b",
            "",
            ".",
            "..",
        ] {
            assert!(valid_filename(name).is_err());
        }
        assert!(valid_filename("无职转生 第01卷.zip").is_ok());
        assert!(headers(Some(HashMap::from([("Host".into(), "localhost".into())]))).is_err());
        assert!(headers(Some(HashMap::from([(
            "referer".into(),
            "http://127.0.0.1/".into()
        )])))
        .is_err());
    }
}
