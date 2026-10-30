"""Offline/loopback recovery checks; no Bilibili requests, GUI or real media transfer."""
from __future__ import annotations
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
import yt_dlp

path = Path(__file__).resolve().parents[1] / "resources" / "public_video_bridge.py"
spec = importlib.util.spec_from_file_location("public_video_bridge_recovery", path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
PUBLIC_URL = "https://www.bilibili.com/video/BV1UqHi6uEie/"

def fixture_info():
    video = {"format_id": "30016", "ext": "mp4", "vcodec": "avc1.64001E", "acodec": "none", "height": 360, "width": 640, "filesize": 10}
    audio = {"format_id": "30216", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "filesize": 4}
    return {"id": "fixture", "title": "fixture", "formats": [video, audio], "requested_formats": [video, audio], "duration": 1}

class RecoveryContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="acgn-public-recovery-")
        self.target = Path(self.directory.name)
        (self.target / ".acgn-manga-temp").write_text("fixture owned staging", encoding="utf-8")
    def tearDown(self):
        self.directory.cleanup()

    def test_transient_classifier_is_narrow_and_restrictions_override_network_words(self):
        for error in [IncompleteRead(b"part", 100), TimeoutError("timed out"), ConnectionResetError("reset"),
                      yt_dlp.utils.DownloadError("3372 bytes read, 1035103 more expected. Giving up after 5 retries")]:
            self.assertTrue(bridge.transient_transfer_failure(error), str(error))
        for error in [ValueError("DRM"), FileExistsError("target exists"), PermissionError("denied"),
                      RuntimeError("unknown failure"), yt_dlp.utils.DownloadError("Requested format is not available"),
                      yt_dlp.utils.DownloadError("HTTP Error 403: Forbidden; connection reset"),
                      yt_dlp.utils.DownloadError("HTTP Error 412: Precondition Failed"),
                      yt_dlp.utils.DownloadError("HTTP Error 429: Too Many Requests")]:
            self.assertFalse(bridge.transient_transfer_failure(error), str(error))

    def test_partial_file_is_kept_until_refreshed_extractor_resumes(self):
        target = self.target
        instances, leases, progress = [], [], []
        class FakeDownloader:
            def __init__(self, settings): self.settings = settings; instances.append(self)
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def extract_info(self, url, download=False):
                leases.append(len(instances)); return {**fixture_info(), "lease": len(instances)}
            def process_info(self, info):
                partial = target / "video.f30016.mp4.part"
                self.settings["progress_hooks"][0]({"status": "downloading", "filename": str(partial), "downloaded_bytes": 4, "total_bytes": 10})
                if len(instances) == 1:
                    partial.write_bytes(b"part")
                    raise IncompleteRead(b"part", 6)
                assert partial.read_bytes() == b"part"
                assert self.settings["continuedl"] is True and info["lease"] == 2
                partial.write_bytes(partial.read_bytes() + b"resume")
                (target / "video.mp4").write_bytes(b"\x00\x00\x00\x20ftypisom" + b"fixture" * 10)
        with patch.object(yt_dlp, "YoutubeDL", FakeDownloader), patch.object(bridge, "ffmpeg_executable", return_value="unused"), patch.object(bridge, "emit", side_effect=lambda kind, **data: progress.append(data)), patch.object(bridge.time, "sleep"):
            result = bridge.download(PUBLIC_URL, str(target), "operation")
        self.assertEqual(leases, [1, 2]); self.assertEqual(result["height"], 360)
        self.assertTrue(any("正在续传" in item.get("detail", "") for item in progress))
        self.assertEqual((target / "video.f30016.mp4.part").read_bytes(), b"partresume")

    def test_restricted_errors_are_not_reextracted_and_recoveries_are_bounded(self):
        for failure, expected in [(yt_dlp.utils.DownloadError("HTTP Error 403: Forbidden"), 1),
                                  (yt_dlp.utils.DownloadError("HTTP Error 412: Precondition Failed"), 1),
                                  (yt_dlp.utils.DownloadError("HTTP Error 429: Too Many Requests"), 1),
                                  (ValueError("DRM restricted"), 1),
                                  (ConnectionResetError("connection reset"), 4)]:
            calls = []
            class FakeDownloader:
                def __init__(self, settings): calls.append(settings)
                def __enter__(self): return self
                def __exit__(self, *_): return False
                def extract_info(self, *_, **__): return fixture_info()
                def process_info(self, _): raise failure
            with self.subTest(failure=str(failure)), patch.object(yt_dlp, "YoutubeDL", FakeDownloader), patch.object(bridge, "ffmpeg_executable", return_value="unused"), patch.object(bridge, "emit"), patch.object(bridge.time, "sleep"):
                with self.assertRaises(type(failure)):
                    bridge.download(PUBLIC_URL, str(self.target), "operation")
                self.assertEqual(len(calls), expected)

    def test_real_ytdlp_loopback_http_resumes_part_with_range_and_fresh_url(self):
        payload = b"\x00\x00\x00\x20ftypisom" + b"local fixture" * 6000
        requests, extractions, prior_parts = [], [], []
        target = self.target
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                requested = self.headers.get("Range", "")
                offset = int(requested.split("=")[1].split("-")[0]) if requested else 0
                requests.append({"range": requested, "offset": offset, "path": self.path})
                body = payload[offset:]
                self.send_response(206 if requested else 200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(body)))
                if requested: self.send_header("Content-Range", f"bytes {offset}-{len(payload)-1}/{len(payload)}")
                self.end_headers()
                if len(requests) == 1:
                    self.wfile.write(body[:4096]); self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_RDWR); self.connection.close()
                else:
                    self.wfile.write(body)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        original_downloader = yt_dlp.YoutubeDL
        class LocalDownloader(original_downloader):
            def __init__(self, settings): super().__init__({**settings, "retries": 0, "fragment_retries": 0, "proxy": "", "fixup": "never"})
            def extract_info(self, url, download=False, **kwargs):
                extractions.append(url); prior_parts.append([file.stat().st_size for file in target.glob("*.part")])
                item = {"id": "fixture", "title": "fixture", "extractor": "generic", "extractor_key": "Generic",
                        "webpage_url": PUBLIC_URL, "duration": 1, "formats": [{"format_id": "local-muxed", "ext": "mp4",
                        "vcodec": "avc1.64001E", "acodec": "mp4a.40.2", "height": 360, "width": 640,
                        "url": f"http://127.0.0.1:{server.server_port}/fixture.mp4?lease={len(extractions)}", "protocol": "http"}]}
                return self.process_ie_result(item, download=False)
        try:
            with patch.object(yt_dlp, "YoutubeDL", LocalDownloader), patch.object(bridge, "ffmpeg_executable", return_value="unused"), patch.object(bridge, "emit"), patch.object(bridge.time, "sleep"):
                bridge.download(PUBLIC_URL, str(target), "operation")
        finally:
            server.shutdown(); server.server_close(); worker.join()
        self.assertEqual((target / "video.mp4").read_bytes(), payload)
        self.assertEqual(len(extractions), 2)
        self.assertTrue(prior_parts[1] and prior_parts[1][0] > 0)
        self.assertTrue(any(request["offset"] > 0 and "lease=2" in request["path"] for request in requests))

if __name__ == "__main__":
    unittest.main(verbosity=2)
