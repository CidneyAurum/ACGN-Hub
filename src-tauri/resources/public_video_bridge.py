"""Public Bilibili submissions only. No browser profiles, cookies, login or DRM.

The Rust host supplies fixed arguments and a newly created owned staging folder.
stdout is a JSON-lines protocol; signed CDN URLs are never returned to the UI.
"""

from __future__ import annotations

import json
from http.client import IncompleteRead
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
from urllib.parse import parse_qs, urlencode, urlsplit

MAX_VIDEO_HEIGHT = 1080
VIDEO_SELECTOR = f"bestvideo[ext=mp4][vcodec~='^(avc1|h264)'][height>0][height<={MAX_VIDEO_HEIGHT}]"
AUDIO_SELECTOR = "bestaudio[ext=m4a][acodec~='^(mp4a|aac)']"
PREFERRED_AUDIO_SELECTOR = AUDIO_SELECTOR + "[format_id~='^30216(?:-|$)']"
MUXED_SELECTOR = f"best[ext=mp4][vcodec~='^(avc1|h264)'][acodec~='^(mp4a|aac)'][height>0][height<={MAX_VIDEO_HEIGHT}]"
FORMAT_SELECTOR = f"{VIDEO_SELECTOR}+{PREFERRED_AUDIO_SELECTOR}/{VIDEO_SELECTOR}+{AUDIO_SELECTOR}/{MUXED_SELECTOR}"
MAX_TRANSFER_RECOVERIES = 3


def emit(kind: str, **values: object) -> None:
    print(json.dumps({"kind": kind, **values}, ensure_ascii=True, allow_nan=False), flush=True)


def public_url(value: str) -> str:
    if len(value) > 2048:
        raise ValueError("投稿链接过长")
    parsed = urlsplit(value.strip())
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("bilibili.com", "www.bilibili.com"):
        raise ValueError("仅支持 bilibili.com/video/BV… 普通公开投稿")
    if parsed.username or parsed.password or parsed.port not in (None, 80, 443):
        raise ValueError("投稿链接不能包含登录信息或自定义端口")
    match = re.fullmatch(r"/video/(BV[A-Za-z0-9]{10})/?", parsed.path)
    if not match:
        raise ValueError("只支持 BV 普通投稿，不支持番剧付费页、短链接或其它站点")
    parts = parse_qs(parsed.query).get("p", [])
    if len(parts) > 1 or (parts and (not parts[0].isdigit() or not 1 <= int(parts[0]) <= 1000)):
        raise ValueError("分P参数无效")
    suffix = "?" + urlencode({"p": int(parts[0])}) if parts else ""
    return "https://www.bilibili.com/video/" + match[1] + "/" + suffix


def number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def ffmpeg_executable() -> str:
    system = shutil.which("ffmpeg")
    if system:
        return str(Path(system).resolve(strict=True))
    # Use the installed package's bundled tool, never download an executable.
    os.environ.pop("IMAGEIO_FFMPEG_EXE", None)
    import imageio_ffmpeg

    executable = Path(imageio_ffmpeg.get_ffmpeg_exe()).resolve(strict=True)
    if not executable.is_file() or not executable.name.lower().startswith("ffmpeg"):
        raise RuntimeError("已安装的 FFmpeg 路径无效")
    return str(executable)


class QuietLogger:
    def debug(self, _message: str) -> None:
        pass

    def info(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, _message: str) -> None:
        pass  # The raised DownloadError is sanitized once by main().


def options() -> dict:
    return {
        "quiet": True, "no_warnings": True, "logger": QuietLogger(),
        "noplaylist": True, "ignoreerrors": False, "cachedir": False,
        "socket_timeout": 25, "retries": 5, "fragment_retries": 5, "extractor_retries": 2,
        "http_chunk_size": 1024 * 1024,
        "concurrent_fragment_downloads": 2, "geo_bypass": False,
        "cookiefile": None, "cookiesfrombrowser": None, "usenetrc": False,
        "username": None, "password": None, "enable_file_urls": False,
        "allow_unplayable_formats": False, "skip_unavailable_fragments": False,
        "windowsfilenames": True, "restrictfilenames": True,
        "writeinfojson": False, "writethumbnail": False, "writesubtitles": False,
        "writeautomaticsub": False, "keepvideo": False,
        "format": FORMAT_SELECTOR,
    }


