//! Relocate only registered paths inside the previous portable profile.
//! Media stays in place; SQLite updates commit together before repositories open.
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

pub const PORTABLE_MARKER: &str = "ACGN-HUB-PORTABLE";
pub const PORTABLE_MARKER_CONTENT: &[u8] = b"ACGN Hub portable profile v1\n";
static RELOCATION: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableProfile {
    data_directory: String,
}

pub fn adjacent_profile(executable: &Path) -> Result<Option<std::path::PathBuf>, String> {
    let parent = executable.parent().ok_or("无法定位程序目录")?;
    let marker = parent.join(PORTABLE_MARKER);
    match std::fs::symlink_metadata(&marker) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取便携模式标记失败：{error}")),
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() != PORTABLE_MARKER_CONTENT.len() as u64
                || std::fs::read(marker)
                    .map_err(|error| format!("读取便携模式标记失败：{error}"))?
                    != PORTABLE_MARKER_CONTENT
            {
                return Err("便携模式标记无效，请重新解压完整便携包；现有 Data 保持不变".into());
            }
            Ok(Some(parent.join("Data")))
        }
    }
}

#[tauri::command]
pub fn get_portable_profile() -> Result<Option<PortableProfile>, String> {
    Ok(
        crate::runtime::portable_data_directory()?.map(|profile| PortableProfile {
            data_directory: profile.to_string_lossy().into_owned(),
        }),
    )
}

fn normalized(value: &str) -> String {
    let value = value.replace('/', "\\");
    let value = if value
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"\\?\UNC\"))
    {
        format!(r"\\{}", &value[8..])
    } else if value.as_bytes().get(5) == Some(&b':') && value.as_bytes().get(6) == Some(&b'\\') {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    } else {
        value
    };
    value.trim_end_matches('\\').to_string()
}

pub fn rebase_path(value: &str, previous: &str, current: &str) -> String {
    let path = normalized(value);
    let previous = normalized(previous);
    let key = path.to_ascii_lowercase();
    let old_key = previous.to_ascii_lowercase();
    if path.split('\\').any(|part| part == ".." || part == ".")
        || (key != old_key && !key.starts_with(&format!("{old_key}\\")))
    {
        return value.to_string();
    }
    format!("{}{}", normalized(current), &path[previous.len()..])
}

fn rebase_json(raw: &str, previous: &str, current: &str, array: bool) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|_| "便携路径迁移遇到损坏的 JSON 记录，事务已停止，原始数据保持不变")?;
    if array {
        let entries = value
            .as_array_mut()
            .ok_or("便携文件列表格式无效，原始数据保持不变")?;
        for entry in entries {
            let path = entry
                .as_str()
                .ok_or("便携文件列表含无效路径，原始数据保持不变")?;
            *entry = Value::String(rebase_path(path, previous, current));
        }
    } else {
        let fields = value
            .as_object_mut()
            .ok_or("便携命名记录格式无效，原始数据保持不变")?;
        if let Some(Value::String(path)) = fields.get_mut("originalPath") {
            *path = rebase_path(path, previous, current);
        }
    }
    // Preserve the original representation when there is no path change.
    if serde_json::from_str::<Value>(raw).ok().as_ref() == Some(&value) {
        Ok(raw.to_string())
    } else {
        serde_json::to_string(&value).map_err(|error| error.to_string())
    }
}

