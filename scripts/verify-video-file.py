"""Inspect and sample-decode a downloaded video without opening a player."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

import imageio_ffmpeg

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("file", type=Path)
parser.add_argument("--output", type=Path, default=Path(".work/v03-evidence/requested-public-video-verified.json"))
args = parser.parse_args()
video = args.file.resolve(strict=True)
executable = imageio_ffmpeg.get_ffmpeg_exe()
probe = subprocess.run([executable, "-hide_banner", "-i", str(video)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
metadata = probe.stderr
duration = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", metadata)
if not duration:
    raise SystemExit("No valid video duration found")
seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
video_stream = next((line.strip() for line in metadata.splitlines() if "Video:" in line), None)
audio_stream = next((line.strip() for line in metadata.splitlines() if "Audio:" in line), None)
if not video_stream or not audio_stream or seconds < 20 * 60:
    raise SystemExit("Expected a full episode with video and audio")
checks = []
for position in (0, seconds / 2, max(0, seconds - 5)):
    check = subprocess.run([executable, "-v", "error", "-ss", str(position), "-i", str(video), "-t", "3", "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], capture_output=True, timeout=60)
    checks.append({"positionSeconds": round(position, 3), "exitCode": check.returncode, "errors": check.stderr.decode("utf-8", errors="replace").strip()})
    if check.returncode or check.stderr.strip():
        raise SystemExit("Video sample decoding failed: " + str(checks[-1]))
result = {"path": str(video), "bytes": video.stat().st_size, "durationSeconds": seconds, "videoStream": video_stream, "audioStream": audio_stream, "sampleDecoding": checks, "sha256": hashlib.file_digest(video.open("rb"), "sha256").hexdigest(), "passed": True}
args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, indent=2))
