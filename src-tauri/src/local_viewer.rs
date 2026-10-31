//! Read-only, revocable access to completed local media. Archive contents are
//! never extracted and protocol URLs contain opaque sessions, never file paths.
use crate::{downloaded_media::validated_media, image_format::ImageFormat};
use std::cmp::Ordering;
use std::collections::{hash_map::RandomState, HashMap};
use std::fs::{File, Metadata, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::http::{header, Method, Request, Response, StatusCode};

const MAX_SESSIONS: usize = 8;
const MAX_PAGES: usize = 1_000;
const MAX_ZIP_ENTRIES: usize = 4_096;
const MAX_PAGE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 500 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_VIDEO_CHUNK: u64 = 8 * 1024 * 1024;
static NONCE: AtomicU64 = AtomicU64::new(0);
static DOCUMENT_EPOCH: AtomicU64 = AtomicU64::new(0);
type Sessions = Mutex<HashMap<String, Arc<Session>>>;
static SESSIONS: OnceLock<Sessions> = OnceLock::new();

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedLocalViewer {
    session_id: String,
    kind: &'static str,
    title: String,
    page_count: Option<usize>,
    size_bytes: u64,
    modified_at: String,
    text: Option<String>,
}

struct Session {
    active: AtomicBool,
    media: Mutex<LocalMedia>,
}

struct LocalMedia {
    path: PathBuf,
    allowed_root: String,
    canonical_root: PathBuf,
    file: File,
    snapshot: FileSnapshot,
    content: Content,
}

enum Content {
    Comic(Vec<ComicPage>),
    Video(&'static str),
    Text,
}

#[derive(Clone, Debug)]
struct ComicPage {
    index: usize,
    name: String,
    size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileSnapshot {
    size: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl FileSnapshot {
    fn from(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }
}

fn sessions() -> &'static Sessions {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn open_read_only(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    // Keep the selected Windows file from being overwritten/renamed while a
    // viewer owns its handle. Other readers and system players remain allowed.
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x0000_0001); // FILE_SHARE_READ
    }
    options.open(path).map_err(|_| "无法只读打开本地文件；文件可能正在使用或已被移动".into())
}

fn unique_session_id() -> String {
    let nonce = NONCE.fetch_add(1, AtomicOrdering::Relaxed);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    // RandomState is seeded independently for both halves, rather than exposing
    // timestamps or sequential IDs as protocol capabilities. No token is logged.
    let mut first = RandomState::new().build_hasher();
    first.write_u64(nonce);
    first.write_u128(now);
    let mut second = RandomState::new().build_hasher();
    second.write_u64(nonce);
    second.write_u128(now);
    format!("{:016x}{:016x}", first.finish(), second.finish())
}

fn extension(path: &Path) -> String {
    path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase()
}

fn video_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mkv" => Some("video/x-matroska"),
        "mov" => Some("video/quicktime"),
        "avi" => Some("video/x-msvideo"),
        "ts" => Some("video/mp2t"),
        _ => None,
    }
}

#[cfg(test)]
fn prepare_impl(path: String, allowed_root: String) -> Result<PreparedLocalViewer, String> {
    prepare_at_epoch(path, allowed_root, DOCUMENT_EPOCH.load(AtomicOrdering::Acquire))
}

fn prepare_at_epoch(path: String, allowed_root: String, epoch: u64) -> Result<PreparedLocalViewer, String> {
    let checked = validated_media(&path, &allowed_root)?;
    let canonical_root = std::fs::canonicalize(&allowed_root).map_err(|_| "本地阅读根目录不可用")?;
    let before = std::fs::metadata(&checked).map_err(|_| "本地文件不可用")?;
    let mut file = open_read_only(&checked)?;
    let metadata = file.metadata().map_err(|_| "无法读取本地文件信息")?;
    if !metadata.is_file() || FileSnapshot::from(&before) != FileSnapshot::from(&metadata)
        || validated_media(&path, &allowed_root)? != checked {
        return Err("本地文件在打开时发生变化，请重新打开".into());
    }
    let snapshot = FileSnapshot::from(&metadata);
    let ext = extension(&checked);
    let (content, kind, page_count, text) = if ext == "cbz" {
        if snapshot.size > MAX_ARCHIVE_BYTES { return Err("漫画归档超过 512 MB，无法在应用内阅读".into()); }
        let pages = list_comic_pages(&mut file)?;
        let count = pages.len();
        (Content::Comic(pages), "comic", Some(count), None)
    } else if ext == "txt" {
        let text = read_text(&mut file, snapshot.size)?;
        (Content::Text, "text", None, Some(text))
    } else if let Some(mime) = video_mime(&ext) {
        if snapshot.size == 0 { return Err("视频文件为空，无法播放".into()); }
        (Content::Video(mime), "video", None, None)
    } else {
        return Err("应用内阅读目前支持 CBZ 漫画、UTF-8 TXT 小说和本地视频；其它格式请用系统程序打开".into());
    };
    let title = checked.file_name().and_then(|name| name.to_str()).unwrap_or("本地文件").to_owned();
    let modified_at = snapshot.modified.and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos().to_string()).unwrap_or_else(|| "0".into());
    let size_bytes = snapshot.size;
    let media = LocalMedia { path: checked, allowed_root, canonical_root, file, snapshot, content };
    let session = Arc::new(Session { active: AtomicBool::new(true), media: Mutex::new(media) });
    let mut all = sessions().lock().map_err(|_| "本地阅读会话不可用")?;
    // A page reload can finish while this file is being inspected. Never let
    // an old document's delayed preparation allocate a new capability afterward.
    if DOCUMENT_EPOCH.load(AtomicOrdering::Acquire) != epoch {
        return Err("阅读页面已重新加载，请重新打开本地文件".into());
    }
    if all.len() >= MAX_SESSIONS { return Err("打开的本地阅读会话过多，请先关闭其它阅读页".into()); }
    let session_id = loop {
        let token = unique_session_id();
        if !all.contains_key(&token) { break token; }
    };
    all.insert(session_id.clone(), session);
    crate::diagnostics::record(&format!("local_viewer.prepare kind={kind} pages={}", page_count.unwrap_or(0)));
    Ok(PreparedLocalViewer { session_id, kind, title, page_count, size_bytes, modified_at, text })
}

