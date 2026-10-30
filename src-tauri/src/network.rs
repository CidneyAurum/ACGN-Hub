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

#[cfg(test)]
mod tests {
    use super::*;
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
