use crate::runtime::local_endpoint;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

static SESSIONS: OnceLock<tokio::sync::Mutex<HashMap<String, String>>> = OnceLock::new();

#[derive(serde::Serialize)]
pub struct Response {
    status: u16,
    body: Value,
}

fn request_url(endpoint: &str, path: &str, method: &str) -> Result<reqwest::Url, String> {
    let base = local_endpoint(endpoint, "")?;
    if !path.starts_with("/api/v2/")
        || path.len() > 16_384
        || path.contains(['#', '\\', '\r', '\n'])
    {
        return Err("qBittorrent API 路径无效".to_string());
    }
    let url = base.join(path).map_err(|_| "qBittorrent API 路径无效")?;
    let allowed = match method {
        "GET" => matches!(url.path(), "/api/v2/app/version" | "/api/v2/torrents/info"),
        "POST" => matches!(
            url.path(),
            "/api/v2/torrents/add"
                | "/api/v2/torrents/pause"
                | "/api/v2/torrents/resume"
                | "/api/v2/torrents/stop"
                | "/api/v2/torrents/start"
                | "/api/v2/torrents/delete"
                | "/api/v2/torrents/setDownloadLimit"
        ),
        _ => false,
    };
    if !allowed {
        return Err("不允许调用该 qBittorrent API 或方法".to_string());
    }
    Ok(url)
}

async fn login(
    client: &reqwest::Client,
    endpoint: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<String, String> {
    let (username, password) = (username.unwrap_or(""), password.unwrap_or(""));
    if username.is_empty() || password.is_empty() {
        return Err("qBittorrent 需要登录，请在设置中填写当前会话的账号和密码".to_string());
    }
    if username.len() > 256 || password.len() > 1024 {
        return Err("qBittorrent 登录信息长度无效".to_string());
    }
    let url = local_endpoint(endpoint, "")?
        .join("/api/v2/auth/login")
        .map_err(|error| error.to_string())?;
    let response = client
        .post(url)
        .header("Referer", endpoint)
        .form(&[("username", username), ("password", password)])
        .send()
        .await
        .map_err(|error| format!("连接 qBittorrent 登录接口失败：{error}"))?;
    let status = response.status();
    let sid = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| {
            value
                .split(';')
                .next()
                .filter(|cookie| cookie.starts_with("SID="))
                .map(str::to_string)
        });
    let body = response
        .text()
        .await
        .map_err(|_| "读取 qBittorrent 登录结果失败")?;
    if !status.is_success() || body.trim() != "Ok." {
        return Err("qBittorrent 登录失败，请检查 Web UI 账号、密码和登录限制".to_string());
    }
    sid.ok_or_else(|| "qBittorrent 登录成功但没有返回会话 Cookie".to_string())
}

#[tauri::command]
pub async fn qbittorrent_request(
    endpoint: String,
    path: String,
    method: String,
    body: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<Response, String> {
    if cfg!(mobile) {
        return Err("qBittorrent 本机服务仅适用于桌面端；安卓端不连接 Windows 回环服务".into());
    }
    let method = method.to_ascii_uppercase();
    let url = request_url(&endpoint, &path, &method)?;
    if body.as_ref().is_some_and(|body| body.len() > 128 * 1024) {
        return Err("qBittorrent 请求过大".to_string());
    }
    if method == "GET" && body.is_some() {
        return Err("GET 请求不能包含正文".to_string());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let key = format!(
        "{}|{}",
        local_endpoint(&endpoint, "")?,
        username.as_deref().unwrap_or("")
    );
    let mut sessions = SESSIONS
        .get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
        .lock()
        .await;
    for attempt in 0..2 {
        let mut request = client
            .request(
                if method == "GET" {
                    reqwest::Method::GET
                } else {
                    reqwest::Method::POST
                },
                url.clone(),
            )
            .header("Referer", endpoint.as_str());
        if let Some(cookie) = sessions.get(&key) {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        if let Some(body) = &body {
            request = request
                .header(
                    reqwest::header::CONTENT_TYPE,
                    "application/x-www-form-urlencoded",
                )
                .body(body.clone());
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("连接 qBittorrent 失败：{error}"))?;
        if matches!(response.status().as_u16(), 401 | 403) && attempt == 0 {
            sessions.remove(&key);
            let cookie =
                login(&client, &endpoint, username.as_deref(), password.as_deref()).await?;
            sessions.insert(key.clone(), cookie);
            continue;
        }
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取 qBittorrent 响应失败：{error}"))?
        {
            if bytes.len().saturating_add(chunk.len()) > 8 * 1024 * 1024 {
                return Err("qBittorrent 响应超过 8 MB".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(Response {
            status,
            body: serde_json::from_str(&body).unwrap_or(Value::String(body)),
        });
    }
    Err("qBittorrent 会话恢复失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[test]
    fn proxy_only_allows_local_known_api_routes() {
        assert!(request_url(
            "http://127.0.0.1:8080",
            "/api/v2/torrents/info?tag=acgn-test",
            "GET"
        )
        .is_ok());
        assert!(request_url("http://127.0.0.1:8080", "/api/v2/torrents/add", "POST").is_ok());
        assert!(request_url("http://example.com:8080", "/api/v2/torrents/info", "GET").is_err());
        assert!(request_url(
            "http://localhost:8080",
            "/api/v2/app/setPreferences",
            "POST"
        )
        .is_err());
        assert!(request_url("http://localhost:8080", "/api/v2/torrents/delete", "GET").is_err());
        assert!(request_url(
            "http://localhost:8080",
            "//example.com/api/v2/torrents/info",
            "GET"
        )
        .is_err());
    }

    #[tokio::test]
    async fn expired_session_logs_in_once_and_reuses_sid() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for index in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
                let (status, cookie, body) = match index {
                    0 => ("403 Forbidden", "", "Forbidden"),
                    1 => {
                        assert!(request.starts_with("post /api/v2/auth/login"));
                        (
                            "200 OK",
                            "Set-Cookie: SID=test-session; HttpOnly\r\n",
                            "Ok.",
                        )
                    }
                    2 => {
                        assert!(request.contains("cookie: sid=test-session"));
                        ("200 OK", "", "v5.0.0")
                    }
                    _ => {
                        assert!(request.starts_with("get /api/v2/torrents/info?tag=acgn-test"));
                        assert!(request.contains("cookie: sid=test-session"));
                        ("200 OK", "", "[]")
                    }
                };
                write!(stream, "HTTP/1.1 {status}\r\n{cookie}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let response = qbittorrent_request(
            endpoint.clone(),
            "/api/v2/app/version".into(),
            "GET".into(),
            None,
            Some("example-user".into()),
            Some("example-password".into()),
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, Value::String("v5.0.0".into()));
        let response = qbittorrent_request(
            endpoint,
            "/api/v2/torrents/info?tag=acgn-test".into(),
            "GET".into(),
            None,
            Some("example-user".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(response.body, serde_json::json!([]));
        server.join().unwrap();
    }
}