async fn relocate_database(
    pool: &SqlitePool,
    previous: &str,
    current: &str,
) -> Result<usize, String> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("开始便携路径事务失败：{error}"))?;
    let mut affected = 0;
    let schemas: &[(&str, &[&str])] = &[
        (
            "download_tasks",
            &[
                "directory",
                "temp_path",
                "final_path",
                "files_json",
                "naming_json",
            ],
        ),
        ("local_files", &["path", "duplicate_of"]),
        ("organization_history", &["source_path", "destination_path"]),
        (
            "game_installs",
            &["path", "launch_path", "detected_files_json"],
        ),
    ];
    for (table, candidates) in schemas {
        let info = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
        let columns: Vec<String> = info.iter().map(|row| row.get("name")).collect();
        if !columns.iter().any(|name| name == "id") {
            continue;
        }
        let paths: Vec<&str> = candidates
            .iter()
            .copied()
            .filter(|name| columns.iter().any(|column| column == name))
            .collect();
        if paths.is_empty() {
            continue;
        }
        let rows = sqlx::query(&format!("SELECT * FROM {table}"))
            .fetch_all(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
        for row in rows {
            let id: String = row.try_get("id").map_err(|error| error.to_string())?;
            let mut updates = Vec::new();
            for column in &paths {
                let value: Option<String> =
                    row.try_get(*column).map_err(|error| error.to_string())?;
                if let Some(value) = value {
                    let rebased = match *column {
                        "files_json" | "detected_files_json" => {
                            rebase_json(&value, previous, current, true)?
                        }
                        "naming_json" => rebase_json(&value, previous, current, false)?,
                        _ => rebase_path(&value, previous, current),
                    };
                    if rebased != value {
                        updates.push((*column, rebased));
                    }
                }
            }
            if updates.is_empty() {
                continue;
            }
            let sql = format!(
                "UPDATE {table} SET {} WHERE id = ?",
                updates
                    .iter()
                    .map(|(column, _)| format!("{column} = ?"))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let mut query = sqlx::query(&sql);
            for (_, value) in &updates {
                query = query.bind(value);
            }
            query
                .bind(&id)
                .execute(&mut *transaction)
                .await
                .map_err(|error| format!("便携路径更新失败，事务已回滚：{error}"))?;
            // A process-local aria2 GID cannot be carried to another machine.
            // Keep .aria2 control files and require an explicit resume at the new path.
            if *table == "download_tasks"
                && [
                    "engine_id",
                    "engine_task_id",
                    "state",
                    "speed_bytes_per_second",
                    "error",
                ]
                .iter()
                .all(|name| columns.iter().any(|column| column == name))
            {
                sqlx::query("UPDATE download_tasks SET state = 'paused', engine_task_id = NULL, speed_bytes_per_second = 0, error = '便携目录已移动，请确认文件位置后继续下载' WHERE id = ? AND engine_id = 'aria2' AND state IN ('queued', 'downloading', 'paused')")
                    .bind(&id).execute(&mut *transaction).await.map_err(|error| error.to_string())?;
            }
            affected += 1;
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("提交便携路径事务失败：{error}"))?;
    Ok(affected)
}

#[tauri::command]
pub async fn relocate_portable_profile(previous_root: String) -> Result<usize, String> {
    let _guard = RELOCATION
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let current = crate::runtime::portable_data_directory()?.ok_or("当前未启用便携模式")?;
    let previous = crate::safe_fs::absolute_path(&previous_root, "原便携资料目录")?;
    if previous.parent().is_none() || previous.file_name().is_none() {
        return Err("原便携资料目录不能是磁盘根目录".into());
    }
    let current_text = current.to_string_lossy();
    if normalized(&previous_root).eq_ignore_ascii_case(&normalized(&current_text)) {
        return Ok(0);
    }
    let previous_comparison = std::path::PathBuf::from(normalized(&previous_root));
    let current_comparison = std::path::PathBuf::from(normalized(&current_text));
    if crate::safe_fs::is_path_within(&previous_comparison, &current_comparison)
        || crate::safe_fs::is_path_within(&current_comparison, &previous_comparison)
    {
        return Err("新旧便携资料目录不能互相嵌套，请将完整便携包移至独立目录后重试".into());
    }
    // Unfinished rename journals contain identities tied to old paths. Do not
    // guess across that crash window or grant old journals new file authority.
    let journals = current.join("Recovery").join("completed-renames");
    if journals.exists()
        && std::fs::read_dir(journals)
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
    {
        return Err("存在待恢复的文件改名记录。请将完整便携目录放回原位置，启动并恢复后再移动；文件和记录均已保留".into());
    }
    let database = current.join("acgn-hub.db");
    if !database.exists() {
        return Ok(0);
    }
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(database)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("打开便携资料库失败，未创建替代资料库：{error}"))?;
    let result = relocate_database(&pool, &previous_root, &current_text).await;
    pool.close().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_marker_makes_direct_executable_use_its_adjacent_profile() {
        let root = std::env::temp_dir().join(format!(
            "acgn-portable-marker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join("ACGN Hub.exe");
        assert!(adjacent_profile(&executable).unwrap().is_none());
        std::fs::write(root.join(PORTABLE_MARKER), PORTABLE_MARKER_CONTENT).unwrap();
        assert_eq!(
            adjacent_profile(&executable).unwrap(),
            Some(root.join("Data"))
        );
        std::fs::write(root.join(PORTABLE_MARKER), b"invalid").unwrap();
        assert!(adjacent_profile(&executable).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rebases_only_complete_profile_boundaries_and_preserves_external_paths() {
        assert_eq!(
            rebase_path(
                r"D:\Old\Data\Files\轻小说.txt",
                r"D:\Old\Data",
                r"E:\移动\Data"
            ),
            r"E:\移动\Data\Files\轻小说.txt"
        );
        assert_eq!(
            rebase_path(
                r"\\?\d:\old\data\Files\book.txt",
                r"D:\Old\Data",
                r"E:\New\Data"
            ),
            r"E:\New\Data\Files\book.txt"
        );
        for value in [
            r"D:\Old\Database\keep.txt",
            r"D:\External\keep.txt",
            r"D:\Old\Data\..\keep.txt",
            "https://example.org/file",
        ] {
            assert_eq!(rebase_path(value, r"D:\Old\Data", r"E:\New\Data"), value);
        }
    }

    #[test]
    fn rebases_canonical_unc_files_against_normal_or_verbatim_profile_roots() {
        for previous in [
            r"\\server\share\旧位置\Data",
            r"\\?\UNC\server\share\旧位置\Data",
        ] {
            for value in [
                r"\\server\share\旧位置\Data\Files\轻小说.txt",
                r"\\?\UNC\server\share\旧位置\Data\Files\轻小说.txt",
            ] {
                assert_eq!(
                    rebase_path(value, previous, r"E:\移动\Data"),
                    r"E:\移动\Data\Files\轻小说.txt"
                );
                assert_eq!(
                    rebase_path(value, previous, r"\\?\UNC\new-server\share\Data"),
                    r"\\new-server\share\Data\Files\轻小说.txt"
                );
            }
        }
        assert_eq!(
            normalized(r"\\?\unc\server\share\Data"),
            r"\\server\share\Data"
        );
        assert_eq!(
            rebase_path(
                r"\\?\UNC\server\share\Other\keep.txt",
                r"\\server\share\Data",
                r"E:\移动\Data"
            ),
            r"\\?\UNC\server\share\Other\keep.txt"
        );
    }

    #[tokio::test]
    async fn relocates_old_schema_transactionally_and_pauses_only_owned_active_tasks() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE download_tasks (id TEXT, directory TEXT, files_json TEXT, naming_json TEXT, engine_id TEXT, engine_task_id TEXT, state TEXT, speed_bytes_per_second INTEGER, error TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO download_tasks VALUES ('active', ?, ?, ?, 'aria2', 'old-gid', 'downloading', 4096, NULL)")
            .bind(r"D:\Old\Data\Files\Incoming").bind(r#"["D:\\Old\\Data\\Files\\Incoming\\book.epub","F:\\External\\keep.epub"]"#)
            .bind(r#"{"status":"renamed","originalPath":"D:\\Old\\Data\\Files\\Incoming\\old.epub","message":"keep D:\\Old\\Data"}"#).execute(&pool).await.unwrap();
        assert_eq!(
            relocate_database(&pool, r"D:\Old\Data", r"E:\New\Data")
                .await
                .unwrap(),
            1
        );
        let row = sqlx::query("SELECT * FROM download_tasks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.get::<String, _>("directory"),
            r"E:\New\Data\Files\Incoming"
        );
        assert_eq!(row.get::<String, _>("state"), "paused");
        assert!(row.get::<Option<String>, _>("engine_task_id").is_none());
        let files: Vec<String> = serde_json::from_str(row.get("files_json")).unwrap();
        assert_eq!(
            files,
            [
                r"E:\New\Data\Files\Incoming\book.epub",
                r"F:\External\keep.epub"
            ]
        );
        assert_eq!(
            relocate_database(&pool, r"D:\Old\Data", r"E:\New\Data")
                .await
                .unwrap(),
            0
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn malformed_records_roll_back_every_prior_path_update() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE local_files (id TEXT, path TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE game_installs (id TEXT, path TEXT, detected_files_json TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO local_files VALUES ('file', ?)")
            .bind(r"D:\Old\Data\Files\file.txt")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO game_installs VALUES ('game', ?, 'broken')")
            .bind(r"D:\Old\Data\Files\Game")
            .execute(&pool)
            .await
            .unwrap();
        assert!(relocate_database(&pool, r"D:\Old\Data", r"E:\New\Data")
            .await
            .is_err());
        let (path,): (String,) = sqlx::query_as("SELECT path FROM local_files")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(path, r"D:\Old\Data\Files\file.txt");
        pool.close().await;
    }

    #[tokio::test]
    async fn closed_profile_can_move_with_its_database_and_media_without_copying_payloads() {
        let root = std::env::temp_dir().join(format!(
            "acgn-portable-move-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let original = root.join("旧目录").join("Data");
        let moved = root.join("新目录").join("Data");
        let media = original
            .join("Files")
            .join("Library")
            .join("离线轻小说.txt");
        std::fs::create_dir_all(media.parent().unwrap()).unwrap();
        std::fs::write(&media, b"preserved local reading payload").unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(original.join("acgn-hub.db"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE local_files (id TEXT, path TEXT, duplicate_of TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO local_files VALUES ('same-id', ?, NULL)")
            .bind(media.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        std::fs::create_dir(moved.parent().unwrap()).unwrap();
        std::fs::rename(&original, &moved).unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(moved.join("acgn-hub.db"))
                    .create_if_missing(false),
            )
            .await
            .unwrap();
        assert_eq!(
            relocate_database(&pool, original.to_str().unwrap(), moved.to_str().unwrap())
                .await
                .unwrap(),
            1
        );
        let (id, path): (String, String) = sqlx::query_as("SELECT id, path FROM local_files")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(id, "same-id");
        assert_eq!(
            std::path::PathBuf::from(&path),
            moved.join("Files").join("Library").join("离线轻小说.txt")
        );
        assert_eq!(
            std::fs::read(path).unwrap(),
            b"preserved local reading payload"
        );
        assert!(!media.exists());
        pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
