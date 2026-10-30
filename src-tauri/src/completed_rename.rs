//! Completed-file renaming coordinated with the application's own SQLite pool.
//! A durable identity-bearing journal bridges the filesystem/SQLite crash window.
use crate::safe_fs::{absolute_path, is_path_within, require_child, AtomicOutput};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use tauri::Manager;

static OPERATIONS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static NEXT_JOURNAL: AtomicU64 = AtomicU64::new(0);
const JOURNAL_LIMIT: u64 = 1024 * 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenameResponse {
    status: &'static str,
    source_path: String,
    destination_path: String,
    original_file_name: String,
    updated_at: String,
}
#[derive(Serialize, Default)]
pub struct RecoveryResponse {
    recovered: usize,
    pending: usize,
    messages: Vec<String>,
}
#[derive(Clone, Debug)]
struct Task {
    id: String,
    engine_id: String,
    state: String,
    directory: String,
    filename: Option<String>,
    files_json: String,
    temp_path: Option<String>,
    final_path: Option<String>,
    updated_at: String,
    naming_json: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u8,
    task_id: String,
    task_directory: String,
    source_path: String,
    registered_source_path: String,
    destination_path: String,
    original_files_json: String,
    original_temp_path: Option<String>,
    original_final_path: Option<String>,
    original_filename: Option<String>,
    original_updated_at: String,
    original_naming_json: String,
    size_bytes: u64,
    sha256: String,
    updated_at: String,
}

async fn pool(instances: &tauri_plugin_sql::DbInstances) -> Result<SqlitePool, String> {
    instances
        .0
        .read()
        .await
        .get(&crate::database::get_database_url()?)
        .map(|pool| match pool {
            tauri_plugin_sql::DbPool::Sqlite(pool) => pool.clone(),
        })
        .ok_or_else(|| "应用 SQLite 数据库尚未初始化".into())
}
fn journal_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = if let Some(profile) = crate::runtime::portable_data_directory()? {
        profile
    } else {
        app.path()
            .app_data_dir()
            .map_err(|_| "无法定位改名恢复目录")?
    };
    Ok(root.join("Recovery").join("completed-renames"))
}

#[tauri::command]
pub async fn rename_completed_download(
    app: tauri::AppHandle,
    instances: tauri::State<'_, tauri_plugin_sql::DbInstances>,
    task_id: String,
    source_path: String,
    new_file_name: String,
) -> Result<RenameResponse, String> {
    let _operation = OPERATIONS
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let pool = pool(&instances).await?;
    let journals = journal_directory(&app)?;
    let recovery = recover(&pool, journals.clone()).await?;
    if recovery.pending > 0 {
        return Err(format!(
            "存在未解决的文件改名记录，已停止新操作：{}",
            recovery.messages.join("；")
        ));
    }
    rename(&pool, journals, task_id, source_path, new_file_name).await
}

#[tauri::command]
pub async fn recover_completed_download_renames(
    app: tauri::AppHandle,
    instances: tauri::State<'_, tauri_plugin_sql::DbInstances>,
) -> Result<RecoveryResponse, String> {
    let _operation = OPERATIONS
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    recover(&pool(&instances).await?, journal_directory(&app)?).await
}

