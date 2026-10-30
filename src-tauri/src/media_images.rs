use crate::{image_format::ImageFormat, network, safe_fs::AtomicOutput};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, SystemTime};
use tauri::Manager;

const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
static IN_FLIGHT: OnceLock<tokio::sync::Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResponse {
    cache_key: String,
    mime_type: String,
}

pub fn cache_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = if let Some(profile) = crate::runtime::portable_data_directory()? {
        profile.join("Cache")
    } else {
        app.path()
            .app_cache_dir()
            .map_err(|error| format!("定位图片缓存失败：{error}"))?
    };
    Ok(root.join("covers"))
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    ImageFormat::detect(bytes).map(ImageFormat::mime)
}

fn referer(url: &reqwest::Url, explicit: Option<&str>) -> Result<String, String> {
    if let Some(explicit) = explicit.filter(|value| !value.trim().is_empty()) {
        if explicit.len() > 4096 {
            return Err("图片 Referer 过长".into());
        }
        let parsed = reqwest::Url::parse(explicit).map_err(|_| "图片 Referer 无效")?;
        network::public_url(&parsed)?;
        return Ok(parsed.to_string());
    }
    let host = url.host_str().unwrap_or_default();
    Ok(
        if host.ends_with("bgm.tv") || host.ends_with("bangumi.tv") {
            "https://bgm.tv/".to_string()
        } else if host.ends_with("mangadex.org") {
            "https://mangadex.org/".to_string()
        } else if host == "mangabz.com" || host.ends_with(".mangabz.com") {
            "https://mangabz.com/".to_string()
        } else if host.contains("manga") && !host.ends_with("mangadex.org") {
            "https://www.mangacopy.com/".to_string()
        } else {
            format!("{}/", url.origin().ascii_serialization())
        },
    )
}

fn cache_path(directory: &Path, key: &str) -> Result<PathBuf, String> {
    if key.len() != 64 || !key.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("图片缓存标识无效".into());
    }
    Ok(directory.join(format!("{key}.image")))
}

fn cached_image(directory: &Path, key: &str) -> Result<(Vec<u8>, &'static str), String> {
    let path = cache_path(directory, key)?;
    let metadata = std::fs::metadata(&path).map_err(|_| "图片缓存不存在")?;
    if metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err("图片缓存过大".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "读取图片缓存失败")?;
    let mime = image_mime(&bytes).ok_or("缓存不是可显示的图片")?;
    Ok((bytes, mime))
}

