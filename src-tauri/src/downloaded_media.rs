use crate::safe_fs::{absolute_path, require_child};
use std::path::PathBuf;
use sha2::{Digest, Sha256};
use std::io::Write;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

fn validated_media(path: &str, allowed_root: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(absolute_path(allowed_root, "下载文件根目录")?)
        .map_err(|error| format!("下载文件根目录不可用：{error}"))?;
    if !root.is_dir() {
        return Err("下载文件根路径不是目录".into());
    }
    let path = absolute_path(path, "下载文件")?;
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|error| format!("下载文件不可用：{error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("只能打开已下载的普通媒体文件".into());
    }
    let path = std::fs::canonicalize(path).map_err(|error| format!("校验下载文件失败：{error}"))?;
    require_child(&root, &path, "下载文件")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "mp4" | "mkv" | "webm" | "m4v" | "mov" | "avi" | "ts" | "cbz" | "txt" | "epub" | "pdf") {
        return Err("只允许打开已下载的视频、CBZ、TXT、EPUB 或 PDF 文件".into());
    }
    // ShellExecute and some associated applications do not accept the verbatim
    // \\?\ prefix produced by canonicalize. Simplify only after all checks.
    Ok(dunce::simplified(&path).to_path_buf())
}

#[tauri::command]
pub async fn open_downloaded_media(
    app: tauri::AppHandle,
    path: String,
    allowed_root: String,
    prefer_system: Option<bool>,
) -> Result<(), String> {
    let cache_handle = app.clone();
    let path = crate::run_blocking(move || {
        let checked = validated_media(&path, &allowed_root)?;
        if needs_browser_preview(&checked, prefer_system) {
            let cache = if let Some(profile) = crate::runtime::portable_data_directory()? {
                profile.join("Cache")
            } else {
                cache_handle.path().app_cache_dir().map_err(|error| error.to_string())?
            }.join("local-player");
            std::fs::create_dir_all(&cache).map_err(|error| format!("创建视频预览目录失败：{error}"))?;
            let document = preview_document(&checked)?;
            let key = format!("{:x}", Sha256::digest(checked.to_string_lossy().as_bytes()));
            let preview = cache.join(format!("{key}.html"));
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&preview) {
                Ok(mut file) => file.write_all(document.as_bytes()).map_err(|error| error.to_string())?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if std::fs::symlink_metadata(&preview).map_err(|error| error.to_string())?.file_type().is_symlink()
                        || std::fs::read(&preview).map_err(|error| error.to_string())? != document.as_bytes() {
                        return Err("已有视频预览缓存与当前文件不一致，未覆盖".into());
                    }
                }
                Err(error) => return Err(format!("创建视频预览失败：{error}")),
            }
            Ok(preview)
        } else { Ok(checked) }
    }).await?;
    // Windows Shell handlers may require the GUI thread's COM apartment and
    // message loop. Keep filesystem checks off that thread, then dispatch the
    // system open request through the existing application event loop.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = handle.opener()
            .open_path(path.to_string_lossy().into_owned(), None::<String>)
            .map_err(|error| format!("使用系统默认程序打开失败：{error}"));
        crate::diagnostics::record(&format!("media.open.finished success={}", result.is_ok()));
        let _ = sender.send(result);
    })
    .map_err(|error| format!("无法发起文件打开请求：{error}"))?;
    receiver.await.map_err(|_| "文件打开请求已中断".to_string())?
}

fn needs_browser_preview(path: &std::path::Path, prefer_system: Option<bool>) -> bool {
    !prefer_system.unwrap_or(false)
        && path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
}