def single_video(info: dict) -> dict:
    if not isinstance(info, dict) or info.get("_type") in ("playlist", "multi_video"):
        raise ValueError("只支持单个公开投稿，请填写具体 BV 链接与分P")
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise ValueError("当前不支持直播或尚未公开的视频")
    formats = info.get("formats") or []
    if not formats or all(item.get("has_drm") for item in formats):
        raise ValueError("未找到匿名可播放格式；不处理需登录、付费或 DRM 的视频")
    return info


def selected_public_format(info: dict) -> dict:
    """Validate the exact formats selected by yt-dlp, shared by inspect/download."""
    selected = info.get("requested_formats") or [info]
    if not isinstance(selected, (list, tuple)) or not 1 <= len(selected) <= 2:
        raise ValueError("未选择可下载的 AVC/AAC MP4 格式")
    if any(not isinstance(item, dict) or item.get("has_drm") for item in selected):
        raise ValueError("不处理 DRM 或无效格式")
    videos = [item for item in selected if item.get("vcodec") not in (None, "none")]
    audios = [item for item in selected if item.get("acodec") not in (None, "none")]
    if len(videos) != 1 or len(audios) != 1:
        raise ValueError("需要可同时取得的 AVC 视频和 AAC 音轨")
    video, audio = videos[0], audios[0]
    height = number(video.get("height"))
    if (video.get("ext") != "mp4"
            or not str(video.get("vcodec", "")).lower().startswith(("avc1", "h264"))
            or height is None or not 0 < height <= MAX_VIDEO_HEIGHT):
        raise ValueError("需要高度明确且不超过1080p的 AVC MP4 视频")
    if (audio.get("ext") not in ("m4a", "mp4")
            or not str(audio.get("acodec", "")).lower().startswith(("mp4a", "aac"))):
        raise ValueError("游客下载需要 AAC 音轨，不会将其它编码冒充 AAC")
    if len(selected) == 1 and video is not audio:
        raise ValueError("合流 MP4 缺少音视频")
    return {"height": height, "width": number(video.get("width")),
            "videoFormatId": str(video.get("format_id", "")),
            "audioFormatId": str(audio.get("format_id", "")),
            "videoCodec": str(video.get("vcodec", "")), "audioCodec": str(audio.get("acodec", "")),
            "audioPreference": "30216" if re.match(r"^30216(?:-|$)", str(audio.get("format_id", ""))) else "other_available_aac"}


