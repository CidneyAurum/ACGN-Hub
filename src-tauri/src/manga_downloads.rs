use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub temp_directory: String,
    pub completed: usize,
    pub total: usize,
}

fn active() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct ActiveDownload {
    key: String,
    cancelled: Arc<AtomicBool>,
}

impl ActiveDownload {
    pub fn start(temp_directory: &str) -> Result<Self, String> {
        let mut active = active().lock().map_err(|_| "漫画下载状态不可用")?;
        if active.contains_key(temp_directory) {
            return Err("该漫画临时目录已有下载任务".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(temp_directory.to_string(), cancelled.clone());
        Ok(Self {
            key: temp_directory.to_string(),
            cancelled,
        })
    }
    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("漫画任务已取消".into())
        } else {
            Ok(())
        }
    }
}

impl Drop for ActiveDownload {
    fn drop(&mut self) {
        if let Ok(mut active) = active().lock() {
            if active
                .get(&self.key)
                .is_some_and(|value| Arc::ptr_eq(value, &self.cancelled))
            {
                active.remove(&self.key);
            }
        }
    }
}

#[tauri::command]
pub fn cancel_manga_download(temp_directory: String) -> Result<(), String> {
    if let Some(cancelled) = active()
        .lock()
        .map_err(|_| "漫画下载状态不可用")?
        .get(&temp_directory)
    {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_only_marks_the_matching_active_task_and_does_not_touch_files() {
        let directory = std::env::temp_dir().join(format!(
            "acgn-manga-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("keep.txt"), b"keep").unwrap();
        let key = directory.to_string_lossy().into_owned();
        cancel_manga_download(key.clone()).unwrap();
        assert!(directory.join("keep.txt").exists());
        let download = ActiveDownload::start(&key).unwrap();
        assert!(ActiveDownload::start(&key).is_err());
        cancel_manga_download(format!("{key}-unknown")).unwrap();
        assert!(download.check().is_ok());
        cancel_manga_download(key.clone()).unwrap();
        assert_eq!(download.check().unwrap_err(), "漫画任务已取消");
        assert!(directory.join("keep.txt").exists());
        drop(download);
        let next = ActiveDownload::start(&key).unwrap();
        assert!(next.check().is_ok());
        drop(next);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn cancelled_task_cleanup_only_removes_its_owned_temporary_directory() {
        let root = std::env::temp_dir().join(format!(
            "acgn-manga-owned-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("keep.txt"), b"keep").unwrap();
        let path = root.join("chapter");
        let key = path.to_string_lossy().into_owned();
        {
            let download = ActiveDownload::start(&key).unwrap();
            let _temporary =
                crate::safe_fs::MangaTempGuard::create(root.to_str().unwrap(), &key).unwrap();
            std::fs::write(path.join("page-0001.jpg"), b"downloaded page").unwrap();
            cancel_manga_download(key).unwrap();
            assert!(download.check().is_err());
        }
        assert!(!path.exists());
        assert_eq!(std::fs::read(root.join("keep.txt")).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }
}
