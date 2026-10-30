//! Anonymous public BV submissions, executed through the installed Python tools.
//! No cookies, login, arbitrary commands, or user-selected executables.
use crate::safe_fs::{self, MangaTempGuard};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

static OPERATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
fn operations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn validated_url(raw: &str) -> Result<String, String> {
    if raw.len() > 2048 {
        return Err("投稿链接过长".into());
    }
    let parsed = reqwest::Url::parse(raw.trim()).map_err(|_| "投稿链接无效")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !matches!(parsed.host_str(), Some("bilibili.com" | "www.bilibili.com"))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some_and(|port| port != 80 && port != 443)
    {
        return Err("只支持不带认证信息的 bilibili.com/video/BV… 公开投稿".into());
    }
    let path = parsed.path().trim_end_matches('/');
    let id = path
        .strip_prefix("/video/")
        .ok_or("仅支持普通 BV 投稿，不支持番剧付费页或短链接")?;
    if id.len() != 12
        || !id.starts_with("BV")
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("BV 投稿编号无效".into());
    }
    let mut result = format!("https://www.bilibili.com/video/{id}/");
    let parts: Vec<_> = parsed.query_pairs().filter(|(key, _)| key == "p").collect();
    if parts.len() > 1 {
        return Err("分P参数重复".into());
    }
    if let Some((_, value)) = parts.first() {
        let page = value.parse::<u32>().map_err(|_| "分P参数无效")?;
        if !(1..=1000).contains(&page) {
            return Err("分P参数无效".into());
        }
        result.push_str(&format!("?p={page}"));
    }
    Ok(result)
}

struct OperationGuard {
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl OperationGuard {
    fn register(id: String) -> Result<Self, String> {
        if id.is_empty()
            || id.len() > 80
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err("公开视频任务编号无效".into());
        }
        let mut registry = operations().lock().map_err(|_| "公开视频任务状态不可用")?;
        if registry.contains_key(&id) {
            return Err("相同公开视频任务正在运行".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        registry.insert(id.clone(), cancelled.clone());
        Ok(Self { id, cancelled })
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = operations().lock() {
            if registry
                .get(&self.id)
                .is_some_and(|value| Arc::ptr_eq(value, &self.cancelled))
            {
                registry.remove(&self.id);
            }
        }
    }
}

struct ScriptFile(PathBuf);
impl ScriptFile {
    fn create() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "acgn-public-video-{}-{}-{}.py",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("创建公开视频桥接失败：{error}"))?;
        file.write_all(include_bytes!("../resources/public_video_bridge.py"))
            .map_err(|error| format!("写入公开视频桥接失败：{error}"))?;
        Ok(Self(path))
    }
}
impl Drop for ScriptFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn python_command(executable: &str, script: &ScriptFile) -> Command {
    let mut command = Command::new(executable);
    if crate::process_runner::python_uses_launcher(executable) {
        command.arg("-3");
    }
    command
        .args(["-I", "-u"])
        .arg(&script.0)
        .env("PYTHONUTF8", "1");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

fn find_python(script: &ScriptFile) -> Result<String, String> {
    let candidates = if cfg!(windows) {
        vec!["python.exe", "py.exe", "python", "py"]
    } else {
        vec!["python3", "python"]
    };
    for executable in candidates {
        let mut command = python_command(executable, script);
        command.arg("health");
        if let Ok(output) =
            crate::process_runner::run_with_timeout(&mut command, Duration::from_secs(6))
        {
            if output.status.success()
                && String::from_utf8_lossy(&output.stdout).lines().any(|line| {
                    serde_json::from_str::<Value>(line)
                        .ok()
                        .is_some_and(|value| value["kind"] == "result")
                })
            {
                return Ok(executable.into());
            }
        }
    }
    Err("未找到可用的 Python / yt-dlp。请安装 Python，并执行 python -m pip install yt-dlp imageio-ffmpeg；不会自动安装或下载可执行程序。".into())
}

fn terminate_owned(child: &mut Child) {
    // Only the exact child process created by this request and its own FFmpeg child.
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill.exe");
        command
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        let _ = command.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn execute_bridge(
    command: &mut Command,
    timeout: Duration,
    cancelled: &AtomicBool,
    progress: impl Fn(Value),
) -> Result<Value, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("公开视频任务已取消".into());
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动公开视频工具失败：{error}"))?;
    let stdout = child.stdout.take().ok_or("公开视频工具 stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("公开视频工具 stderr 不可用")?;
    let (sender, receiver) = std::sync::mpsc::channel::<Value>();
    let output_reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            if line.len() <= 512 * 1024 {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    let _ = sender.send(value);
                }
            }
        }
    });
    let error_reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = [0_u8; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
        }
    });
    let deadline = Instant::now() + timeout;
    let mut result = None;
    let mut failure = None;
    let exit = loop {
        while let Ok(value) = receiver.try_recv() {
            match value["kind"].as_str() {
                Some("progress") => progress(value),
                Some("result") => result = value.get("result").cloned(),
                Some("error") => failure = value["message"].as_str().map(str::to_string),
                _ => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if cancelled.load(Ordering::Relaxed) => {
                terminate_owned(&mut child);
                break Err("公开视频任务已取消".to_string());
            }
            Ok(None) if Instant::now() >= deadline => {
                terminate_owned(&mut child);
                break Err("公开视频处理超时，已停止本次工具进程。请稍后重试。".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                terminate_owned(&mut child);
                break Err(format!("读取公开视频进程状态失败：{error}"));
            }
        }
    };
    let _ = output_reader.join();
    let _ = error_reader.join();
    while let Ok(value) = receiver.try_recv() {
        match value["kind"].as_str() {
            Some("result") => result = value.get("result").cloned(),
            Some("error") => failure = value["message"].as_str().map(str::to_string),
            Some("progress") => progress(value),
            _ => {}
        }
    }
    let status = exit?;
    if let Some(message) = failure {
        return Err(message);
    }
    if !status.success() {
        return Err(
            "公开视频工具退出异常；若被系统防护阻止，请查看系统保护历史，不要关闭防护。".into(),
        );
    }
    result.ok_or_else(|| "公开视频工具没有返回有效结果".into())
}

#[tauri::command]
pub async fn inspect_public_video(url: String) -> Result<Value, String> {
    let url = validated_url(&url)?;
    crate::run_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(45);
        let script = ScriptFile::create()?;
        let executable = find_python(&script)?;
        let mut command = python_command(&executable, &script);
        command.arg("inspect").arg(url);
        execute_bridge(
            &mut command,
            deadline.saturating_duration_since(Instant::now()),
            &AtomicBool::new(false),
            |_| {},
        )
    })
    .await
}

