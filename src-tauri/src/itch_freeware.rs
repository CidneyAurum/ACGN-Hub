use std::sync::OnceLock;
use std::time::Duration;

const MAX_TEXT_BYTES: usize = 3 * 1024 * 1024;
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(serde::Serialize)]
pub struct ItchFreewareResponse {
    pub status: u16,
    pub body: String,
}

/// The author/slug pairs match the independently audited freeware catalogue.
/// No cookies, arbitrary request headers, payment routes or CDN fetches are accepted.
fn author_slug(host: &str) -> Option<&'static str> {
    match host {
        "npckc.itch.io" => Some("one-night-hot-springs"),
        "brianna-lei.itch.io" => Some("butterfly-soup"),
        "zephyo.itch.io" => Some("missed-message"),
        _ => None,
    }
}

fn allowed_route(url: &reqwest::Url, method: &str) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || url.port().is_some() || url.query().is_some() || url.fragment().is_some()
    { return false; }
    let Some(slug) = author_slug(url.host_str().unwrap_or_default()) else { return false; };
    let parts: Vec<&str> = url.path().trim_start_matches('/').split('/').collect();
    if parts.first().copied() != Some(slug) { return false; }
    match (method, parts.as_slice()) {
        ("GET", [_]) | ("GET", [_, "purchase"]) => true,
        ("GET", [_, "download", key]) => valid_opaque_key(key),
        ("POST", [_, "download_url"]) => true,
        ("POST", [_, "file", id]) => !id.is_empty() && !id.starts_with('0') && id.len() <= 18
            && id.bytes().all(|b| b.is_ascii_digit()),
        _ => false,
    }
}

fn valid_opaque_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 512 { return false; }
    let bytes = key.as_bytes();
    let allowed = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+' | b'/' | b'=');
    let mut index = 0;
    while index < bytes.len() {
        let decoded = if bytes[index] == b'%' {
            if index + 2 >= bytes.len() { return false; }
            let Some(high) = (bytes[index + 1] as char).to_digit(16) else { return false; };
            let Some(low) = (bytes[index + 2] as char).to_digit(16) else { return false; };
            index += 3;
            (high * 16 + low) as u8
        } else { let value = bytes[index]; index += 1; value };
        if !allowed(decoded) { return false; }
    }
    true
}

fn checked_form(body: Option<String>, method: &str) -> Result<Option<String>, String> {
    if method == "GET" {
        return if body.as_ref().is_some_and(|b| !b.is_empty()) {
            Err("itch.io 公开 GET 请求不能带表单".to_string())
        } else { Ok(None) };
    }
    let body = body.ok_or_else(|| "itch.io 公开下载请求缺少源站表单".to_string())?;
    if body.len() > 8192 || body.contains(['\r', '\n', '#']) {
        return Err("itch.io 源站表单无效".to_string());
    }
    let mut parsed = reqwest::Url::parse("https://itch.io/").unwrap();
    parsed.set_query(Some(&body));
    let fields: Vec<_> = parsed.query_pairs().collect();
    if fields.len() != 1 || fields[0].0 != "csrf_token" || fields[0].1.is_empty()
        || fields[0].1.len() > 4096 || !fields[0].1.bytes().all(|b| b.is_ascii_graphic())
    { return Err("itch.io 仅允许提交源站签发的匿名 CSRF 表单".to_string()); }
    Ok(Some(body))
}

fn client() -> Result<reqwest::Client, String> {
    if let Some(client) = CLIENT.get() { return Ok(client.clone()); }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .user_agent(crate::network::USER_AGENT)
        .referer(false)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 { return attempt.error("itch.io 重定向次数超过限制"); }
            if crate::network::public_url(attempt.url()).is_err()
                || !(allowed_route(attempt.url(), "GET") || allowed_route(attempt.url(), "POST"))
            { return attempt.error("itch.io 重定向离开已核验的公开下载路由"); }
            attempt.follow()
        }))
        .build().map_err(|_| "无法建立 itch.io 公开请求客户端".to_string())?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

