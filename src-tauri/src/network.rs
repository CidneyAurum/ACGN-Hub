use std::sync::OnceLock;
use std::time::Duration;

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ACGN-Hub/0.3";
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn public_url(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("网络地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址".to_string());
    }
    if crate::is_private_feed_host(url.host_str().unwrap_or_default()) {
        return Err("公共来源地址不能指向本机或私有网络".to_string());
    }
    Ok(())
}

pub fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("重定向次数超过 5 次");
        }
        if public_url(attempt.url()).is_err() {
            return attempt.error("重定向目标不是有效公共 HTTP 地址");
        }
        // reqwest strips Authorization/Cookie on cross-origin redirects.
        attempt.follow()
    })
}

pub fn client() -> Result<reqwest::Client, String> {
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    // Keep platform DNS, connection pooling and configured proxies consistent for
    // API requests, images and chapter downloads. Do not pin CDN DNS or disable proxies.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(35))
        .redirect(redirect_policy())
        .referer(false)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

/// Keep transport failures useful across IPC without disclosing request URLs,
/// query tokens, proxy credentials, or arbitrary upstream error text.
pub fn request_error(error: &reqwest::Error) -> String {
    use std::error::Error;
    let mut messages = Vec::new();
    // The top-level Display includes the request URL; a query such as
    // ?name=certificate must not turn a plain connection error into a TLS error.
    let mut current: Option<&(dyn Error + 'static)> = error.source();
    while let Some(cause) = current {
        messages.push(cause.to_string());
        if messages.len() >= 12 { break; }
        current = cause.source();
    }
    let code = transport_error_code(error.is_timeout(), error.is_connect(),
        error.is_body() || error.is_decode(), &messages.join(" ").to_ascii_lowercase());
    let description = match code {
        "NETWORK_TIMEOUT" => "请求超时",
        "NETWORK_DNS" => "域名解析失败",
        "NETWORK_TLS" => "HTTPS 证书或握手失败",
        "NETWORK_CONNECT" => "无法建立网络连接",
        "NETWORK_READ" => "网络响应读取失败",
        _ => "网络请求失败",
    };
    // reqwest's stored URL can contain a private RSS token. Only its host is public.
    let host = error.url().and_then(|url| url.host_str());
    match host {
        Some(host) => format!("[{code}] {description}（{host}）"),
        None => format!("[{code}] {description}"),
    }
}

fn transport_error_code(timeout: bool, connect: bool, read: bool, causes: &str) -> &'static str {
    if timeout { return "NETWORK_TIMEOUT"; }
    // Inspect the error's source chain: the top-level reqwest Display usually
    // says only 'error sending request', while DNS/TLS details are nested.
    if ["dns error", "dns lookup", "name resolution", "failed to lookup", "nodename nor servname",
        "name or service not known", "no such host", "unable to resolve host", "getaddrinfo"]
        .iter().any(|marker| causes.contains(marker)) { return "NETWORK_DNS"; }
    if ["certificate", "tls", "ssl", "invalid peer", "unknown issuer", "handshake failure"]
        .iter().any(|marker| causes.contains(marker)) { return "NETWORK_TLS"; }
    if connect { return "NETWORK_CONNECT"; }
    if read { return "NETWORK_READ"; }
    "NETWORK_REQUEST"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_causes_classify_nested_dns_tls_and_timeout_before_generic_connect() {
        assert_eq!(transport_error_code(false, true, false, "error sending request dns error: failed to lookup address information"), "NETWORK_DNS");
        assert_eq!(transport_error_code(false, true, false, "client error connect invalid peer certificate: unknownissuer"), "NETWORK_TLS");
        assert_eq!(transport_error_code(true, true, false, "connection timed out"), "NETWORK_TIMEOUT");
        assert_eq!(transport_error_code(false, true, false, "connection refused"), "NETWORK_CONNECT");
        assert_eq!(transport_error_code(false, false, true, "body stream failed"), "NETWORK_READ");
        assert_eq!(transport_error_code(false, false, false, "unknown"), "NETWORK_REQUEST");
    }

    #[tokio::test]
    async fn connection_errors_keep_category_without_disclosing_private_query() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}/private?token=synthetic-secret&hint=certificate+dns+tls");
        let error = reqwest::Client::builder().no_proxy().build().unwrap()
            .get(url).send().await.unwrap_err();
        let displayed = request_error(&error);
        assert!(displayed.starts_with("[NETWORK_CONNECT]"), "{displayed}");
        assert!(displayed.contains("127.0.0.1"));
        assert!(!displayed.contains("synthetic-secret"));
        assert!(!displayed.contains("/private"));
        assert!(!displayed.contains("token="));
    }
    #[test]
    fn public_targets_allow_dynamic_cdn_but_reject_credentials_and_localhost() {
        for url in [
            "https://so.mangafunb.fun/o/cover.jpg",
            "https://uploads.mangadex.org/covers/a/b.png",
            "https://lain.bgm.tv/r/400/pic/cover.jpg",
        ] {
            assert!(public_url(&reqwest::Url::parse(url).unwrap()).is_ok());
        }
        for url in [
            "file:///C:/secret",
            "http://localhost:80/image",
            "http://127.0.0.1/image",
            "https://user:pass@example.org/image",
        ] {
            assert!(public_url(&reqwest::Url::parse(url).unwrap()).is_err());
        }
    }
}