#[tauri::command]
pub async fn download_public_video(
    app: tauri::AppHandle,
    url: String,
    output_root: String,
    output_path: String,
    operation_id: String,
) -> Result<Value, String> {
    let url = validated_url(&url)?;
    let operation = OperationGuard::register(operation_id)?;
    crate::run_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(1800);
        let output = safe_fs::output_path(&output_root, &output_path, "mp4")?;
        let temporary = output.parent().ok_or("输出文件缺少目录")?.join(format!(".acgn-public-video-{}-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        let staging = MangaTempGuard::create(&output_root, &temporary.to_string_lossy())?;
        let script = ScriptFile::create()?;
        let executable = find_python(&script)?;
        let mut command = python_command(&executable, &script);
        command.arg("download").arg(url).arg(staging.path()).arg(&operation.id);
        let metadata = execute_bridge(&mut command, deadline.saturating_duration_since(Instant::now()), &operation.cancelled, |value| {
            let payload = json!({"id": operation.id, "stage": value["stage"], "percent": value["percent"],
                "downloadedBytes": value["downloadedBytes"], "totalBytes": value["totalBytes"], "detail": value["detail"]});
            let _ = app.emit("public-video-progress", payload);
        })?;
        if operation.cancelled.load(Ordering::Relaxed) { return Err("公开视频任务已取消".into()); }
        let finished = staging.path().join("video.mp4");
        let size = publish_video(&output_root, &output_path, &output, &finished)?;
        let _ = app.emit("public-video-progress", json!({"id": operation.id, "stage": "completed", "percent": 100,
            "downloadedBytes": size, "totalBytes": size}));
        Ok(json!({"outputPath": output.to_string_lossy(), "sizeBytes": size,
            "width": metadata["width"], "height": metadata["height"], "duration": metadata["duration"]}))
    }).await
}