#[tauri::command]
pub async fn prepare_local_viewer(path: String, allowed_root: String) -> Result<PreparedLocalViewer, String> {
    // Capture before queuing blocking work; otherwise a delayed worker could
    // accidentally inherit the new page's epoch after a hard reload.
    let epoch = DOCUMENT_EPOCH.load(AtomicOrdering::Acquire);
    crate::run_blocking(move || prepare_at_epoch(path, allowed_root, epoch)).await
}

/// Called for the main webview's `PageLoadEvent::Started`, including Ctrl+R.
/// Native revocation does not depend on an unloading document delivering IPC.
/// The same short registry lock protects both reset and prepare publication.
pub fn reset_local_viewer_sessions() {
    if let Ok(mut all) = sessions().lock() {
        DOCUMENT_EPOCH.fetch_add(1, AtomicOrdering::AcqRel);
        let count = all.len();
        for (_, session) in all.drain() { session.active.store(false, AtomicOrdering::Release); }
        crate::diagnostics::record(&format!("local_viewer.reset sessions={count}"));
    }
}

#[tauri::command]
pub fn close_local_viewer(session_id: String) -> Result<(), String> {
    let removed = sessions().lock().map_err(|_| "本地阅读会话不可用")?.remove(&session_id);
    if let Some(session) = removed {
        session.active.store(false, AtomicOrdering::Release);
        crate::diagnostics::record("local_viewer.close");
    }
    Ok(())
}

fn read_text(file: &mut File, declared_size: u64) -> Result<String, String> {
    if declared_size > MAX_TEXT_BYTES { return Err("TXT 超过 20 MB，请使用系统阅读器打开".into()); }
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法读取 TXT 文件")?;
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "无法读取 TXT 文件")?;
    if bytes.len() as u64 > MAX_TEXT_BYTES { return Err("TXT 超过 20 MB，请使用系统阅读器打开".into()); }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    // Return plain text only. The Vue reader renders this with interpolation,
    // never as HTML; script-like content must remain literal data.
    String::from_utf8(bytes.to_vec()).map_err(|_| "TXT 不是 UTF-8 编码，请转换编码后再打开".into())
}

fn image_entry(name: &str) -> bool {
    matches!(Path::new(name).extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif")
}

fn list_comic_pages(file: &mut File) -> Result<Vec<ComicPage>, String> {
    preflight_zip_directory(file)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "CBZ 不是有效的 ZIP 漫画归档，或文件已损坏")?;
    if archive.len() > MAX_ZIP_ENTRIES { return Err("CBZ 归档条目过多，已停止读取".into()); }
    let mut pages = Vec::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| "CBZ 包含无法读取或加密的条目")?;
        if entry.encrypted() { return Err("应用内阅读不支持加密 CBZ".into()); }
        if entry.is_dir() { continue; }
        total = total.checked_add(entry.size()).ok_or("CBZ 解压大小无效")?;
        if total > MAX_UNCOMPRESSED_BYTES { return Err("CBZ 总解压大小超过 500 MB，已停止读取".into()); }
        if !image_entry(entry.name()) { continue; }
        // No extraction occurs, but reject traversal/symlink names anyway so a
        // malformed archive cannot be mistaken for a regular ordered chapter.
        let name = entry.name().replace('\\', "/");
        if entry.enclosed_name().is_none() || name.starts_with('/') || name.split('/').any(|part| part == "..")
            || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err("CBZ 包含无效图片路径或链接，已停止读取".into());
        }
        if entry.size() == 0 || entry.size() > MAX_PAGE_BYTES { return Err("CBZ 单页大小无效或超过 50 MB".into()); }
        // A small highly compressed image remains valid; only ratios that are
        // wildly beyond image compression are refused before decompression.
        if entry.size() > 1024 * 1024 && entry.size() / entry.compressed_size().max(1) > 1000 {
            return Err("CBZ 图片压缩比例异常，已停止读取".into());
        }
        pages.push(ComicPage { index, name, size: entry.size() });
        if pages.len() > MAX_PAGES { return Err("CBZ 图片页数超过 1000 页，已停止读取".into()); }
    }
    if pages.is_empty() { return Err("CBZ 中没有可阅读的 JPG、PNG、WEBP、GIF 或 AVIF 图片".into()); }
    pages.sort_by(|left, right| natural_compare(&left.name, &right.name).then(left.index.cmp(&right.index)));
    Ok(pages)
}

