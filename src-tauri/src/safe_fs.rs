use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const TEMP_MARKER: &str = ".acgn-manga-temp";
const TEMP_MARKER_CONTENT: &[u8] = b"ACGN Hub owned manga temporary directory\n";
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

pub fn absolute_path(value: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() || has_parent_component(&path) {
        return Err(format!("{label}必须是无 .. 片段的绝对路径"));
    }
    Ok(path)
}

pub fn has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|part| matches!(part, Component::ParentDir))
}

fn normalized(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\").to_lowercase();
    value
        .strip_prefix(r"\\?\")
        .unwrap_or(&value)
        .trim_end_matches(['\\', '.'])
        .to_string()
}

pub fn is_path_within(root: &Path, target: &Path) -> bool {
    let root = normalized(root);
    let target = normalized(target);
    target == root || target.starts_with(&format!("{root}\\"))
}

pub fn require_child(root: &Path, target: &Path, label: &str) -> Result<(), String> {
    if normalized(root) == normalized(target) || !is_path_within(root, target) {
        return Err(format!("{label}必须是根目录内的子路径，不能等于根目录"));
    }
    Ok(())
}

pub fn canonical_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path;
    while !existing.exists() {
        existing = existing.parent().ok_or("输出路径没有可用父目录")?;
    }
    fs::canonicalize(existing).map_err(|error| format!("校验现有父目录失败：{error}"))
}

fn create_parent_within(root: &Path, parent: &Path) -> Result<PathBuf, String> {
    let existing = canonical_existing_ancestor(parent)?;
    if !is_path_within(root, &existing) {
        return Err("输出父目录越出允许根目录".to_string());
    }
    fs::create_dir_all(parent).map_err(|error| format!("创建输出目录失败：{error}"))?;
    let parent = fs::canonicalize(parent).map_err(|error| format!("校验输出目录失败：{error}"))?;
    if !is_path_within(root, &parent) {
        return Err("输出目录越出允许根目录".to_string());
    }
    Ok(parent)
}

/// Only newly created, marked directories belong to the download operation.
pub fn create_manga_temp(incoming: &str, temporary: &str) -> Result<PathBuf, String> {
    let root = absolute_path(incoming, "Incoming 根目录")?;
    let path = absolute_path(temporary, "漫画临时目录")?;
    require_child(&root, &path, "漫画临时目录")?;
    fs::create_dir_all(&root).map_err(|error| format!("创建 Incoming 根目录失败：{error}"))?;
    let root = fs::canonicalize(root).map_err(|error| format!("校验 Incoming 失败：{error}"))?;
    let parent = path.parent().ok_or("漫画临时目录缺少父目录")?;
    create_parent_within(&root, parent)?;
    fs::create_dir(&path).map_err(|error| format!("漫画临时目录必须为新目录：{error}"))?;
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("校验漫画临时目录失败：{error}"))?;
    require_child(&root, &canonical, "漫画临时目录")?;
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(canonical.join(TEMP_MARKER))
        .map_err(|error| format!("标记漫画临时目录失败：{error}"))?;
    marker
        .write_all(TEMP_MARKER_CONTENT)
        .map_err(|error| format!("写入漫画临时标记失败：{error}"))?;
    Ok(canonical)
}

pub fn cleanup_manga_temp(incoming: &str, temporary: &str) -> Result<(), String> {
    let root = fs::canonicalize(absolute_path(incoming, "Incoming 根目录")?)
        .map_err(|error| format!("Incoming 根目录不可用：{error}"))?;
    let path = absolute_path(temporary, "漫画临时目录")?;
    if !path.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("拒绝清理符号链接临时目录".to_string());
    }
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("校验漫画临时目录失败：{error}"))?;
    require_child(&root, &canonical, "漫画临时目录")?;
    if !canonical.is_dir() {
        return Err("漫画临时标记无效".to_string());
    }
    ensure_manga_temp_owned(&canonical)?;
    fs::remove_dir_all(canonical).map_err(|error| format!("清理漫画临时目录失败：{error}"))
}

pub fn ensure_manga_temp_owned(path: &Path) -> Result<(), String> {
    let marker = fs::symlink_metadata(path.join(TEMP_MARKER))
        .map_err(|_| "漫画临时目录缺少应用所有权标记".to_string())?;
    if !marker.is_file()
        || marker.file_type().is_symlink()
        || marker.len() != TEMP_MARKER_CONTENT.len() as u64
        || fs::read(path.join(TEMP_MARKER)).map_err(|error| error.to_string())?
            != TEMP_MARKER_CONTENT
    {
        return Err("漫画临时标记无效".to_string());
    }
    Ok(())
}

pub struct MangaTempGuard {
    incoming: String,
    path: PathBuf,
    keep: bool,
}

