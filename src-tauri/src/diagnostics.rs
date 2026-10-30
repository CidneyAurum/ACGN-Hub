use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

static LOG: OnceLock<Mutex<File>> = OnceLock::new();

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let directory = if let Some(profile) = crate::runtime::portable_data_directory()? {
        profile.join("Logs")
    } else {
        app.path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("Logs")
    };
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("runtime.log");
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 4 * 1024 * 1024) {
        let previous = directory.join("runtime.previous.log");
        let _ = std::fs::remove_file(&previous);
        let _ = std::fs::rename(&path, previous);
    }
    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let _ = LOG.set(Mutex::new(file));
    record("runtime.initialize");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(location) = info.location() {
            record(&format!(
                "runtime.panic at {}:{}",
                location.file(),
                location.line()
            ));
        } else {
            record("runtime.panic");
        }
        previous(info);
    }));
    Ok(())
}

pub fn record(event: &str) {
    let Some(log) = LOG.get() else {
        return;
    };
    let milliseconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    if let Ok(mut log) = log.lock() {
        let safe_event = event.replace(['\r', '\n'], " ");
        let _ = writeln!(
            log,
            "{milliseconds} pid={} thread={:?} name={} {safe_event}",
            std::process::id(),
            std::thread::current().id(),
            std::thread::current().name().unwrap_or("unnamed")
        );
        let _ = log.flush();
    }
}

/// Record completion even if the future is dropped before returning a result.
pub struct Operation {
    name: &'static str,
    completed: bool,
}
impl Operation {
    pub fn start(name: &'static str, detail: &str) -> Self {
        record(&format!("{name}.start {detail}"));
        Self {
            name,
            completed: false,
        }
    }
    pub fn finish(&mut self, success: bool) {
        record(&format!("{}.finish success={success}", self.name));
        self.completed = true;
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if !self.completed {
            record(&format!("{}.dropped before_completion", self.name));
        }
    }
}
