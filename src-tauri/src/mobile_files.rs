//! Open Android's system share chooser for a completed private download. The
//! application never selects a recipient, sends a message or executes a file.
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct AndroidFiles(tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("acgn-files")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _app.manage(AndroidFiles(_api.register_android_plugin(
                "local.acgnhub.mobile",
                "AcgnFilesPlugin",
            )?));
            Ok(())
        })
        .build()
}

/// Resolve a user path only through one of the two spellings of a native-owned
/// private root. Missing descendants are allowed for a new download directory,
/// but existing descendants must never be links, including links back inside.
pub(crate) fn checked_private_path(
    root: &Path,
    raw: &str,
    label: &str,
    allow_missing: bool,
) -> Result<PathBuf, String> {
    let path = crate::safe_fs::absolute_path(raw, label)?;
    let declared_root = root;
    let root = std::fs::canonicalize(declared_root).map_err(|_| "下载目录不可用")?;
    // Android may expose its private data directory through /data/user/0 while
    // canonical paths use /data/data. Only the trusted root may have an alias;
    // resolve each relative component below it before accepting the file.
    let relative = path
        .strip_prefix(declared_root)
        .or_else(|_| path.strip_prefix(&root))
        .map_err(|_| format!("{label}必须位于应用私有 Files 内"))?;
    let mut checked = root.clone();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(format!("{label}路径无效"));
        };
        let name_text = name.to_string_lossy();
        if name_text.starts_with('.')
            || name_text.ends_with([' ', '.'])
            || name_text.chars().any(char::is_control)
        {
            return Err(format!("{label}不能包含隐藏目录或下载控制文件"));
        }
        checked.push(name);
        let metadata = match std::fs::symlink_metadata(&checked) {
            Ok(metadata) => metadata,
            Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(format!("{label}不存在或已移动")),
        };
        let is_link = metadata.file_type().is_symlink();
        #[cfg(windows)]
        let is_link = {
            use std::os::windows::fs::MetadataExt;
            // Junctions are directory links too, even though is_symlink() does
            // not classify their reparse tag as a symbolic link on Windows.
            is_link || metadata.file_attributes() & 0x400 != 0
        };
        if is_link {
            return Err(format!("{label}路径不能包含符号链接"));
        }
    }
    let ancestor = crate::safe_fs::canonical_existing_ancestor(&checked)?;
    if !crate::safe_fs::is_path_within(&root, &ancestor) {
        return Err(format!("{label}越出应用私有目录"));
    }
    Ok(checked)
}

fn validated_share_path(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let checked = checked_private_path(root, raw, "导出文件", false)?;
    let root = std::fs::canonicalize(root).map_err(|_| "下载目录不可用")?;
    crate::safe_fs::require_child(&root, &checked, "导出文件")?;
    let extension = checked
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "part" | "tmp" | "aria2" | "download") {
        return Err("下载尚未完成，不能导出临时文件".into());
    }
    let metadata = std::fs::symlink_metadata(&checked).map_err(|_| "导出文件不可用")?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("只能导出已完成的非空普通文件".into());
    }
    let canonical = std::fs::canonicalize(&checked).map_err(|_| "无法校验导出文件")?;
    crate::safe_fs::require_child(&root, &canonical, "导出文件")?;
    Ok(canonical)
}

#[tauri::command]
pub async fn share_downloaded_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("files")
            .join("Files");
        let path = crate::run_blocking(move || validated_share_path(&root, &path)).await?;
        let _: serde_json::Value = app
            .state::<AndroidFiles>()
            .0
            .run_mobile_plugin_async("share", serde_json::json!({"path": path.to_string_lossy()}))
            .await
            .map_err(|error| format!("无法打开系统导出选择器：{error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path);
        Err("系统导出选择器用于安卓端；Windows 可从下载目录打开文件".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "acgn-share-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[cfg(unix)]
    fn directory_alias(target: &Path, alias: &Path) {
        std::os::unix::fs::symlink(target, alias).unwrap();
    }

    #[cfg(windows)]
    fn directory_alias(target: &Path, alias: &Path) {
        // A junction models Android's trusted directory alias without requiring
        // Windows Developer Mode or the symbolic-link creation privilege.
        let result = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(alias.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
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
        std::fs::remove_file(alias).unwrap();
    }

    #[cfg(windows)]
    fn remove_directory_alias(alias: &Path) {
        std::fs::remove_dir(alias).unwrap();
    }

    #[test]
    fn share_only_accepts_finished_files_within_private_root() {
        let root = temporary_root("finished");
        std::fs::create_dir_all(root.join("Files/Library")).unwrap();
        let files = std::fs::canonicalize(root.join("Files")).unwrap();
        let good = files.join("Library/第一卷.txt");
        std::fs::write(&good, "完整小说").unwrap();
        assert!(validated_share_path(&files, good.to_str().unwrap()).is_ok());
        for suffix in [
            ".http-tasks/secret.json",
            "Library/incomplete.part",
            "Library/partial.tmp",
        ] {
            let path = files.join(suffix);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "keep").unwrap();
            assert!(validated_share_path(&files, path.to_str().unwrap()).is_err());
        }
        let outside = root.join("database.sqlite");
        std::fs::write(&outside, "private").unwrap();
        assert!(validated_share_path(&files, outside.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn share_accepts_trusted_root_alias_but_rejects_links_below_it() {
        let root = temporary_root("alias");
        let actual_profile = root.join("actual-profile");
        let alias_profile = root.join("profile-alias");
        let actual_files = actual_profile.join("files/Files");
        std::fs::create_dir_all(actual_files.join("Library/Books")).unwrap();
        let actual_book = actual_files.join("Library/Books/第一卷.txt");
        std::fs::write(&actual_book, "完整小说").unwrap();
        directory_alias(&actual_profile, &alias_profile);
        let declared_files = alias_profile.join("files/Files");
        let alias_book = declared_files.join("Library/Books/第一卷.txt");
        let canonical_book = std::fs::canonicalize(&actual_book).unwrap();

        assert_eq!(
            validated_share_path(&declared_files, alias_book.to_str().unwrap()).unwrap(),
            canonical_book
        );
        assert_eq!(
            validated_share_path(&declared_files, canonical_book.to_str().unwrap()).unwrap(),
            canonical_book
        );

        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let outside_book = outside.join("private.txt");
        std::fs::write(&outside_book, "private").unwrap();
        assert!(validated_share_path(&declared_files, outside_book.to_str().unwrap()).is_err());

        let outside_link = actual_files.join("Library/OutsideLink");
        directory_alias(&outside, &outside_link);
        let internal_link = actual_files.join("Library/InternalLink");
        directory_alias(&actual_files.join("Library/Books"), &internal_link);
        for link_book in [
            declared_files.join("Library/OutsideLink/private.txt"),
            declared_files.join("Library/InternalLink/第一卷.txt"),
        ] {
            assert_eq!(
                validated_share_path(&declared_files, link_book.to_str().unwrap()).unwrap_err(),
                "导出文件路径不能包含符号链接"
            );
        }
        remove_directory_alias(&outside_link);
        remove_directory_alias(&internal_link);
        remove_directory_alias(&alias_profile);
        std::fs::remove_dir_all(root).unwrap();
    }
}