impl MangaTempGuard {
    pub fn create(incoming: &str, temporary: &str) -> Result<Self, String> {
        Ok(Self {
            incoming: incoming.to_string(),
            path: create_manga_temp(incoming, temporary)?,
            keep: false,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for MangaTempGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = cleanup_manga_temp(&self.incoming, &self.path.to_string_lossy());
        }
    }
}

pub fn output_path(root: &str, output: &str, extension: &str) -> Result<PathBuf, String> {
    let root = absolute_path(root, "输出根目录")?;
    let output = absolute_path(output, "输出文件")?;
    require_child(&root, &output, "输出文件")?;
    if !output
        .extension()
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    {
        return Err(format!("输出文件必须使用 .{extension} 扩展名"));
    }
    fs::create_dir_all(&root).map_err(|error| format!("创建输出根目录失败：{error}"))?;
    let root = fs::canonicalize(root).map_err(|error| format!("校验输出根目录失败：{error}"))?;
    let parent = output.parent().ok_or("输出文件缺少父目录")?;
    let parent = create_parent_within(&root, parent)?;
    if output.exists() {
        return Err("输出文件已存在，为避免覆盖已停止写入".to_string());
    }
    Ok(parent.join(output.file_name().ok_or("输出文件名无效")?))
}

/// Publish a complete file with an atomic, no-overwrite hard link on the same volume.
/// A failed operation only removes the private staging file.
pub struct AtomicOutput {
    path: PathBuf,
    staging: PathBuf,
    file: Option<File>,
}

impl AtomicOutput {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let parent = path.parent().ok_or("输出文件缺少父目录")?;
        let name = format!(
            ".acgn-{}-{}-{}.partial",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        );
        let staging = parent.join(name);
        let file = OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(&staging)
            .map_err(|error| format!("创建临时输出文件失败：{error}"))?;
        Ok(Self {
            path,
            staging,
            file: Some(file),
        })
    }
    pub fn take_file(&mut self) -> File {
        self.file.take().expect("staging file taken once")
    }
    pub fn publish(self, file: File) -> Result<(), String> {
        file.sync_all()
            .map_err(|error| format!("刷新输出文件失败：{error}"))?;
        drop(file);
        fs::hard_link(&self.staging, &self.path).map_err(|error| {
            format!("发布输出文件失败（目标已存在或文件系统不支持安全发布）：{error}")
        })?;
        Ok(())
    }
}

impl Drop for AtomicOutput {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.staging);
    }
}

pub fn move_file_no_replace(source: &Path, destination: &Path) -> Result<(), String> {
    if fs::hard_link(source, destination).is_err() {
        let mut atomic = AtomicOutput::new(destination.to_path_buf())?;
        let mut output = atomic.take_file();
        let mut input =
            File::open(source).map_err(|error| format!("打开待整理文件失败：{error}"))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|error| format!("复制待整理文件失败：{error}"))?;
        atomic.publish(output)?;
    }
    if let Err(error) = fs::remove_file(source) {
        // The destination was created by this operation; keep the original on failure.
        let _ = fs::remove_file(destination);
        return Err(format!("整理后的源文件无法移除，已保留原文件：{error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "acgn-fs-test-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn cleanup_rejects_root_and_unowned_directory() {
        let root = temporary();
        let child = root.join("user-data");
        fs::create_dir(&child).unwrap();
        fs::write(child.join("keep.txt"), "keep").unwrap();
        assert!(cleanup_manga_temp(root.to_str().unwrap(), root.to_str().unwrap()).is_err());
        assert!(cleanup_manga_temp(root.to_str().unwrap(), child.to_str().unwrap()).is_err());
        assert!(child.join("keep.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cleanup_only_removes_created_child() {
        let root = temporary();
        let child = root.join("chapter");
        create_manga_temp(root.to_str().unwrap(), child.to_str().unwrap()).unwrap();
        cleanup_manga_temp(root.to_str().unwrap(), child.to_str().unwrap()).unwrap();
        assert!(!child.exists());
        assert!(root.exists());
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn temp_guard_cleans_early_failure_but_preserves_success_for_packaging() {
        let root = temporary();
        let failed = root.join("failed");
        {
            let _guard =
                MangaTempGuard::create(root.to_str().unwrap(), failed.to_str().unwrap()).unwrap();
        }
        assert!(!failed.exists());
        let completed = root.join("completed");
        {
            let mut guard =
                MangaTempGuard::create(root.to_str().unwrap(), completed.to_str().unwrap())
                    .unwrap();
            guard.keep();
        }
        assert!(completed.exists());
        cleanup_manga_temp(root.to_str().unwrap(), completed.to_str().unwrap()).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn atomic_publish_preserves_concurrent_destination_and_removes_partial() {
        let root = temporary();
        let target = root.join("chapter.txt");
        let mut output = AtomicOutput::new(target.clone()).unwrap();
        let mut file = output.take_file();
        file.write_all(b"new").unwrap();
        fs::write(&target, b"existing").unwrap();
        assert!(output.publish(file).is_err());
        assert_eq!(fs::read(target).unwrap(), b"existing");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn atomic_output_is_invisible_until_complete() {
        let root = temporary();
        let target = root.join("chapter.txt");
        let mut output = AtomicOutput::new(target.clone()).unwrap();
        let mut file = output.take_file();
        file.write_all(b"complete").unwrap();
        assert!(!target.exists());
        output.publish(file).unwrap();
        assert_eq!(fs::read(target).unwrap(), b"complete");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn move_preserves_existing_destination_and_source() {
        let root = temporary();
        let source = root.join("source.bin");
        let destination = root.join("destination.bin");
        fs::write(&source, b"source").unwrap();
        fs::write(&destination, b"destination").unwrap();
        assert!(move_file_no_replace(&source, &destination).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&destination).unwrap(), b"destination");
        fs::remove_file(&destination).unwrap();
        move_file_no_replace(&source, &destination).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"source");
        fs::remove_dir_all(root).unwrap();
    }
}