/// Reject an oversized central directory before `ZipArchive` allocates its
/// entry table. A normal CBZ produced by this application has a classic EOCD;
/// ZIP64 or a missing EOCD is rejected as unsupported/corrupt rather than
/// allowing an unbounded entry count to reach the ZIP parser.
fn preflight_zip_directory(file: &mut File) -> Result<(), String> {
    let size = file.metadata().map_err(|_| "无法读取 CBZ 文件信息")?.len();
    let tail_size = size.min(65_557) as usize; // EOCD + maximum ZIP comment.
    file.seek(SeekFrom::End(-(tail_size as i64))).map_err(|_| "无法读取 CBZ 目录")?;
    let mut tail = vec![0_u8; tail_size];
    file.read_exact(&mut tail).map_err(|_| "无法读取 CBZ 目录")?;
    let eocd = tail.windows(4).rposition(|bytes| bytes == b"PK\x05\x06")
        .ok_or("CBZ 缺少有效 ZIP 目录，或文件已损坏")?;
    if eocd + 22 > tail.len() { return Err("CBZ ZIP 目录不完整".into()); }
    let entries_here = u16::from_le_bytes([tail[eocd + 8], tail[eocd + 9]]) as usize;
    let entries_total = u16::from_le_bytes([tail[eocd + 10], tail[eocd + 11]]) as usize;
    let central_size = u32::from_le_bytes(tail[eocd + 12..eocd + 16].try_into().unwrap());
    let central_offset = u32::from_le_bytes(tail[eocd + 16..eocd + 20].try_into().unwrap());
    let comment_size = u16::from_le_bytes([tail[eocd + 20], tail[eocd + 21]]) as usize;
    if eocd + 22 + comment_size != tail.len() { return Err("CBZ ZIP 目录或注释长度无效".into()); }
    if entries_here == u16::MAX as usize || entries_total == u16::MAX as usize
        || central_size == u32::MAX || central_offset == u32::MAX
        || eocd >= 20 && &tail[eocd - 20..eocd - 16] == b"PK\x06\x07" {
        return Err("CBZ ZIP64 目录暂不支持".into());
    }
    if entries_here != entries_total { return Err("应用内阅读不支持分卷 CBZ".into()); }
    if entries_here > MAX_ZIP_ENTRIES { return Err("CBZ 归档条目过多，已停止读取".into()); }
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法定位 CBZ 文件")?;
    Ok(())
}

/// Numeric runs compare as integers without parsing (and cannot overflow), so
/// directory/2.jpg precedes directory/10.jpg and zero-padded pages stay stable.
fn natural_compare(left: &str, right: &str) -> Ordering {
    let left = left.to_lowercase();
    let right = right.to_lowercase();
    let (left, right) = (left.as_bytes(), right.as_bytes());
    let (mut a, mut b) = (0, 0);
    while a < left.len() && b < right.len() {
        if left[a].is_ascii_digit() && right[b].is_ascii_digit() {
            let (start_a, start_b) = (a, b);
            while a < left.len() && left[a].is_ascii_digit() { a += 1; }
            while b < right.len() && right[b].is_ascii_digit() { b += 1; }
            let mut significant_a = start_a;
            let mut significant_b = start_b;
            while significant_a < a && left[significant_a] == b'0' { significant_a += 1; }
            while significant_b < b && right[significant_b] == b'0' { significant_b += 1; }
            let compared = (a - significant_a).cmp(&(b - significant_b))
                .then_with(|| left[significant_a..a].cmp(&right[significant_b..b]))
                .then_with(|| (a - start_a).cmp(&(b - start_b)));
            if compared != Ordering::Equal { return compared; }
        } else {
            let compared = left[a].cmp(&right[b]);
            if compared != Ordering::Equal { return compared; }
            a += 1;
            b += 1;
        }
    }
    left.len().cmp(&right.len())
}