#[tauri::command]
pub async fn itch_freeware_request(
    url: String,
    method: String,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ItchFreewareResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "itch.io 来源地址无效".to_string())?;
    let method = method.to_ascii_uppercase();
    if !allowed_route(&parsed, &method) { return Err("itch.io 请求不属于已核验作者的公开免费获取路由".to_string()); }
    crate::network::public_url(&parsed)?;
    let form = checked_form(body, &method)?;
    let referer = format!("https://{}/{}", parsed.host_str().unwrap_or_default(), author_slug(parsed.host_str().unwrap_or_default()).unwrap());
    let mut request = client()?.request(
        if method == "POST" { reqwest::Method::POST } else { reqwest::Method::GET }, parsed,
    ).timeout(Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(500, 30_000)))
        .header(reqwest::header::ACCEPT, "text/html, application/json")
        .header(reqwest::header::REFERER, referer);
    if let Some(form) = form {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(form);
    }
    let mut response = request.send().await.map_err(|e| crate::network::request_error(&e))?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|n| n > MAX_TEXT_BYTES as u64) {
        return Err("itch.io 页面超过读取上限".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| crate::network::request_error(&e))? {
        if bytes.len().saturating_add(chunk.len()) > MAX_TEXT_BYTES {
            return Err("itch.io 页面超过读取上限".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "itch.io 返回了非 UTF-8 页面".to_string())?;
    Ok(ItchFreewareResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn freeware_routes_allow_only_the_audited_author_game_pairs() {
        for (method, url) in [
            ("GET", "https://npckc.itch.io/one-night-hot-springs"),
            ("GET", "https://brianna-lei.itch.io/butterfly-soup/purchase"),
            ("GET", "https://zephyo.itch.io/missed-message/download/anonymous-issued_key.123"),
            ("GET", "https://npckc.itch.io/one-night-hot-springs/download/anonymous%2Bkey%3D%3D.signature%2Fpiece"),
            ("POST", "https://npckc.itch.io/one-night-hot-springs/download_url"),
            ("POST", "https://npckc.itch.io/one-night-hot-springs/file/2436127"),
        ] { assert!(allowed_route(&reqwest::Url::parse(url).unwrap(), method)); }
        for (method, url) in [
            ("GET", "http://npckc.itch.io/one-night-hot-springs"),
            ("GET", "https://npckc.itch.io/a-year-of-springs"),
            ("GET", "https://npckc.itch.io.evil.example/one-night-hot-springs"),
            ("GET", "https://npckc.itch.io/one-night-hot-springs?token=anything"),
            ("GET", "https://npckc.itch.io/one-night-hot-springs/download/key%0Asecret"),
            ("GET", "https://user:pass@npckc.itch.io/one-night-hot-springs"),
            ("POST", "https://npckc.itch.io/one-night-hot-springs/purchase"),
            ("POST", "https://npckc.itch.io/one-night-hot-springs/file/0"),
            ("POST", "https://npckc.itch.io/one-night-hot-springs/file/123/extra"),
            ("DELETE", "https://npckc.itch.io/one-night-hot-springs"),
        ] { assert!(!allowed_route(&reqwest::Url::parse(url).unwrap(), method)); }
    }
    #[test]
    fn freeware_form_is_bounded_and_cannot_carry_cookies_rewards_or_payment_fields() {
        assert!(checked_form(None, "GET").is_ok());
        assert!(checked_form(Some("csrf_token=author-issued%2Btoken%3D".to_string()), "POST").is_ok());
        for form in ["", "csrf_token=", "csrf_token=a&csrf_token=b", "csrf_token=a&reward_id=1", "Cookie=user-secret", "price=0", "csrf_token=a%0D%0Aheader"] {
            assert!(checked_form(Some(form.to_string()), "POST").is_err());
        }
        assert!(checked_form(Some("csrf_token=a".to_string()), "GET").is_err());
        assert!(checked_form(Some(format!("csrf_token={}", "x".repeat(9000))), "POST").is_err());
    }
}