async fn read_task(pool: &SqlitePool, id: &str) -> Result<Task, String> {
    if id.is_empty() || id.len() > 200 {
        return Err("下载任务编号无效".into());
    }
    let row = sqlx::query("SELECT id, engine_id, state, directory, filename, files_json, temp_path, final_path, updated_at, naming_json FROM download_tasks WHERE id = ?")
        .bind(id).fetch_optional(pool).await.map_err(|error| format!("读取改名任务失败（请先完成资料库初始化）：{error}"))?
        .ok_or("下载任务不存在")?;
    macro_rules! field {
        ($name:literal) => { row.try_get($name).map_err(|_| format!("下载任务字段 {} 格式无效，未修改文件", $name))? };
    }
    Ok(Task {
        id: field!("id"),
        engine_id: field!("engine_id"),
        state: field!("state"),
        directory: field!("directory"),
        filename: field!("filename"),
        files_json: field!("files_json"),
        temp_path: field!("temp_path"),
        final_path: field!("final_path"),
        updated_at: field!("updated_at"),
        naming_json: field!("naming_json"),
    })
}
fn task_files(task: &Task) -> Result<Vec<String>, String> {
    let files: Vec<String> =
        serde_json::from_str(&task.files_json).map_err(|_| "任务文件列表无效，未修改文件")?;
    if files.is_empty() || files.len() > 5000 {
        return Err("任务文件数量无效".into());
    }
    Ok(files)
}
fn path_key(value: &str) -> String {
    value
        .replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .trim_end_matches('\\')
        .to_lowercase()
}
fn same_path(left: &str, right: &str) -> bool {
    path_key(left) == path_key(right)
}
fn path_text(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}
fn eligible(task: &Task) -> Result<(), String> {
    if task.state != "completed" {
        return Err("只允许在下载校验完成后改名，传输中任务保持原文件名".into());
    }
    if task.engine_id != "aria2" {
        return Err(
            "当前只支持已完成的 aria2 文件改名；qBittorrent 可能仍在做种，未修改文件".into(),
        );
    }
    task_files(task)?;
    Ok(())
}
fn checked_task_root(task: &Task) -> Result<PathBuf, String> {
    eligible(task)?;
    let root = absolute_path(&task.directory, "任务下载目录")?;
    reject_reparse_path(&root)?;
    let root = std::fs::canonicalize(root).map_err(|error| format!("任务目录不可用：{error}"))?;
    if !root.is_dir() {
        return Err("任务下载根路径不是目录".into());
    }
    if let Some(final_path) = &task.final_path {
        let final_path = absolute_path(final_path, "已整理文件")?;
        let final_path = if std::fs::symlink_metadata(&final_path).is_ok() {
            reject_reparse_path(&final_path)?;
            std::fs::canonicalize(final_path).map_err(|error| error.to_string())?
        } else {
            let parent = final_path.parent().ok_or("已整理文件缺少父目录")?;
            let mut ancestor = parent;
            while !ancestor.exists() {
                ancestor = ancestor.parent().ok_or("已整理文件缺少可用父目录")?;
            }
            reject_reparse_path(ancestor)?;
            let existing = std::fs::canonicalize(ancestor).map_err(|error| error.to_string())?;
            // Preserve uncreated suffixes without creating any directories.
            existing.join(
                final_path
                    .strip_prefix(ancestor)
                    .map_err(|_| "已整理路径无效")?,
            )
        };
        if !is_path_within(&root, &final_path) {
            return Err("文件已经整理到任务目录以外，未执行原目录改名".into());
        }
    }
    Ok(root)
}
fn is_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn reject_reparse_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)
            .map_err(|error| format!("校验文件路径失败：{error}"))?;
        if is_reparse(&metadata) {
            return Err("文件路径包含符号链接或重解析点，未改名".into());
        }
    }
    Ok(())
}
fn safe_filename(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.encode_utf16().count() > 180
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|value| value.is_control() || "<>:\"/\\|?*".contains(value))
    {
        return Err("新文件名包含非法字符、路径片段或过长，未改名".into());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let stem = stem.trim_end_matches(' ');
    if matches!(stem, "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    {
        return Err("新文件名不能是 Windows 设备名称".into());
    }
    Ok(())
}
fn extension(path: &Path) -> Option<String> {
    path.extension()?.to_str().map(str::to_ascii_lowercase)
}
fn supported_extension(path: &Path) -> bool {
    extension(path).is_some_and(|extension| {
        matches!(
            extension.as_str(),
            "mp4" | "mkv" | "webm" | "avi" | "mov" | "m4v" | "ts" | "cbz" | "txt" | "epub" | "pdf"
        )
    })
}
fn checked_paths(task: &Task, source: &str, name: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = checked_task_root(task)?;
    safe_filename(name)?;
    if !task_files(task)?.iter().any(|file| same_path(file, source)) {
        return Err("源文件不在该任务登记的文件列表中".into());
    }
    let source = absolute_path(source, "已完成文件")?;
    reject_reparse_path(&source)?;
    let source =
        std::fs::canonicalize(source).map_err(|error| format!("已完成文件不可用：{error}"))?;
    require_child(&root, &source, "已完成文件")?;
    if !source.is_file() || !supported_extension(&source) {
        return Err("只支持登记在任务中的普通媒体文件，不能改名程序或种子".into());
    }
    let destination = source.parent().ok_or("已完成文件缺少父目录")?.join(name);
    if extension(&source) != extension(&destination) {
        return Err("改名必须保留原媒体扩展名".into());
    }
    if !same_path(&path_text(&source), &path_text(&destination))
        && std::fs::symlink_metadata(&destination).is_ok()
    {
        return Err("目标文件已存在，为避免覆盖已停止改名".into());
    }
    Ok((source, destination))
}
fn identity(path: &Path) -> Result<(u64, String), String> {
    reject_reparse_path(path)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("改名对象不是普通文件".into());
    }
    let mut input = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    if size != metadata.len() {
        return Err("文件在校验期间发生变化，已停止改名".into());
    }
    Ok((size, format!("{:x}", hash.finalize())))
}
fn identity_matches(path: &Path, journal: &Journal) -> Result<bool, String> {
    if std::fs::symlink_metadata(path).is_err() {
        return Ok(false);
    }
    let (size, hash) = identity(path)?;
    Ok(size == journal.size_bytes && hash == journal.sha256)
}
fn create_journal(directory: &Path, journal: &Journal) -> Result<PathBuf, String> {
    let mut ancestor = directory;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("改名日志缺少可用父目录")?;
    }
    reject_reparse_path(ancestor)?;
    std::fs::create_dir_all(directory).map_err(|error| format!("创建改名日志目录失败：{error}"))?;
    reject_reparse_path(directory)?;
    let id = format!(
        "rename-{}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时钟无效")?
            .as_nanos(),
        NEXT_JOURNAL.fetch_add(1, Ordering::Relaxed)
    );
    let path = directory.join(id);
    let mut output = AtomicOutput::new(path.clone())?;
    let mut file = output.take_file();
    let bytes = serde_json::to_vec(journal).map_err(|error| error.to_string())?;
    if bytes.len() > JOURNAL_LIMIT as usize {
        return Err("改名恢复日志超过允许大小，未移动文件".into());
    }
    file.write_all(&bytes)
        .map_err(|error| format!("保存改名恢复日志失败：{error}"))?;
    output.publish(file)?;
    Ok(path)
}
fn remove_journal(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|error| format!("改名日志仍保留：{error}"))
}
fn move_checked(journal: &Journal, forward: bool) -> Result<(), String> {
    let (source, destination) = if forward {
        (&journal.source_path, &journal.destination_path)
    } else {
        (&journal.destination_path, &journal.source_path)
    };
    let source = Path::new(source);
    let destination = Path::new(destination);
    reject_reparse_path(source)?;
    reject_reparse_path(source.parent().ok_or("文件缺少父目录")?)?;
    if source.parent() != destination.parent() || std::fs::symlink_metadata(destination).is_ok() {
        return Err("恢复或改名目标已存在，未覆盖任何文件".into());
    }
    if !identity_matches(source, journal)? {
        return Err("文件内容与改名日志不一致，未移动或删除".into());
    }
    crate::safe_fs::move_file_no_replace(source, destination)
}
fn mapped(value: &Option<String>, journal: &Journal) -> Option<String> {
    value.as_ref().map(|value| {
        if same_path(value, &journal.source_path)
            || same_path(value, &journal.registered_source_path)
        {
            journal.destination_path.clone()
        } else {
            value.clone()
        }
    })
}
fn new_files(journal: &Journal) -> Result<String, String> {
    let mut files: Vec<String> =
        serde_json::from_str(&journal.original_files_json).map_err(|_| "改名日志文件列表无效")?;
    let mut found = false;
    for path in &mut files {
        if same_path(path, &journal.source_path) || same_path(path, &journal.registered_source_path)
        {
            *path = journal.destination_path.clone();
            found = true;
        }
    }
    if !found {
        return Err("改名日志源文件未登记".into());
    }
    serde_json::to_string(&files).map_err(|error| error.to_string())
}
fn naming(journal: &Journal) -> Result<String, String> {
    let old: Value =
        serde_json::from_str(&journal.original_naming_json).map_err(|_| "旧文件命名记录无效")?;
    if !old.is_object() {
        return Err("旧文件命名记录无效".into());
    }
    let original_name = old
        .get("originalFileName")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            Path::new(&journal.source_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
        });
    let original_path = old
        .get("originalPath")
        .and_then(Value::as_str)
        .unwrap_or(&journal.source_path);
    serde_json::to_string(&json!({"status":"renamed", "originalFileName":original_name, "originalPath":original_path, "currentFileName":Path::new(&journal.destination_path).file_name().and_then(|value| value.to_str()), "renamedAt":journal.updated_at})).map_err(|error| error.to_string())
}
async fn rename(
    pool: &SqlitePool,
    journals: PathBuf,
    id: String,
    source: String,
    name: String,
) -> Result<RenameResponse, String> {
    let task = read_task(pool, &id).await?;
    let registered_source = task_files(&task)?
        .into_iter()
        .find(|value| same_path(value, &source))
        .ok_or("源文件不在该任务登记的文件列表中")?;
    let checked = task.clone();
    let (source_path, destination_path) =
        crate::run_blocking(move || checked_paths(&checked, &source, &name)).await?;
    let source = path_text(&source_path);
    let destination = path_text(&destination_path);
    let old_naming: Value =
        serde_json::from_str(&task.naming_json).map_err(|_| "旧文件命名记录无效，未改名")?;
    if !old_naming.is_object() {
        return Err("旧文件命名记录无效，未改名".into());
    }
    let original_name = old_naming
        .get("originalFileName")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            source_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        });
    if same_path(&source, &destination) {
        let current_name = source_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let already_recorded = old_naming.get("status").and_then(Value::as_str) == Some("renamed")
            && old_naming.get("currentFileName").and_then(Value::as_str)
                == Some(current_name.as_str())
            && old_naming
                .get("renamedAt")
                .and_then(Value::as_str)
                .is_some();
        let updated_at = if already_recorded {
            task.updated_at.clone()
        } else {
            let timestamp: String =
                sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                    .fetch_one(pool)
                    .await
                    .map_err(|error| error.to_string())?;
            let naming = json!({"status":"renamed", "originalFileName":original_name, "originalPath":old_naming.get("originalPath").and_then(Value::as_str).unwrap_or(&registered_source), "currentFileName":current_name, "renamedAt":timestamp}).to_string();
            let filename = if task_files(&task)?.len() == 1 {
                Some(current_name)
            } else {
                task.filename.clone()
            };
            let result = sqlx::query("UPDATE download_tasks SET filename=?, naming_json=?, updated_at=? WHERE id=? AND state='completed' AND engine_id='aria2' AND directory=? AND files_json=? AND updated_at=? AND naming_json=? AND temp_path IS ? AND final_path IS ?")
                .bind(filename).bind(naming).bind(&timestamp).bind(&task.id).bind(&task.directory).bind(&task.files_json).bind(&task.updated_at).bind(&task.naming_json).bind(&task.temp_path).bind(&task.final_path)
                .execute(pool).await.map_err(|error| format!("保存同名文件命名记录失败，文件未修改：{error}"))?;
            if result.rows_affected() != 1 {
                return Err("任务记录已改变，文件未修改".into());
            }
            timestamp
        };
        return Ok(RenameResponse {
            status: "unchanged",
            source_path: source.clone(),
            destination_path: source,
            original_file_name: original_name,
            updated_at,
        });
    }
    let updated_at: String = sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())?;
    let prepared_task = task.clone();
    let timestamp = updated_at.clone();
    let from = source.clone();
    let to = destination.clone();
    let (journal, path) = crate::run_blocking(move || {
        let (size_bytes, sha256) = identity(&source_path)?;
        let journal = Journal {
            version: 1,
            task_id: prepared_task.id,
            task_directory: prepared_task.directory,
            source_path: from,
            registered_source_path: registered_source,
            destination_path: to,
            original_files_json: prepared_task.files_json,
            original_temp_path: prepared_task.temp_path,
            original_final_path: prepared_task.final_path,
            original_filename: prepared_task.filename,
            original_updated_at: prepared_task.updated_at,
            original_naming_json: prepared_task.naming_json,
            size_bytes,
            sha256,
            updated_at: timestamp,
        };
        let path = create_journal(&journals, &journal)?;
        Ok((journal, path))
    })
    .await?;
    // Prepare all serialized updates before changing the filesystem.
    let files = new_files(&journal)?;
    let naming = naming(&journal)?;
    let mut move_attempted = false;
    let operation = async {
        let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
        let locked = sqlx::query("UPDATE download_tasks SET id = id WHERE id = ? AND state = 'completed' AND engine_id = 'aria2' AND directory = ? AND files_json = ? AND updated_at = ? AND temp_path IS ? AND final_path IS ? AND naming_json = ? AND filename IS ?")
            .bind(&task.id).bind(&task.directory).bind(&task.files_json).bind(&task.updated_at).bind(&task.temp_path).bind(&task.final_path).bind(&task.naming_json)
            .bind(&task.filename)
            .execute(&mut *transaction).await.map_err(|error| error.to_string())?;
        if locked.rows_affected() != 1 { return Err("任务记录已改变，已停止改名".to_string()); }
        let move_journal = journal.clone();
        move_attempted = true;
        crate::run_blocking(move || move_checked(&move_journal, true)).await?;
        let filename = if task_files(&task)?.len() == 1 { Path::new(&destination).file_name().map(|value| value.to_string_lossy().into_owned()) } else { task.filename.clone() };
        sqlx::query("UPDATE download_tasks SET filename = ?, files_json = ?, temp_path = ?, final_path = ?, updated_at = ?, naming_json = ? WHERE id = ? AND state = 'completed'")
            .bind(filename).bind(&files).bind(mapped(&task.temp_path, &journal)).bind(mapped(&task.final_path, &journal)).bind(&updated_at).bind(&naming).bind(&task.id)
            .execute(&mut *transaction).await.map_err(|error| error.to_string())?;
        let has_local: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'local_files'").fetch_one(&mut *transaction).await.map_err(|error| error.to_string())?;
        if has_local > 0 {
            // Match all old spellings of the source from the authoritative task list.
            let mut old_paths: Vec<_> = task_files(&task)?.into_iter().filter(|value| same_path(value, &source) || same_path(value, &journal.registered_source_path)).collect();
            old_paths.push(source.clone()); old_paths.sort(); old_paths.dedup();
            for old in old_paths { sqlx::query("UPDATE local_files SET path = ? WHERE path = ? COLLATE NOCASE").bind(&destination).bind(old).execute(&mut *transaction).await.map_err(|error| error.to_string())?; }
        }
        transaction.commit().await.map_err(|error| error.to_string())
    }.await;
    if let Err(error) = operation {
        if !move_attempted {
            let cleanup = path.clone();
            let _ = crate::run_blocking(move || remove_journal(&cleanup)).await;
            return Err(format!("改名未开始，文件未修改：{error}"));
        }
        // A failed commit can be ambiguous. Check authoritative state before
        // reverting a move; if the database cannot be read keep the journal.
        let current = read_task(pool, &task.id).await;
        if current.as_ref().is_ok_and(|current| {
            current.files_json == files
                && current.naming_json == naming
                && current.updated_at == updated_at
        }) {
            let identity_journal = journal.clone();
            if !crate::run_blocking(move || {
                identity_matches(
                    Path::new(&identity_journal.destination_path),
                    &identity_journal,
                )
            })
            .await?
            {
                return Err(format!(
                    "数据库已提交但目标内容待核对；日志保留，当前位置：{destination}"
                ));
            }
        } else {
            if current.is_err() {
                return Err(format!("改名后的数据库状态无法确认，日志保留；请检查 {source} 与 {destination}：{error}"));
            }
            let current = current.as_ref().unwrap();
            if current.state != "completed"
                || current.engine_id != "aria2"
                || current.directory != task.directory
                || current.files_json != task.files_json
                || current.updated_at != task.updated_at
                || current.naming_json != task.naming_json
                || current.temp_path != task.temp_path
                || current.final_path != task.final_path
                || current.filename != task.filename
            {
                return Err(format!("改名后数据库记录已发生额外变化，未自动回滚；日志保留，请核对 {source} 与 {destination}：{error}"));
            }
            let rollback_journal = journal.clone();
            let rollback_path = path.clone();
            let rollback =
                crate::run_blocking(move || rollback_or_clear(&rollback_journal, &rollback_path))
                    .await;
            return match rollback {
                Ok(()) => Err(format!("改名未提交，已保留或恢复原文件：{source}；{error}")),
                Err(rollback) => Err(format!("改名未提交且无法安全恢复，日志保留；当前位置请核对 {source} 与 {destination}：{rollback}；{error}")),
            };
        }
    }
    let cleanup = path.clone();
    let _ = crate::run_blocking(move || remove_journal(&cleanup)).await;
    Ok(RenameResponse {
        status: "renamed",
        source_path: source,
        destination_path: destination,
        original_file_name: original_name,
        updated_at,
    })
}
fn rollback_or_clear(journal: &Journal, path: &Path) -> Result<(), String> {
    let source = Path::new(&journal.source_path);
    let destination = Path::new(&journal.destination_path);
    let source_exists = std::fs::symlink_metadata(source).is_ok();
    let destination_exists = std::fs::symlink_metadata(destination).is_ok();
    if source_exists && !destination_exists && identity_matches(source, journal)? {
        return remove_journal(path);
    }
    if !source_exists && destination_exists && identity_matches(destination, journal)? {
        move_checked(journal, false)?;
        return remove_journal(path);
    }
    Err("原名或新名文件存在冲突/内容不符，未移动或删除任何文件".into())
}