fn validate_unchanged(media: &LocalMedia) -> Result<(), String> {
    let root = std::fs::canonicalize(&media.allowed_root).map_err(|_| "本地文件根目录已变化，请重新打开")?;
    if root != media.canonical_root { return Err("本地文件根目录已变化，请重新打开".into()); }
    let current = validated_media(media.path.to_string_lossy().as_ref(), &media.allowed_root)
        .map_err(|_| "本地文件路径已变化，请重新打开")?;
    if current != media.path { return Err("本地文件路径已变化，请重新打开".into()); }
    let path_metadata = std::fs::metadata(&current).map_err(|_| "本地文件已不可用，请重新打开")?;
    let handle_metadata = media.file.metadata().map_err(|_| "本地文件已不可用，请重新打开")?;
    if FileSnapshot::from(&path_metadata) != media.snapshot || FileSnapshot::from(&handle_metadata) != media.snapshot {
        return Err("本地文件内容已变化，请重新打开".into());
    }
    Ok(())
}

fn response(status: StatusCode, mime: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder().status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes).expect("fixed local viewer response headers")
}

fn protocol_error(status: StatusCode, message: &str, head: bool) -> Response<Vec<u8>> {
    let mut reply = response(status, "text/plain; charset=utf-8", if head { Vec::new() } else { message.as_bytes().to_vec() });
    reply.headers_mut().insert(header::CONTENT_LENGTH, message.len().into());
    reply
}

fn read_comic_page(media: &mut LocalMedia, page: usize, head: bool) -> Result<Response<Vec<u8>>, String> {
    let Content::Comic(pages) = &media.content else { return Err("此会话不是漫画阅读会话".into()); };
    let chosen = pages.get(page).cloned().ok_or("漫画页码超出范围")?;
    let mut archive = zip::ZipArchive::new(&mut media.file).map_err(|_| "CBZ 已损坏，无法读取")?;
    let mut entry = archive.by_index(chosen.index).map_err(|_| "无法读取此漫画页")?;
    if entry.name().replace('\\', "/") != chosen.name || entry.size() != chosen.size { return Err("漫画归档内容已变化，请重新打开".into()); }
    let mut bytes = Vec::new();
    (&mut entry).take(MAX_PAGE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "漫画页已损坏，无法读取")?;
    if bytes.len() as u64 > MAX_PAGE_BYTES || bytes.len() as u64 != chosen.size { return Err("漫画页大小无效或超过 50 MB".into()); }
    let mime = ImageFormat::detect(&bytes).map(ImageFormat::mime).ok_or("此漫画页不是受支持的真实图片")?;
    let length = bytes.len();
    crate::diagnostics::record(&format!("local_viewer.page index={page} bytes={length}"));
    let mut reply = response(StatusCode::OK, mime, if head { Vec::new() } else { bytes });
    reply.headers_mut().insert(header::CONTENT_LENGTH, length.into());
    Ok(reply)
}

#[derive(Debug, PartialEq, Eq)]
struct ByteRange { start: u64, end: u64, partial: bool }

fn select_range(value: Option<&str>, size: u64) -> Result<ByteRange, ()> {
    if size == 0 { return Err(()); }
    let Some(value) = value else {
        return Ok(ByteRange { start: 0, end: (size - 1).min(MAX_VIDEO_CHUNK - 1), partial: size > MAX_VIDEO_CHUNK });
    };
    let range = value.strip_prefix("bytes=").ok_or(())?;
    if range.contains(',') || range.bytes().any(|byte| byte.is_ascii_whitespace()) { return Err(()); }
    let (start, end) = range.split_once('-').ok_or(())?;
    let parse = |value: &str| -> Result<u64, ()> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { return Err(()); }
        value.parse::<u64>().map_err(|_| ())
    };
    let (start, end) = if start.is_empty() {
        let suffix = parse(end)?;
        if suffix == 0 { return Err(()); }
        // A bounded suffix is useful for MP4 metadata near EOF; do not allocate
        // an arbitrarily large suffix merely because the client requested it.
        let length = suffix.min(size).min(MAX_VIDEO_CHUNK);
        (size - length, size - 1)
    } else {
        let start = parse(start)?;
        if start >= size { return Err(()); }
        let end = if end.is_empty() { size - 1 } else { parse(end)?.min(size - 1) };
        if end < start { return Err(()); }
        (start, end.min(start.saturating_add(MAX_VIDEO_CHUNK - 1)))
    };
    Ok(ByteRange { start, end, partial: true })
}