fn preview_document(path: &std::path::Path) -> Result<String, String> {
    let url = reqwest::Url::from_file_path(path).map_err(|_| "无法生成本地视频地址")?;
    let source = url.as_str().replace('&', "&amp;").replace('"', "&quot;");
    Ok(format!(r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src file:; style-src 'unsafe-inline'"><title>ACGN 本地视频预览</title><style>html,body{{margin:0;height:100%;background:#17141e;color:#eee;font:16px system-ui}}main{{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}}video{{width:min(100%,1440px);max-height:88vh;background:#000}}p{{margin:0;font-size:13px;color:#bfb4cf}}</style><main><video controls preload="metadata" src="{source}"></video><p>本地视频 · 使用播放器控件播放或全屏</p></main></html>"#))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "acgn-open-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn local_preview_is_script_free_and_keeps_the_selected_file_as_data() {
        let root = temporary();
        let file = root.join("episode & title.mp4");
        let html = preview_document(&file).unwrap();
        assert!(html.contains("<video controls"));
        assert!(html.contains("media-src file:"));
        assert!(!html.contains("<script"));
        assert!(!html.contains("https://"));
        assert!(html.contains("&amp;"));
        assert!(html.contains("file:///"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn accepts_only_existing_supported_files_inside_declared_root() {
        let root = temporary();
        let nested = root.join("Books");
        std::fs::create_dir(&nested).unwrap();
        for filename in ["episode.MP4", "episode.mkv", "episode.webm", "episode.m4v", "episode.mov", "episode.avi", "episode.ts", "chapter.cbz", "volume.txt", "volume.epub", "volume.pdf"] {
            let file = nested.join(filename);
            std::fs::write(&file, b"media fixture").unwrap();
            assert!(validated_media(file.to_str().unwrap(), root.to_str().unwrap()).is_ok());
        }
        assert!(validated_media(nested.to_str().unwrap(), root.to_str().unwrap()).is_err());
        assert!(validated_media(
            root.join("missing.mp4").to_str().unwrap(),
            root.to_str().unwrap()
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_executables_relative_parent_and_sibling_prefix_paths() {
        let parent = temporary();
        let root = parent.join("Library");
        let sibling = parent.join("Library-Other");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        for filename in ["program.exe", "launch.bat", "launch.cmd", "shortcut.lnk", "command.ps1", "script.js", "episode.mp4.exe", "episode.mkv.part", "page.html", "remote.url"] {
            let file = root.join(filename);
            std::fs::write(&file, b"preserve").unwrap();
            assert!(validated_media(file.to_str().unwrap(), root.to_str().unwrap()).is_err());
        }
        let external = sibling.join("movie.mp4");
        std::fs::write(&external, b"preserve").unwrap();
        assert!(validated_media(external.to_str().unwrap(), root.to_str().unwrap()).is_err());
        assert!(validated_media("movie.mp4", root.to_str().unwrap()).is_err());
        assert!(validated_media(
            root.join("..")
                .join("Library-Other")
                .join("movie.mp4")
                .to_str()
                .unwrap(),
            root.to_str().unwrap()
        )
        .is_err());
        assert_eq!(std::fs::read(&external).unwrap(), b"preserve");
        std::fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn explicit_system_open_bypasses_preview_and_legacy_mp4_keeps_preview() {
        let mp4 = std::path::Path::new("episode.MP4");
        assert!(needs_browser_preview(mp4, None));
        assert!(needs_browser_preview(mp4, Some(false)));
        assert!(!needs_browser_preview(mp4, Some(true)));
        assert!(!needs_browser_preview(std::path::Path::new("episode.mkv"), None));
    }
    #[cfg(windows)]
    #[test]
    fn shell_paths_simplify_verbatim_dos_and_preserve_unc_semantics() {
        assert_eq!(
            dunce::simplified(std::path::Path::new(r"\\?\C:\Library\episode.mp4")),
            std::path::Path::new(r"C:\Library\episode.mp4")
        );
        // dunce only strips safe verbatim disk prefixes; UNC must not become
        // a relative "UNC/server" path or silently change network targets.
        let unc = std::path::Path::new(r"\\?\UNC\server\share\chapter.cbz");
        assert_eq!(dunce::simplified(unc), unc);
        let ordinary_unc = std::path::Path::new(r"\\server\share\chapter.cbz");
        assert_eq!(dunce::simplified(ordinary_unc), ordinary_unc);
        let root = temporary();
        let media = root.join("episode.mp4");
        std::fs::write(&media, b"fixture").unwrap();
        let checked = validated_media(media.to_str().unwrap(), root.to_str().unwrap()).unwrap();
        assert!(!checked.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(
            std::fs::canonicalize(&checked).unwrap(),
            std::fs::canonicalize(&media).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