fn publish_video(
    root: &str,
    requested: &str,
    expected: &Path,
    finished: &Path,
) -> Result<u64, String> {
    let attributes =
        fs::symlink_metadata(finished).map_err(|error| format!("读取合并视频失败：{error}"))?;
    if !attributes.is_file() || attributes.file_type().is_symlink() || attributes.len() < 32 {
        return Err("公开视频没有生成完整的 MP4 文件".into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(finished)
        .map_err(|error| format!("打开已合并视频失败：{error}"))?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| "读取 MP4 文件头失败")?;
    if &header[4..8] != b"ftyp" {
        return Err("输出文件不是 MP4，未发布下载结果".into());
    }
    file.sync_all()
        .map_err(|error| format!("刷新视频输出失败：{error}"))?;
    drop(file);
    let checked = safe_fs::output_path(root, requested, "mp4")?;
    if checked != expected {
        return Err("下载期间输出目录已变化，未发布视频".into());
    }
    fs::hard_link(finished, expected)
        .map_err(|error| format!("发布视频失败，目标可能已存在；未覆盖原文件：{error}"))?;
    Ok(attributes.len())
}

#[tauri::command]
pub fn cancel_public_video(id: String) -> Result<(), String> {
    if let Some(cancelled) = operations()
        .lock()
        .map_err(|_| "公开视频任务状态不可用")?
        .get(&id)
    {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_public_bv_urls_and_preserves_one_valid_part() {
        assert_eq!(
            validated_url("http://bilibili.com/video/BV1UqHi6uEie/?p=2&vd_source=tracking")
                .unwrap(),
            "https://www.bilibili.com/video/BV1UqHi6uEie/?p=2"
        );
        for url in [
            "https://bilibili.com.evil.example/video/BV1UqHi6uEie/",
            "https://user:pass@www.bilibili.com/video/BV1UqHi6uEie/",
            "file:///video/BV1UqHi6uEie",
            "https://www.bilibili.com/bangumi/play/ep1",
            "https://b23.tv/123",
            "https://www.bilibili.com/video/BV1UqHi6uEie/?p=0",
            "https://www.bilibili.com/video/BV1UqHi6uEie/?p=1&p=2",
            "https://www.bilibili.com/video/BV1UqHi6uEie/extra",
            "https://www.bilibili.com:9999/video/BV1UqHi6uEie/",
        ] {
            assert!(
                validated_url(url).is_err(),
                "unexpected accepted URL: {url}"
            );
        }
    }

    #[test]
    fn cancellation_targets_only_the_registered_operation() {
        let first = OperationGuard::register("public-video-unit-first".into()).unwrap();
        let second = OperationGuard::register("public-video-unit-second".into()).unwrap();
        assert!(OperationGuard::register(first.id.clone()).is_err());
        cancel_public_video(first.id.clone()).unwrap();
        assert!(first.cancelled.load(Ordering::Relaxed));
        assert!(!second.cancelled.load(Ordering::Relaxed));
        cancel_public_video("not-this-apps-task".into()).unwrap();
        assert!(!second.cancelled.load(Ordering::Relaxed));
        drop(first);
        assert!(!operations()
            .lock()
            .unwrap()
            .contains_key("public-video-unit-first"));
    }

    #[test]
    fn publication_keeps_an_existing_destination_and_rejects_non_mp4_output() {
        let root = std::env::temp_dir().join(format!(
            "acgn-public-video-unit-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let output = root.join("episode.mp4");
        let expected =
            safe_fs::output_path(root.to_str().unwrap(), output.to_str().unwrap(), "mp4").unwrap();
        let stage = root.join("owned-video.mp4");
        let mut bytes = vec![0_u8; 64];
        bytes[4..8].copy_from_slice(b"ftyp");
        fs::write(&stage, &bytes).unwrap();
        fs::write(&output, b"existing user file").unwrap();
        assert!(publish_video(
            root.to_str().unwrap(),
            output.to_str().unwrap(),
            &expected,
            &stage
        )
        .is_err());
        assert_eq!(fs::read(&output).unwrap(), b"existing user file");
        assert_eq!(fs::read(&stage).unwrap(), bytes);
        fs::remove_file(&output).unwrap();
        fs::write(&stage, vec![0_u8; 64]).unwrap();
        assert!(publish_video(
            root.to_str().unwrap(),
            output.to_str().unwrap(),
            &expected,
            &stage
        )
        .is_err());
        assert!(!output.exists());
        fs::write(&stage, &bytes).unwrap();
        assert_eq!(
            publish_video(
                root.to_str().unwrap(),
                output.to_str().unwrap(),
                &expected,
                &stage
            )
            .unwrap(),
            64
        );
        assert_eq!(fs::read(&output).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }
}