fn read_video(media: &mut LocalMedia, range_header: Option<&str>, head: bool) -> Result<Response<Vec<u8>>, String> {
    let Content::Video(mime) = media.content else { return Err("此会话不是视频播放会话".into()); };
    let size = media.snapshot.size;
    let range = match select_range(range_header, size) {
        Ok(range) => range,
        Err(()) => {
            let mut reply = response(StatusCode::RANGE_NOT_SATISFIABLE, mime, Vec::new());
            reply.headers_mut().insert(header::CONTENT_RANGE, format!("bytes */{size}").parse().unwrap());
            reply.headers_mut().insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
            reply.headers_mut().insert(header::CONTENT_LENGTH, 0.into());
            return Ok(reply);
        }
    };
    // HEAD without Range reports the full resource without reading any bytes.
    let full_head = head && range_header.is_none();
    let length = if full_head { size } else { range.end - range.start + 1 };
    let mut bytes = Vec::new();
    if !head {
        bytes.resize(length as usize, 0);
        media.file.seek(SeekFrom::Start(range.start)).map_err(|_| "视频读取位置无效")?;
        media.file.read_exact(&mut bytes).map_err(|_| "无法读取视频片段，文件可能已变化")?;
    }
    let partial = range.partial && !full_head;
    let mut reply = response(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK }, mime, bytes);
    reply.headers_mut().insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    reply.headers_mut().insert(header::CONTENT_LENGTH, length.into());
    if partial { reply.headers_mut().insert(header::CONTENT_RANGE, format!("bytes {}-{}/{size}", range.start, range.end).parse().unwrap()); }
    Ok(reply)
}

fn protocol_response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        let mut reply = protocol_error(StatusCode::METHOD_NOT_ALLOWED, "仅支持本地媒体读取", false);
        reply.headers_mut().insert(header::ALLOW, "GET, HEAD".parse().unwrap());
        return reply;
    }
    if request.uri().query().is_some() { return protocol_error(StatusCode::NOT_FOUND, "本地阅读地址无效", head); }
    let parts = request.uri().path().strip_prefix('/').unwrap_or_default().split('/').collect::<Vec<_>>();
    // Structure only: protocol capability tokens and filesystem paths must
    // never be written to diagnostics. This catches incorrectly URL-encoded
    // routing separators without making logs a second source of capabilities.
    let encoded_separator = request.uri().path().as_bytes().windows(3)
        .any(|bytes| bytes.eq_ignore_ascii_case(b"%2f") || bytes.eq_ignore_ascii_case(b"%5c"));
    if !(parts.len() == 2 || parts.len() == 3) || parts[0].len() != 32 || !parts[0].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        crate::diagnostics::record(&format!("local_viewer.protocol.reject reason=route parts={} encoded_separator={encoded_separator}", parts.len()));
        return protocol_error(StatusCode::NOT_FOUND, "本地阅读会话不存在或已关闭", head);
    }
    let session = sessions().lock().ok().and_then(|all| all.get(parts[0]).cloned());
    let Some(session) = session else { return protocol_error(StatusCode::NOT_FOUND, "本地阅读会话不存在或已关闭", head); };
    if !session.active.load(AtomicOrdering::Acquire) { return protocol_error(StatusCode::GONE, "本地阅读会话已关闭", head); }
    let Ok(mut media) = session.media.lock() else { return protocol_error(StatusCode::SERVICE_UNAVAILABLE, "本地阅读会话暂时不可用", head); };
    if validate_unchanged(&media).is_err() { return protocol_error(StatusCode::CONFLICT, "本地文件已变化或不可用，请重新打开", head); }
    let result = if parts.len() == 3 && parts[1] == "page" {
        if parts[2].is_empty() || !parts[2].bytes().all(|byte| byte.is_ascii_digit()) { return protocol_error(StatusCode::NOT_FOUND, "漫画页码无效", head); }
        let Ok(index) = parts[2].parse::<usize>() else { return protocol_error(StatusCode::NOT_FOUND, "漫画页码无效", head); };
        read_comic_page(&mut media, index, head)
    } else if parts.len() == 2 && parts[1] == "video" {
        let range = match request.headers().get(header::RANGE) {
            Some(value) => match value.to_str() {
                Ok(value) => Some(value),
                Err(_) => Some("invalid"),
            },
            None => None,
        };
        read_video(&mut media, range, head)
    } else { return protocol_error(StatusCode::NOT_FOUND, "本地阅读地址无效", head); };
    // Revocation during a disk read must not publish a fresh response afterward.
    if !session.active.load(AtomicOrdering::Acquire) { return protocol_error(StatusCode::GONE, "本地阅读会话已关闭", head); }
    if validate_unchanged(&media).is_err() { return protocol_error(StatusCode::CONFLICT, "本地文件已变化或不可用，请重新打开", head); }
    match result {
        Ok(reply) => reply,
        Err(message) => protocol_error(StatusCode::UNPROCESSABLE_ENTITY, &message, head),
    }
}