def inspect(url: str) -> dict:
    import yt_dlp

    # A metadata response can explain unavailability without selecting a different codec.
    canonical = public_url(url)
    availability_error = None
    with yt_dlp.YoutubeDL({**options(), "ignore_no_formats_error": True}) as downloader:
        info = single_video(downloader.extract_info(public_url(url), download=False))
        try:
            selected = selected_public_format(info)
            # Listed qualities are not proof that an anonymous request can read
            # them. Check the selected streams using ordinary bounded ranges.
            from yt_dlp.networking import Request
            for stream in info.get("requested_formats") or [info]:
                headers = {**info.get("http_headers", {}), **stream.get("http_headers", {}),
                           "Referer": canonical, "Range": "bytes=0-1023"}
                with downloader.urlopen(Request(stream["url"], headers=headers)) as response:
                    prefix = response.read(1024)
                    if response.status not in (200, 206) or len(prefix) < 12 or prefix[4:8] != b"ftyp":
                        raise ValueError("公开音视频读取检查未通过")
        except Exception as error:
            selected = None
            status = getattr(error, "status", getattr(error, "code", None))
            availability_error = f"所选画质未通过匿名读取检查{f'（HTTP {status}）' if status else ''}，请稍后重试或更换来源"
    formats = [{
        "id": str(item.get("format_id", "")), "ext": str(item.get("ext", "")),
        "height": number(item.get("height")), "width": number(item.get("width")),
        "hasVideo": item.get("vcodec") not in (None, "none"),
        "hasAudio": item.get("acodec") not in (None, "none"),
    } for item in info.get("formats", []) if not item.get("has_drm")]
    return {"id": str(info["id"]), "title": str(info.get("title") or info["id"]),
            "duration": number(info.get("duration")), "coverUrl": info.get("thumbnail"),
            "uploader": info.get("uploader") or info.get("channel"),
            "formats": formats, "playable": selected is not None, "selectedFormat": selected,
            "unavailableReason": availability_error, "downloadHeightLimit": MAX_VIDEO_HEIGHT,
            "qualityLabel": f"匿名可用 {int(selected['height'])}p" if selected else "画质尚未验证"}


def transient_transfer_failure(error: Exception) -> bool:
    """Retry transport failures, never access restrictions or incompatible media."""
    failures: list[BaseException] = []
    pending: list[BaseException] = [error]
    while pending and len(failures) < 12:
        current = pending.pop()
        if any(current is previous for previous in failures):
            continue
        failures.append(current)
        for candidate in (current.__cause__, current.__context__):
            if isinstance(candidate, BaseException):
                pending.append(candidate)
        details = getattr(current, "exc_info", None)
        if isinstance(details, tuple) and len(details) > 1 and isinstance(details[1], BaseException):
            pending.append(details[1])
    text = " ".join(str(item) for item in failures).lower()
    if any(isinstance(item, (ValueError, FileExistsError, PermissionError)) for item in failures):
        return False
    status_codes = []
    for item in failures:
        for attribute in ("status", "code", "status_code"):
            value = getattr(item, attribute, None)
            if isinstance(value, int) and 400 <= value <= 599:
                status_codes.append(value)
    status_codes += [int(value) for value in re.findall(r"\bhttp(?:\s+error)?\s*[:=]?\s*([45]\d\d)\b", text)]
    if any(400 <= code < 500 and code != 408 for code in status_codes):
        return False
    permanent = ("drm", "requested format", "format is not available", "permission denied",
                 "already exists", "file exists", "no space left", "certificate verify",
                 "ssl certificate", "login required", "sign in", "登录", "付费", "格式", "目标冲突")
    if any(message in text for message in permanent):
        return False
    if any(isinstance(item, (IncompleteRead, TimeoutError, ConnectionError)) for item in failures):
        return True
    if any(code in (408, 500, 502, 503, 504) for code in status_codes):
        return True
    return (any(message in text for message in ("incompleteread", "timed out", "timeout",
            "connection reset", "connection aborted", "connection broken", "remote end closed",
            "temporarily unavailable", "temporary failure", "network is unreachable"))
            or re.search(r"\b\d+\s+bytes?\s+read.*\b\d+\s+more\s+expected\b", text) is not None)