async fn recover(pool: &SqlitePool, directory: PathBuf) -> Result<RecoveryResponse, String> {
    let entries = crate::run_blocking(move || {
        if !directory.exists() {
            return Ok(Vec::new());
        }
        reject_reparse_path(&directory)?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            if entries.len() >= 1000 {
                return Err("待恢复的改名日志过多，未自动处理".into());
            }
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.is_file() || is_reparse(&metadata) || metadata.len() > JOURNAL_LIMIT {
                return Err("改名恢复日志类型或大小无效，已保留".into());
            }
            let journal = serde_json::from_slice::<Journal>(
                &std::fs::read(&path).map_err(|error| error.to_string())?,
            )
            .map_err(|_| "改名恢复日志损坏，已保留")?;
            entries.push((path, journal));
        }
        Ok(entries)
    })
    .await?;
    let mut response = RecoveryResponse::default();
    for (path, journal) in entries {
        let result = recover_one(pool, path, journal.clone()).await;
        match result {
            Ok(()) => response.recovered += 1,
            Err(error) => {
                response.pending += 1;
                response.messages.push(format!(
                    "任务 {}：{}；原路径 {}；新路径 {}",
                    journal.task_id, error, journal.source_path, journal.destination_path
                ));
            }
        }
    }
    Ok(response)
}
async fn recover_one(pool: &SqlitePool, path: PathBuf, journal: Journal) -> Result<(), String> {
    if journal.version != 1
        || journal.sha256.len() != 64
        || !journal.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("改名日志身份无效".into());
    }
    let task = read_task(pool, &journal.task_id).await?;
    eligible(&task)?;
    if !same_path(&task.directory, &journal.task_directory) {
        return Err("任务根目录已改变，未自动恢复".into());
    }
    let old_files: Vec<String> =
        serde_json::from_str(&journal.original_files_json).map_err(|_| "旧文件列表无效")?;
    if !old_files
        .iter()
        .any(|file| same_path(file, &journal.registered_source_path))
    {
        return Err("日志原路径不属于任务".into());
    }
    let recovery_task = task.clone();
    let root = crate::run_blocking(move || checked_task_root(&recovery_task)).await?;
    let source = absolute_path(&journal.source_path, "原文件")?;
    let destination = absolute_path(&journal.destination_path, "新文件")?;
    require_child(&root, &source, "原文件")?;
    require_child(&root, &destination, "新文件")?;
    if source.parent() != destination.parent()
        || extension(&source) != extension(&destination)
        || !supported_extension(&source)
    {
        return Err("恢复路径超出同目录媒体改名范围".into());
    }
    safe_filename(
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("新文件名无效")?,
    )?;
    let parent = source.parent().ok_or("恢复文件缺少父目录")?.to_path_buf();
    crate::run_blocking(move || reject_reparse_path(&parent)).await?;
    let files = new_files(&journal)?;
    let committed = task.files_json == files
        && task.naming_json == naming(&journal)?
        && task.updated_at == journal.updated_at;
    if committed {
        crate::run_blocking(move || {
            if std::fs::symlink_metadata(&journal.source_path).is_ok()
                || !identity_matches(Path::new(&journal.destination_path), &journal)?
            {
                return Err("已提交的改名文件身份不符或旧名被占用，保留恢复日志".into());
            }
            remove_journal(&path)
        })
        .await
    } else if task.files_json == journal.original_files_json
        && task.updated_at == journal.original_updated_at
        && task.naming_json == journal.original_naming_json
        && task.temp_path == journal.original_temp_path
        && task.final_path == journal.original_final_path
        && task.filename == journal.original_filename
    {
        crate::run_blocking(move || rollback_or_clear(&journal, &path)).await
    } else {
        Err("数据库记录与改名前后快照均不一致，保留恢复日志".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        incoming: PathBuf,
        journals: PathBuf,
        source: PathBuf,
        pool: SqlitePool,
    }
    impl Fixture {
        async fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "acgn-rename-test-{}-{}",
                std::process::id(),
                NEXT_JOURNAL.fetch_add(1, Ordering::Relaxed)
            ));
            let incoming = root.join("Incoming");
            let journals = root.join("Recovery");
            std::fs::create_dir_all(&incoming).unwrap();
            let source = incoming.join("[Group] Original 01.mp4");
            std::fs::write(&source, b"completed video content").unwrap();
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query("CREATE TABLE download_tasks (id TEXT PRIMARY KEY, engine_id TEXT NOT NULL, state TEXT NOT NULL, directory TEXT NOT NULL, filename TEXT, files_json TEXT NOT NULL, temp_path TEXT, final_path TEXT, updated_at TEXT NOT NULL, naming_json TEXT NOT NULL DEFAULT '{}')").execute(&pool).await.unwrap();
            sqlx::query(
                "CREATE TABLE local_files (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE)",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO download_tasks (id,engine_id,state,directory,filename,files_json,temp_path,final_path,updated_at) VALUES ('task','aria2','completed',?,?,?,?,?,'2026-10-30T00:00:00.000Z')")
                .bind(path_text(&incoming)).bind(source.file_name().unwrap().to_string_lossy().into_owned()).bind(serde_json::to_string(&vec![path_text(&source)]).unwrap()).bind(path_text(&source)).bind(path_text(&source)).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO local_files (id,path) VALUES ('file', ?)")
                .bind(path_text(&source))
                .execute(&pool)
                .await
                .unwrap();
            Self {
                root,
                incoming,
                journals,
                source,
                pool,
            }
        }
        async fn rename(&self, name: &str) -> Result<RenameResponse, String> {
            rename(
                &self.pool,
                self.journals.clone(),
                "task".into(),
                path_text(&self.source),
                name.into(),
            )
            .await
        }
        async fn make_journal(&self) -> (Journal, PathBuf) {
            let task = read_task(&self.pool, "task").await.unwrap();
            let (size_bytes, sha256) = identity(&self.source).unwrap();
            let journal = Journal {
                version: 1,
                task_id: task.id,
                task_directory: task.directory,
                source_path: path_text(&std::fs::canonicalize(&self.source).unwrap()),
                registered_source_path: path_text(&self.source),
                destination_path: path_text(
                    &std::fs::canonicalize(&self.incoming)
                        .unwrap()
                        .join("Clean name.mp4"),
                ),
                original_files_json: task.files_json,
                original_temp_path: task.temp_path,
                original_final_path: task.final_path,
                original_filename: task.filename,
                original_updated_at: task.updated_at,
                original_naming_json: task.naming_json,
                size_bytes,
                sha256,
                updated_at: "2026-10-30T01:00:00.000Z".into(),
            };
            let path = create_journal(&self.journals, &journal).unwrap();
            (journal, path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn completed_same_directory_rename_updates_task_and_local_index_atomically_and_is_idempotent(
    ) {
        let fixture = Fixture::new().await;
        let result = fixture.rename("学生会也有洞！ - 第01话.mp4").await.unwrap();
        assert_eq!(result.status, "renamed");
        assert_eq!(
            result.source_path,
            path_text(
                &std::fs::canonicalize(fixture.incoming.clone())
                    .unwrap()
                    .join(fixture.source.file_name().unwrap())
            )
        );
        assert_eq!(result.original_file_name, "[Group] Original 01.mp4");
        assert!(!fixture.source.exists());
        let destination = PathBuf::from(&result.destination_path);
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"completed video content"
        );
        let task = read_task(&fixture.pool, "task").await.unwrap();
        assert_eq!(task.state, "completed");
        assert_eq!(
            task.filename.as_deref(),
            Some("学生会也有洞！ - 第01话.mp4")
        );
        assert_eq!(
            task_files(&task).unwrap(),
            vec![result.destination_path.clone()]
        );
        assert_eq!(task.temp_path, Some(result.destination_path.clone()));
        assert_eq!(task.final_path, Some(result.destination_path.clone()));
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT path FROM local_files WHERE id = 'file'")
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            result.destination_path
        );
        let naming: Value = serde_json::from_str(&task.naming_json).unwrap();
        assert_eq!(naming["originalPath"], result.source_path);
        let repeated = rename(
            &fixture.pool,
            fixture.journals.clone(),
            "task".into(),
            result.destination_path.clone(),
            "学生会也有洞！ - 第01话.mp4".into(),
        )
        .await
        .unwrap();
        assert_eq!(repeated.status, "unchanged");
        assert_eq!(repeated.updated_at, result.updated_at);
        let second = rename(
            &fixture.pool,
            fixture.journals.clone(),
            "task".into(),
            result.destination_path,
            "再命名 - 第01话.mp4".into(),
        )
        .await
        .unwrap();
        assert_eq!(second.original_file_name, "[Group] Original 01.mp4");
        assert_eq!(
            serde_json::from_str::<Value>(
                &read_task(&fixture.pool, "task").await.unwrap().naming_json
            )
            .unwrap()["originalPath"],
            result.source_path
        );
        assert_eq!(
            recover(&fixture.pool, fixture.journals.clone())
                .await
                .unwrap()
                .pending,
            0
        );
    }

    #[tokio::test]
    async fn active_tasks_qbittorrent_and_outside_final_paths_are_rejected_before_moving() {
        let fixture = Fixture::new().await;
        for state in ["downloading", "paused", "queued", "failed"] {
            sqlx::query("UPDATE download_tasks SET state = ?")
                .bind(state)
                .execute(&fixture.pool)
                .await
                .unwrap();
            assert!(fixture
                .rename("Clean.mp4")
                .await
                .unwrap_err()
                .contains("校验完成"));
        }
        sqlx::query("UPDATE download_tasks SET state='completed',engine_id='qbittorrent'")
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture
            .rename("Clean.mp4")
            .await
            .unwrap_err()
            .contains("qBittorrent"));
        sqlx::query("UPDATE download_tasks SET engine_id='aria2',final_path=?")
            .bind(path_text(&fixture.root.join("Library/other.mp4")))
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture
            .rename("Clean.mp4")
            .await
            .unwrap_err()
            .contains("目录以外"));
        assert!(fixture.source.exists());
        assert!(!fixture.journals.exists());
    }

    #[tokio::test]
    async fn unchanged_name_records_naming_once_without_moving_or_creating_a_journal() {
        let fixture = Fixture::new().await;
        let name = fixture.source.file_name().unwrap().to_str().unwrap();
        let first = fixture.rename(name).await.unwrap();
        assert_eq!(first.status, "unchanged");
        assert!(fixture.source.exists());
        assert!(!fixture.journals.exists());
        let task = read_task(&fixture.pool, "task").await.unwrap();
        let naming: Value = serde_json::from_str(&task.naming_json).unwrap();
        assert_eq!(naming["status"], "renamed");
        assert_eq!(naming["currentFileName"], name);
        assert_eq!(
            fixture.rename(name).await.unwrap().updated_at,
            first.updated_at
        );
    }

    #[tokio::test]
    async fn multi_file_task_maps_only_selected_file_and_works_without_local_index_table() {
        let fixture = Fixture::new().await;
        let second = fixture.incoming.join("second.mkv");
        std::fs::write(&second, b"second completed file").unwrap();
        let old_name = "season-pack";
        sqlx::query("DROP TABLE local_files")
            .execute(&fixture.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE download_tasks SET filename=?,files_json=?,temp_path=NULL,final_path=NULL",
        )
        .bind(old_name)
        .bind(serde_json::to_string(&vec![path_text(&fixture.source), path_text(&second)]).unwrap())
        .execute(&fixture.pool)
        .await
        .unwrap();
        let result = fixture.rename("clean.mp4").await.unwrap();
        let task = read_task(&fixture.pool, "task").await.unwrap();
        assert_eq!(task.filename.as_deref(), Some(old_name));
        assert_eq!(
            task_files(&task).unwrap(),
            vec![result.destination_path, path_text(&second)]
        );
        assert_eq!(task.temp_path, None);
        assert_eq!(task.final_path, None);
        assert_eq!(std::fs::read(second).unwrap(), b"second completed file");
    }

    #[tokio::test]
    async fn destination_conflicts_and_invalid_names_extensions_or_unregistered_sources_never_overwrite(
    ) {
        let fixture = Fixture::new().await;
        let conflict = fixture.incoming.join("Conflict.mp4");
        std::fs::write(&conflict, b"existing user file").unwrap();
        assert!(fixture.rename("Conflict.mp4").await.is_err());
        assert_eq!(std::fs::read(conflict).unwrap(), b"existing user file");
        for name in [
            "../Escape.mp4",
            "bad:stream.mp4",
            "CON.mp4",
            "COM1.mp4",
            "NUL .mp4",
            "trailing.mp4 ",
            "trailing.mp4.",
            "other.mkv",
            "file.exe",
            ".",
            "",
        ] {
            assert!(fixture.rename(name).await.is_err(), "{name}");
        }
        assert!(fixture
            .rename(&format!("{}.mp4", "x".repeat(181)))
            .await
            .is_err());
        let unregistered = fixture.incoming.join("other.mp4");
        std::fs::write(&unregistered, b"other").unwrap();
        assert!(rename(
            &fixture.pool,
            fixture.journals.clone(),
            "task".into(),
            path_text(&unregistered),
            "new.mp4".into()
        )
        .await
        .is_err());
        assert!(fixture.source.exists());
        assert_eq!(std::fs::read(unregistered).unwrap(), b"other");
    }

    #[tokio::test]
    async fn sqlite_failure_rolls_back_the_file_and_preserves_completed_state() {
        let fixture = Fixture::new().await;
        sqlx::query("CREATE TRIGGER deny_renaming BEFORE UPDATE OF files_json ON download_tasks BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END").execute(&fixture.pool).await.unwrap();
        let before = read_task(&fixture.pool, "task").await.unwrap();
        let error = fixture.rename("Clean.mp4").await.unwrap_err();
        assert!(error.contains("已保留或恢复原文件"), "{error}");
        assert_eq!(
            std::fs::read(&fixture.source).unwrap(),
            b"completed video content"
        );
        assert!(!fixture.incoming.join("Clean.mp4").exists());
        let after = read_task(&fixture.pool, "task").await.unwrap();
        assert_eq!(after.files_json, before.files_json);
        assert_eq!(after.state, "completed");
        assert_eq!(
            recover(&fixture.pool, fixture.journals.clone())
                .await
                .unwrap()
                .pending,
            0
        );
    }

    #[tokio::test]
    async fn local_index_failure_rolls_back_both_database_updates_and_the_file() {
        let fixture = Fixture::new().await;
        sqlx::query("INSERT INTO local_files (id,path) VALUES ('conflict', ?)")
            .bind(path_text(
                &std::fs::canonicalize(&fixture.incoming)
                    .unwrap()
                    .join("Clean.mp4"),
            ))
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture
            .rename("Clean.mp4")
            .await
            .unwrap_err()
            .contains("已保留或恢复原文件"));
        assert!(fixture.source.exists());
        assert!(!fixture.incoming.join("Clean.mp4").exists());
        assert_eq!(
            read_task(&fixture.pool, "task")
                .await
                .unwrap()
                .filename
                .as_deref(),
            Some("[Group] Original 01.mp4")
        );
    }

    #[tokio::test]
    async fn recovery_reverts_a_crash_after_move_and_cleans_a_pre_move_journal() {
        let fixture = Fixture::new().await;
        let (journal, path) = fixture.make_journal().await;
        move_checked(&journal, true).unwrap();
        let result = recover(&fixture.pool, fixture.journals.clone())
            .await
            .unwrap();
        assert_eq!((result.recovered, result.pending), (1, 0));
        assert!(fixture.source.exists());
        assert!(!path.exists());
        let (_, path) = fixture.make_journal().await;
        let result = recover(&fixture.pool, fixture.journals.clone())
            .await
            .unwrap();
        assert_eq!((result.recovered, result.pending), (1, 0));
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn recovery_keeps_committed_rename_and_refuses_foreign_or_conflicting_files() {
        let fixture = Fixture::new().await;
        let (journal, path) = fixture.make_journal().await;
        move_checked(&journal, true).unwrap();
        sqlx::query("UPDATE download_tasks SET files_json=?,temp_path=?,final_path=?,naming_json=?,updated_at=?")
            .bind(new_files(&journal).unwrap()).bind(mapped(&journal.original_temp_path,&journal)).bind(mapped(&journal.original_final_path,&journal)).bind(naming(&journal).unwrap()).bind(&journal.updated_at).execute(&fixture.pool).await.unwrap();
        let result = recover(&fixture.pool, fixture.journals.clone())
            .await
            .unwrap();
        assert_eq!((result.recovered, result.pending), (1, 0));
        assert!(!path.exists());
        assert!(!fixture.source.exists());
        let fixture = Fixture::new().await;
        let (journal, path) = fixture.make_journal().await;
        move_checked(&journal, true).unwrap();
        std::fs::write(&fixture.source, b"new unrelated original-name file").unwrap();
        let result = recover(&fixture.pool, fixture.journals.clone())
            .await
            .unwrap();
        assert_eq!(result.pending, 1);
        assert!(path.exists());
        assert_eq!(
            std::fs::read(&fixture.source).unwrap(),
            b"new unrelated original-name file"
        );
        assert_eq!(
            std::fs::read(&journal.destination_path).unwrap(),
            b"completed video content"
        );
        std::fs::remove_file(&fixture.source).unwrap();
        std::fs::write(
            &journal.destination_path,
            b"different file with the same destination name",
        )
        .unwrap();
        let result = recover(&fixture.pool, fixture.journals.clone())
            .await
            .unwrap();
        assert_eq!(result.pending, 1);
        assert!(path.exists());
        assert!(!fixture.source.exists());
    }

    #[tokio::test]
    async fn linked_source_or_linked_ancestor_is_never_followed_for_rename() {
        let fixture = Fixture::new().await;
        let link = fixture.incoming.join("linked.mp4");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&fixture.source, &link);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&fixture.source, &link);
        if let Err(error) = linked {
            assert!(
                cfg!(windows) && error.raw_os_error() == Some(1314),
                "unexpected symlink setup failure: {error}"
            );
            eprintln!("Windows symlink fixture unavailable (privilege 1314); no symlink operation was tested on this host");
            return;
        }
        sqlx::query("UPDATE download_tasks SET files_json=?")
            .bind(serde_json::to_string(&vec![path_text(&link)]).unwrap())
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(rename(
            &fixture.pool,
            fixture.journals.clone(),
            "task".into(),
            path_text(&link),
            "New.mp4".into()
        )
        .await
        .unwrap_err()
        .contains("重解析点"));
        assert!(fixture.source.exists());
        assert!(!fixture.incoming.join("New.mp4").exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_junction_ancestor_is_rejected_without_touching_its_target() {
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new().await;
        let outside = fixture.root.join("Outside");
        std::fs::create_dir(&outside).unwrap();
        let original = outside.join("episode.mp4");
        std::fs::write(&original, b"unrelated outside file").unwrap();
        let junction = fixture.incoming.join("junction");
        let result = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "could not create temporary junction fixture: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let linked = junction.join("episode.mp4");
        sqlx::query("UPDATE download_tasks SET files_json=?")
            .bind(serde_json::to_string(&vec![path_text(&linked)]).unwrap())
            .execute(&fixture.pool)
            .await
            .unwrap();
        let error = rename(
            &fixture.pool,
            fixture.journals.clone(),
            "task".into(),
            path_text(&linked),
            "New.mp4".into(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("重解析点"), "{error}");
        assert_eq!(std::fs::read(&original).unwrap(), b"unrelated outside file");
        assert!(!outside.join("New.mp4").exists());
        std::fs::remove_dir(junction).unwrap();
    }
}