pub fn respond_local_viewer_protocol(
    _app: tauri::AppHandle,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    tauri::async_runtime::spawn_blocking(move || responder.respond(protocol_response(request)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    static TEST_SESSION_GUARD: Mutex<()> = Mutex::new(());

    // Valid one-pixel PNG, rather than a signature-only fake image.
    const PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222,
        0, 0, 0, 12, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5,
        254, 2, 254, 13, 239, 70, 184, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("acgn-viewer-{}-{}", std::process::id(), unique_session_id()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn prepare(&self, filename: &str) -> Result<PreparedLocalViewer, String> {
            prepare_impl(self.0.join(filename).to_string_lossy().into_owned(), self.0.to_string_lossy().into_owned())
        }
        fn write(&self, filename: &str, bytes: &[u8]) {
            std::fs::write(self.0.join(filename), bytes).unwrap();
        }
        fn archive(&self, filename: &str, entries: &[(&str, &[u8])]) {
            let file = File::create(self.0.join(filename)).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            for (name, bytes) in entries {
                zip.start_file(*name, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    fn request(id: &str, tail: &str) -> Request<Vec<u8>> {
        Request::builder().uri(format!("http://acgn-local.localhost/{id}/{tail}")).body(Vec::new()).unwrap()
    }

    #[test]
    fn natural_page_order_handles_directories_numbers_and_padding() {
        let mut names = ["vol10/page1.png", "vol2/page10.png", "vol2/page002.png", "vol2/page2.png", "vol2/page1.png", "Vol1/page1.png"];
        names.sort_by(|a, b| natural_compare(a, b));
        assert_eq!(names, ["Vol1/page1.png", "vol2/page1.png", "vol2/page2.png", "vol2/page002.png", "vol2/page10.png", "vol10/page1.png"]);
        assert_eq!(natural_compare("a999999999999999999999999.png", "a1000000000000000000000000.png"), Ordering::Less);
    }

    #[test]
    fn comic_pages_are_raw_images_and_session_close_revokes_access() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.archive("chapter.cbz", &[("vol2/page10.png", PNG), ("vol2/page2.png", PNG), ("notes.txt", b"notes")]);
        let prepared = fixture.prepare("chapter.cbz").unwrap();
        assert_eq!(prepared.kind, "comic");
        assert_eq!(prepared.page_count, Some(2));
        {
            let session = sessions().lock().unwrap().get(&prepared.session_id).cloned().unwrap();
            let media = session.media.lock().unwrap();
            let Content::Comic(pages) = &media.content else { panic!("comic content expected"); };
            assert_eq!(pages.iter().map(|page| page.name.as_str()).collect::<Vec<_>>(), ["vol2/page2.png", "vol2/page10.png"]);
        }
        let page = protocol_response(request(&prepared.session_id, "page/0"));
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(page.body(), PNG);
        assert_eq!(protocol_response(request(&prepared.session_id, "page/2")).status(), StatusCode::UNPROCESSABLE_ENTITY);
        close_local_viewer(prepared.session_id.clone()).unwrap();
        assert_eq!(protocol_response(request(&prepared.session_id, "page/0")).status(), StatusCode::NOT_FOUND);
        close_local_viewer(prepared.session_id).unwrap();
    }

    #[test]
    fn rejects_corrupt_archives_fake_images_and_unsupported_entries() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.write("broken.cbz", b"not a zip");
        assert!(fixture.prepare("broken.cbz").unwrap_err().contains("损坏"));
        fixture.archive("html.cbz", &[("page1.png", b"<html><script>bad()</script></html>")]);
        let fake = fixture.prepare("html.cbz").unwrap();
        let page = protocol_response(request(&fake.session_id, "page/0"));
        assert_eq!(page.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(page.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
        assert!(!String::from_utf8_lossy(page.body()).contains("<script>"));
        close_local_viewer(fake.session_id).unwrap();
        fixture.archive("svg.cbz", &[("page1.svg", b"<svg onload='bad()'/>")]);
        assert!(fixture.prepare("svg.cbz").unwrap_err().contains("没有可阅读"));
        fixture.archive("traversal.cbz", &[("../page1.png", PNG)]);
        assert!(fixture.prepare("traversal.cbz").is_err());
    }

    #[test]
    fn archive_limits_reject_declared_bombs_and_excessive_pages() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.archive("bomb.cbz", &[("page1.png", PNG)]);
        let mut bytes = std::fs::read(fixture.0.join("bomb.cbz")).unwrap();
        let central = bytes.windows(4).position(|bytes| bytes == b"PK\x01\x02").unwrap();
        bytes[central + 24..central + 28].copy_from_slice(&((MAX_PAGE_BYTES + 1) as u32).to_le_bytes());
        fixture.write("bomb.cbz", &bytes);
        assert!(fixture.prepare("bomb.cbz").is_err());
        let names = (0..MAX_PAGES + 1).map(|index| format!("page{index}.png")).collect::<Vec<_>>();
        let entries = names.iter().map(|name| (name.as_str(), PNG)).collect::<Vec<_>>();
        fixture.archive("pages.cbz", &entries);
        assert!(fixture.prepare("pages.cbz").unwrap_err().contains("1000"));
        // The aggregate cap also includes ignored non-image entries.
        fixture.archive("total.cbz", &[("notes.txt", b"notes"), ("page1.png", PNG)]);
        let mut bytes = std::fs::read(fixture.0.join("total.cbz")).unwrap();
        let central = bytes.windows(4).position(|bytes| bytes == b"PK\x01\x02").unwrap();
        bytes[central + 24..central + 28].copy_from_slice(&((MAX_UNCOMPRESSED_BYTES + 1) as u32).to_le_bytes());
        fixture.write("total.cbz", &bytes);
        assert!(fixture.prepare("total.cbz").unwrap_err().contains("500 MB"));
        fixture.archive("directory.cbz", &[("page1.png", PNG)]);
        let mut bytes = std::fs::read(fixture.0.join("directory.cbz")).unwrap();
        let footer = bytes.windows(4).rposition(|bytes| bytes == b"PK\x05\x06").unwrap();
        bytes[footer + 8..footer + 10].copy_from_slice(&((MAX_ZIP_ENTRIES + 1) as u16).to_le_bytes());
        bytes[footer + 10..footer + 12].copy_from_slice(&((MAX_ZIP_ENTRIES + 1) as u16).to_le_bytes());
        fixture.write("directory.cbz", &bytes);
        assert!(fixture.prepare("directory.cbz").unwrap_err().contains("条目过多"));
    }

    #[test]
    fn plain_text_keeps_script_text_literal_and_rejects_wrong_encoding_or_size() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.write("volume.txt", b"\xef\xbb\xbf<script>alert('literal')</script>\n&<>");
        let prepared = fixture.prepare("volume.txt").unwrap();
        assert_eq!(prepared.kind, "text");
        assert_eq!(prepared.text.as_deref(), Some("<script>alert('literal')</script>\n&<>"));
        close_local_viewer(prepared.session_id).unwrap();
        fixture.write("invalid.txt", &[0xff, 0xfe, 0x41, 0x00]);
        assert!(fixture.prepare("invalid.txt").unwrap_err().contains("UTF-8"));
        let file = File::create(fixture.0.join("large.txt")).unwrap();
        file.set_len(MAX_TEXT_BYTES + 1).unwrap();
        drop(file);
        assert!(fixture.prepare("large.txt").unwrap_err().contains("20 MB"));
    }

    #[test]
    fn ranges_are_bounded_and_handle_suffix_open_ended_and_invalid_requests() {
        let size = MAX_VIDEO_CHUNK * 3;
        assert_eq!(select_range(None, size).unwrap(), ByteRange { start: 0, end: MAX_VIDEO_CHUNK - 1, partial: true });
        assert_eq!(select_range(Some("bytes=10-20"), size).unwrap(), ByteRange { start: 10, end: 20, partial: true });
        assert_eq!(select_range(Some("bytes=10-"), size).unwrap().end, 10 + MAX_VIDEO_CHUNK - 1);
        assert_eq!(select_range(Some("bytes=-128"), size).unwrap(), ByteRange { start: size - 128, end: size - 1, partial: true });
        assert_eq!(select_range(Some("bytes=-999999999"), size).unwrap().start, size - MAX_VIDEO_CHUNK);
        for range in ["bytes=0-1,4-5", "bytes=-0", "bytes=12-10", "bytes=999999999-", "bytes=+1-2", "bytes= 1-2", "bits=0-1"] {
            assert!(select_range(Some(range), size).is_err(), "{range}");
        }
    }

    #[test]
    fn video_protocol_streams_chunks_head_and_416_without_reading_whole_file() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        let mut file = File::create(fixture.0.join("episode.mp4")).unwrap();
        file.write_all(b"0123456789").unwrap();
        file.set_len(MAX_VIDEO_CHUNK * 2 + 1).unwrap();
        drop(file);
        let prepared = fixture.prepare("episode.mp4").unwrap();
        let first = protocol_response(request(&prepared.session_id, "video"));
        assert_eq!(first.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(first.body().len() as u64, MAX_VIDEO_CHUNK);
        assert_eq!(&first.body()[..10], b"0123456789");
        let ranged = Request::builder().uri(format!("/{}/video", prepared.session_id)).header(header::RANGE, "bytes=3-5").body(Vec::new()).unwrap();
        let part = protocol_response(ranged);
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.body(), b"345");
        assert_eq!(part.headers()[header::CONTENT_TYPE], "video/mp4");
        let head = Request::builder().method(Method::HEAD).uri(format!("/{}/video", prepared.session_id)).body(Vec::new()).unwrap();
        let reply = protocol_response(head);
        assert_eq!(reply.status(), StatusCode::OK);
        assert!(reply.body().is_empty());
        assert_eq!(reply.headers()[header::CONTENT_LENGTH], prepared.size_bytes.to_string());
        let bad = Request::builder().uri(format!("/{}/video", prepared.session_id)).header(header::RANGE, "bytes=999999999-").body(Vec::new()).unwrap();
        let reply = protocol_response(bad);
        assert_eq!(reply.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(reply.headers()[header::CONTENT_RANGE], format!("bytes */{}", prepared.size_bytes));
        close_local_viewer(prepared.session_id).unwrap();
    }

    #[test]
    fn protocol_rejects_paths_queries_wrong_methods_and_unregistered_tokens() {
        for path in ["/../../private/page/0", "/abc/page/0", "/01234567890123456789012345678901/page/0?path=private", "/01234567890123456789012345678901/page/%30"] {
            assert_ne!(protocol_response(Request::builder().uri(path).body(Vec::new()).unwrap()).status(), StatusCode::OK);
        }
        assert_eq!(protocol_response(Request::builder().method(Method::POST).uri("/invalid/video").body(Vec::new()).unwrap()).status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn modified_paths_are_refused_and_unrelated_root_files_are_never_opened() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.archive("chapter.cbz", &[("page1.png", PNG)]);
        let prepared = fixture.prepare("chapter.cbz").unwrap();
        {
            let session = sessions().lock().unwrap().get(&prepared.session_id).cloned().unwrap();
            let mut media = session.media.lock().unwrap();
            media.snapshot.size += 1;
        }
        assert_eq!(protocol_response(request(&prepared.session_id, "page/0")).status(), StatusCode::CONFLICT);
        close_local_viewer(prepared.session_id).unwrap();
        let elsewhere = Fixture::new();
        elsewhere.write("outside.txt", b"private");
        assert!(prepare_impl(elsewhere.0.join("outside.txt").to_string_lossy().into_owned(), fixture.0.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn session_limit_is_bounded_and_closed_tokens_are_not_reused() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.write("volume.txt", b"chapter");
        let mut ids = (0..MAX_SESSIONS).map(|_| fixture.prepare("volume.txt").unwrap().session_id).collect::<Vec<_>>();
        assert!(fixture.prepare("volume.txt").unwrap_err().contains("会话过多"));
        let first = ids.remove(0);
        close_local_viewer(first.clone()).unwrap();
        let replacement = fixture.prepare("volume.txt").unwrap().session_id;
        assert_ne!(first, replacement);
        ids.push(replacement);
        for id in ids { close_local_viewer(id).unwrap(); }
    }

    #[test]
    fn hard_reload_revokes_existing_sessions_and_rejects_old_pending_prepare() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.archive("chapter.cbz", &[("page1.png", PNG)]);
        let old_epoch = DOCUMENT_EPOCH.load(AtomicOrdering::Acquire);
        let prepared = fixture.prepare("chapter.cbz").unwrap();
        let old_session = sessions().lock().unwrap().get(&prepared.session_id).cloned().unwrap();
        assert_eq!(protocol_response(request(&prepared.session_id, "page/0")).status(), StatusCode::OK);
        reset_local_viewer_sessions();
        assert!(!old_session.active.load(AtomicOrdering::Acquire));
        assert_eq!(protocol_response(request(&prepared.session_id, "page/0")).status(), StatusCode::NOT_FOUND);
        // Simulate a file inspection queued by the old document completing
        // only after the new page has already started and prepared its viewer.
        let fresh = fixture.prepare("chapter.cbz").unwrap();
        let delayed = prepare_at_epoch(fixture.0.join("chapter.cbz").to_string_lossy().into_owned(), fixture.0.to_string_lossy().into_owned(), old_epoch);
        assert!(delayed.unwrap_err().contains("重新加载"));
        assert_eq!(sessions().lock().unwrap().len(), 1);
        assert_eq!(protocol_response(request(&fresh.session_id, "page/0")).status(), StatusCode::OK);
        close_local_viewer(fresh.session_id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn held_windows_handle_blocks_writes_and_replacement_until_closed() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.write("volume.txt", b"original");
        let prepared = fixture.prepare("volume.txt").unwrap();
        let path = fixture.0.join("volume.txt");
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::rename(&path, fixture.0.join("moved.txt")).is_err());
        close_local_viewer(prepared.session_id).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        std::fs::rename(&path, fixture.0.join("moved.txt")).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replaced_path_is_refused_even_if_original_handle_stays_open() {
        let _serial = TEST_SESSION_GUARD.lock().unwrap();
        let fixture = Fixture::new();
        fixture.write("episode.mp4", b"original video");
        let prepared = fixture.prepare("episode.mp4").unwrap();
        std::fs::rename(fixture.0.join("episode.mp4"), fixture.0.join("original.mp4")).unwrap();
        fixture.write("episode.mp4", b"different video");
        assert_eq!(protocol_response(request(&prepared.session_id, "video")).status(), StatusCode::CONFLICT);
        close_local_viewer(prepared.session_id).unwrap();
    }
}