def download(url: str, directory: str, operation_id: str) -> dict:
    import yt_dlp

    target = Path(directory).resolve(strict=True)
    if not target.is_dir() or not (target / ".acgn-manga-temp").is_file():
        raise ValueError("下载暂存目录缺少应用所有权标记")
    ffmpeg = ffmpeg_executable()
    completed_parts: dict[str, tuple[int, int]] = {}
    last_event = 0.0
    approximate_total = 0
    last_percent = 0.0

    def progress(data: dict) -> None:
        nonlocal last_event, last_percent
        if data.get("status") not in ("downloading", "finished"):
            return
        now = time.monotonic()
        downloaded = int(data.get("downloaded_bytes") or 0)
        total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or downloaded)
        completed_parts[str(data.get("filename", "video"))] = (downloaded, total)
        if now - last_event < 1.0 and data.get("status") != "finished":
            return
        last_event = now
        current = sum(value[0] for value in completed_parts.values())
        expected = max(approximate_total, sum(value[1] for value in completed_parts.values()), current)
        percent = min(95.0, current / expected * 95.0) if expected else 0.0
        last_percent = max(last_percent, percent)
        emit("progress", id=operation_id, stage="downloading", percent=last_percent,
             downloadedBytes=current, totalBytes=expected)

    def postprocess(data: dict) -> None:
        if data.get("status") in ("started", "processing"):
            emit("progress", id=operation_id, stage="merging", percent=95,
                 downloadedBytes=sum(value[0] for value in completed_parts.values()), totalBytes=approximate_total)

    settings = {**options(), "ffmpeg_location": ffmpeg,
        "merge_output_format": "mp4", "outtmpl": str(target / "video.%(ext)s"),
        "paths": {"home": str(target), "temp": str(target)},
        "overwrites": False, "continuedl": True, "progress_hooks": [progress],
        "postprocessor_hooks": [postprocess]}
    emit("progress", id=operation_id, stage="preparing", percent=0, downloadedBytes=0, totalBytes=0)
    canonical_url = public_url(url)
    for recovery in range(MAX_TRANSFER_RECOVERIES + 1):
        try:
            # New extractor/client state refreshes expiring CDN URLs. File templates,
            # format selection and the owned staging directory remain unchanged.
            with yt_dlp.YoutubeDL(settings) as downloader:
                info = single_video(downloader.extract_info(canonical_url, download=False))
                selection = selected_public_format(info)
                selected = info.get("requested_formats") or [info]
                approximate_total = sum(int(item.get("filesize") or item.get("filesize_approx") or 0) for item in selected)
                downloader.process_info(info)
            break
        except Exception as error:
            if recovery >= MAX_TRANSFER_RECOVERIES or not transient_transfer_failure(error):
                raise
            emit("progress", id=operation_id, stage="downloading", percent=last_percent,
                 downloadedBytes=sum(value[0] for value in completed_parts.values()), totalBytes=approximate_total,
                 detail=f"连接中断，正在续传…（{recovery + 1}/{MAX_TRANSFER_RECOVERIES}）")
            time.sleep(min(2 ** recovery, 4))
    output = target / "video.mp4"
    if output.is_symlink() or not output.is_file() or output.stat().st_size < 32:
        raise RuntimeError("下载没有生成完整 MP4，未发布输出文件")
    with output.open("rb") as stream:
        if stream.read(12)[4:8] != b"ftyp":
            raise RuntimeError("输出不是可识别的 MP4 文件")
    return {"fileName": "video.mp4", "sizeBytes": output.stat().st_size,
            "width": selection["width"], "height": selection["height"],
            "duration": number(info.get("duration"))}


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else "health"
    if action == "health":
        import yt_dlp
        emit("result", result={"python": sys.executable, "ytDlpVersion": yt_dlp.version.__version__})
    elif action == "inspect" and len(sys.argv) == 3:
        emit("result", result=inspect(sys.argv[2]))
    elif action == "download" and len(sys.argv) == 5:
        emit("result", result=download(sys.argv[2], sys.argv[3], sys.argv[4]))
    else:
        raise ValueError("公开视频桥接操作参数无效")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = re.sub(r"https?://[^\s]+", "[视频请求地址]", str(error))
        message = re.sub(r"\x1b\[[0-9;]*m", "", message).replace("\r", " ").replace("\n", " ")[:600]
        if isinstance(error, ModuleNotFoundError):
            message = "缺少可选依赖，请为当前 Python 安装 yt-dlp 和 imageio-ffmpeg（python -m pip install yt-dlp imageio-ffmpeg）"
        emit("error", message=message)
        sys.exit(1)
