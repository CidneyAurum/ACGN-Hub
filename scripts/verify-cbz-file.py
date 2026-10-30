"""Check a completed CBZ's CRCs and decode every page without extracting it."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("file", type=Path)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
path = args.file.resolve(strict=True)
images = []
with zipfile.ZipFile(path) as archive:
    bad_member = archive.testzip()
    if bad_member:
        raise ValueError(f"ZIP CRC failed: {bad_member}")
    for name in archive.namelist():
        with archive.open(name) as stream:
            with Image.open(stream) as image:
                image.load()
                images.append({"file": name, "width": image.width, "height": image.height})
if not images:
    raise ValueError("CBZ contains no pages")
result = {"file": str(path), "sizeBytes": path.stat().st_size,
          "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
          "pages": len(images), "zipCrcPassed": True, "decodedPages": images}
args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({key: value for key, value in result.items() if key != "decodedPages"}, ensure_ascii=False))