async fn fetch_image(
    directory: PathBuf,
    raw_url: String,
    explicit_referer: Option<String>,
) -> Result<ImageResponse, String> {
    let url = reqwest::Url::parse(raw_url.trim()).map_err(|_| "图片地址无效")?;
    network::public_url(&url)?;
    let referer = referer(&url, explicit_referer.as_deref())?;
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{}\n{referer}", url.as_str()).as_bytes())
    );
    let lock = {
        let mut pending = IN_FLIGHT
            .get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
            .lock()
            .await;
        pending.retain(|_, lock| lock.strong_count() > 0);
        let lock = pending
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
        pending.insert(key.clone(), Arc::downgrade(&lock));
        lock
    };
    let _guard = lock.lock().await;
    if let Ok((_, mime)) = cached_image(&directory, &key) {
        return Ok(ImageResponse {
            cache_key: key,
            mime_type: mime.into(),
        });
    }
    // Only files addressed by this cache's validated hash are eligible for replacement.
    if let Ok(path) = cache_path(&directory, &key) {
        if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
    let client = network::client()?;
    let response = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5",
        )
        .header(reqwest::header::REFERER, referer)
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(|error| format!("加载封面失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "封面服务器返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    // Some CopyManga CDNs serve JPEG as binary/octet-stream; validate magic bytes.
    let bytes = crate::read_http_bytes(response, MAX_IMAGE_BYTES).await?;
    let mime = image_mime(&bytes).ok_or("封面响应不是受支持图片，可能是来源错误页")?;
    std::fs::create_dir_all(&directory).map_err(|error| format!("创建图片缓存失败：{error}"))?;
    let path = cache_path(&directory, &key)?;
    if !path.exists() {
        let mut output = AtomicOutput::new(path)?;
        let mut file = output.take_file();
        file.write_all(&bytes)
            .map_err(|error| format!("缓存封面失败：{error}"))?;
        output.publish(file)?;
    }
    let prune_directory = directory.clone();
    tauri::async_runtime::spawn_blocking(move || prune_cache(&prune_directory));
    Ok(ImageResponse {
        cache_key: key,
        mime_type: mime.into(),
    })
}

fn prune_cache(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("image") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((
                path,
                metadata.len(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ))
        })
        .collect::<Vec<_>>();
    let mut size: u64 = files.iter().map(|(_, size, _)| size).sum();
    if size <= MAX_CACHE_BYTES && files.len() <= 1500 {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    let mut count = files.len();
    for (path, bytes, _) in files {
        if size <= MAX_CACHE_BYTES && count <= 1500 {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            size = size.saturating_sub(bytes);
            count -= 1;
        }
    }
}

#[tauri::command]
pub async fn media_image_request(
    app: tauri::AppHandle,
    url: String,
    referer: Option<String>,
) -> Result<ImageResponse, String> {
    fetch_image(cache_directory(&app)?, url, referer).await
}

pub fn respond_image_protocol(
    app: tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let key = request.uri().path().trim_start_matches('/');
        let result = cache_directory(&app).and_then(|directory| cached_image(&directory, key));
        let response = match result {
            Ok((bytes, mime)) => tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Cache-Control", "public, max-age=604800, immutable")
                .header("X-Content-Type-Options", "nosniff")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .body(bytes),
            Err(_) => tauri::http::Response::builder()
                .status(404)
                .header("Content-Type", "text/plain")
                .body(b"Image unavailable".to_vec()),
        };
        if let Ok(response) = response {
            responder.respond(response);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detect_real_image_bytes_instead_of_trusting_cdn_content_type() {
        assert_eq!(image_mime(b"\xff\xd8\xffimage"), Some("image/jpeg"));
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\nimage"), Some("image/png"));
        assert_eq!(image_mime(b"<html>HTTP 403</html>"), None);
        assert!(cache_path(Path::new("cache"), "../private").is_err());
    }
    #[test]
    fn cover_referers_follow_the_source() {
        for (url, expected) in [
            ("https://cover.mangabz.com/cover.jpg", "https://mangabz.com/"),
        ] {
            assert_eq!(referer(&reqwest::Url::parse(url).unwrap(), None).unwrap(), expected);
        }
        assert_eq!(
            referer(
                &reqwest::Url::parse("https://lain.bgm.tv/cover.jpg").unwrap(),
                None
            )
            .unwrap(),
            "https://bgm.tv/"
        );
        assert_eq!(
            referer(
                &reqwest::Url::parse("https://so.mangafunb.fun/cover.jpg").unwrap(),
                None
            )
            .unwrap(),
            "https://www.mangacopy.com/"
        );
    }
    #[tokio::test]
    #[ignore = "Live network probe; run explicitly after sources are reachable"]
    async fn live_covers_and_redirect_are_cached_as_real_images() {
        let directory =
            std::env::temp_dir().join(format!("acgn-live-covers-{}", std::process::id()));
        let urls = ["https://api.bgm.tv/v0/subjects/253/image?type=medium", "https://so.mangafunb.fun/o/onepiecewanodiaries/cover/1760773144.jpg.328x422.jpg", "https://uploads.mangadex.org/covers/a1c7c817-4e59-43b7-9365-09675a149a6f/2f4aca53-64c7-46ac-ae85-3bc9b3169890.png.256.jpg"];
        let results = tokio::join!(
            fetch_image(directory.clone(), urls[0].into(), None),
            fetch_image(directory.clone(), urls[1].into(), None),
            fetch_image(directory.clone(), urls[2].into(), None)
        );
        for (url, result) in urls.into_iter().zip([results.0, results.1, results.2]) {
            let image = result.unwrap_or_else(|error| panic!("{url}: {error}"));
            let (bytes, mime) = cached_image(&directory, &image.cache_key).unwrap();
            println!("cover={url} bytes={} mime={mime}", bytes.len());
            assert!(!bytes.is_empty());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
