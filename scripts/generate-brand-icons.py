"""Regenerate ACGN Hub icons from the original SVG using local tools only.

Requires the installed @tauri-apps/cli (SVG renderer), Node, and Pillow.
Run from any directory: python scripts/generate-brand-icons.py
Generated inspection evidence lives in .work/brand-icons-tv-v039.
"""

from __future__ import annotations

import hashlib
from io import BytesIO
import json
from pathlib import Path
import shutil
import struct
import subprocess

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src-tauri" / "icons" / "icon.svg"
NATIVE = SOURCE.parent
PUBLIC = ROOT / "public"
WORK = ROOT / ".work" / "brand-icons-tv-v039"
SIZES = (16, 24, 32, 48, 64, 128, 256)


def write_ico(path: Path) -> None:
    # DIB frames keep the installer and Windows shell compatible at small sizes;
    # the large PNG frame preserves crisp Explorer thumbnails at high DPI.
    payloads = []
    for size in SIZES:
        with Image.open(WORK / f"{size}x{size}.png") as frame:
            buffer = BytesIO()
            frame.convert("RGBA").save(
                buffer, format="ICO", sizes=[(size, size)],
                bitmap_format="png" if size == 256 else "bmp",
            )
            data = buffer.getvalue()
            length, offset = struct.unpack_from("<II", data, 14)
            payloads.append(data[offset : offset + length])
    header = struct.pack("<HHH", 0, 1, len(SIZES))
    offset = len(header) + len(SIZES) * 16
    directory = bytearray()
    for size, payload in zip(SIZES, payloads):
        directory.extend(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 0, 32, len(payload), offset))
        offset += len(payload)
    path.write_bytes(header + directory + b"".join(payloads))


def inspect_ico(path: Path) -> list[dict[str, int | str]]:
    data = path.read_bytes()
    reserved, image_type, count = struct.unpack_from("<HHH", data)
    assert (reserved, image_type, count) == (0, 1, len(SIZES))
    entries = []
    for index in range(count):
        width, height, colors, reserved_byte, planes, bits, length, offset = (
            struct.unpack_from("<BBBBHHII", data, 6 + index * 16)
        )
        width, height = width or 256, height or 256
        assert width == height and width in SIZES
        assert reserved_byte == 0 and planes == 0 and bits == 32
        payload = data[offset : offset + length]
        assert len(payload) == length
        if width == 256:
            assert payload.startswith(b"\x89PNG\r\n\x1a\n")
            encoding = "PNG"
        else:
            assert struct.unpack_from("<I", payload)[0] == 40
            dib_width, dib_height = struct.unpack_from("<ii", payload, 4)
            assert dib_width == width and dib_height == height * 2
            encoding = "DIB"
        entries.append({"width": width, "height": height, "bits": bits, "encoding": encoding})
    assert sorted(entry["width"] for entry in entries) == list(SIZES)
    with Image.open(path) as ico:
        assert ico.ico.sizes() == {(size, size) for size in SIZES}
        for size in SIZES:
            frame = ico.ico.getimage((size, size)).convert("RGBA")
            assert frame.getpixel((0, 0))[3] == 0
            assert frame.getpixel((size // 2, size // 2))[3] == 255
            assert frame.getchannel("A").getextrema() == (0, 255)
    return entries


def make_contact_sheet() -> None:
    sheet = Image.new("RGB", (1080, 660), "#F7F5FB")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=18)
    small_font = ImageFont.load_default(size=15)
    draw.text((32, 25), "ACGN Hub / Warm television", fill="#4C3B61", font=font)
    for left, background, label, label_color in (
        (32, "#FFFFFF", "Light background / 256 px", "#695779"),
        (394, "#242032", "Dark background / 256 px", "#DACDE8"),
        (756, "#8460C7", "Desktop color / 256 px", "#FFFFFF"),
    ):
        draw.rounded_rectangle((left, 74, left + 292, 402), radius=20, fill=background)
        with Image.open(WORK / "256x256.png") as source:
            sheet.paste(source, (left + 18, 91), source)
        draw.text((left + 18, 368), label, fill=label_color, font=small_font)
    draw.text((32, 436), "Native sizes (no enlargement)", fill="#4C3B61", font=font)
    x = 38
    for size in SIZES:
        if size == 256:
            continue
        with Image.open(WORK / f"{size}x{size}.png") as source:
            sheet.paste(source, (x, 480 + (128 - size) // 2), source)
        draw.text((x, 624), f"{size}px", fill="#695779", font=small_font)
        x += max(size + 38, 105)
    sheet.save(WORK / "contact-sheet.png")


def main() -> None:
    cli = ROOT / "node_modules" / "@tauri-apps" / "cli" / "tauri.js"
    node = shutil.which("node")
    if not cli.is_file() or not node:
        raise SystemExit("The installed Node and @tauri-apps/cli are required; run npm install first.")
    WORK.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "brand").mkdir(parents=True, exist_ok=True)
    command = [node, str(cli), "icon", str(SOURCE), "--output", str(WORK)]
    for size in (*SIZES, 1024):
        command.extend(("--png", str(size)))
    subprocess.run(command, cwd=ROOT, check=True)

    # Use individually rendered sizes, instead of upscaling an embedded frame.
    write_ico(NATIVE / "icon.ico")
    for size in (16, 24, 32, 48, 64, 128, 256):
        shutil.copyfile(WORK / f"{size}x{size}.png", NATIVE / f"{size}x{size}.png")
    shutil.copyfile(WORK / "256x256.png", NATIVE / "128x128@2x.png")
    shutil.copyfile(WORK / "1024x1024.png", NATIVE / "icon.png")
    shutil.copyfile(SOURCE, PUBLIC / "brand" / "acgn-mark.svg")
    shutil.copyfile(SOURCE, PUBLIC / "favicon.svg")
    shutil.copyfile(NATIVE / "icon.ico", PUBLIC / "favicon.ico")
    for size in (16, 32):
        shutil.copyfile(WORK / f"{size}x{size}.png", PUBLIC / f"favicon-{size}.png")

    entries = inspect_ico(NATIVE / "icon.ico")
    make_contact_sheet()
    report = {
        "source": str(SOURCE.relative_to(ROOT)),
        "design": "warm mauve television, cream screen and small smile; geometric vector mark",
        "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "icoSha256": hashlib.sha256((NATIVE / "icon.ico").read_bytes()).hexdigest(),
        "entries": entries,
        "transparentCorners": True,
        "opaqueCenter": True,
        "publicSvgMatchesNativeSource": (PUBLIC / "brand" / "acgn-mark.svg").read_bytes() == SOURCE.read_bytes(),
        "contactSheet": str((WORK / "contact-sheet.png").relative_to(ROOT)),
    }
    (WORK / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
