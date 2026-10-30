use std::io::Read;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn terminate(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        // Kill only the process tree created for this request, including pipe-owning children.
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

pub fn python_uses_launcher(executable: &str) -> bool {
    matches!(executable, "py" | "py.exe")
}

fn read_limited(mut reader: impl Read) -> Result<Vec<u8>, String> {
    const LIMIT: usize = 4 * 1024 * 1024;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(bytes);
        }
        // Keep draining pipes even after the output cap, avoiding a child deadlock.
        let remaining = LIMIT.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..count.min(remaining)]);
    }
}

pub fn run_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动子进程失败：{error}"))?;
    let stdout = child.stdout.take().ok_or("子进程 stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("子进程 stderr 不可用")?;
    let out = std::thread::spawn(move || read_limited(stdout));
    let err = std::thread::spawn(move || read_limited(stderr));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                terminate(&mut child);
                break child
                    .wait()
                    .map_err(|error| format!("结束超时子进程失败：{error}"))?;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                terminate(&mut child);
                let _ = child.wait();
                return Err(format!("检查子进程失败：{error}"));
            }
        }
    };
    let stdout = out.join().map_err(|_| "读取子进程输出失败")??;
    let stderr = err.join().map_err(|_| "读取子进程错误输出失败")??;
    if timed_out {
        return Err(format!(
            "Python 请求超过 {} 秒，已停止子进程",
            timeout.as_secs()
        ));
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_py_launcher_receives_version_switch() {
        assert!(python_uses_launcher("py.exe"));
        assert!(python_uses_launcher("py"));
        assert!(!python_uses_launcher("python.exe"));
        assert!(!python_uses_launcher("python"));
    }
    #[test]
    fn subprocess_timeout_reaps_the_child() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/c", "ping -n 4 127.0.0.1 >nul"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 3"]);
            command
        };
        let started = Instant::now();
        assert!(run_with_timeout(&mut command, Duration::from_millis(100)).is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
