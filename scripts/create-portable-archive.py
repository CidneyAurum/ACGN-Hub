"""Package only verified release files; never include an existing Data directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import zipfile


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def create_archive(release: Path) -> dict:
    release = release.resolve(strict=True)
    manifest_path = release / "VERSION.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", manifest["version"]):
        raise ValueError("Invalid release version")
    executable = manifest["portableExecutable"]
    records = [item for item in manifest["artifacts"] if item["file"] == executable]
    if len(records) != 1:
        raise ValueError("The manifest must identify exactly one portable executable")
    records += manifest["supportFiles"]
    names = [item["file"] for item in records] + ["VERSION.json", "SHA256SUMS.txt"]
    if len(names) != len(set(names)):
        raise ValueError("Duplicate archive members in release manifest")
    payloads: dict[str, bytes] = {}
    for name in names:
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
            raise ValueError(f"Invalid archive member: {name}")
        if relative.parts[0].casefold() in {"data", "library", "incoming", "backups", "webview2", ".work"}:
            raise ValueError(f"User data must never enter a portable release: {name}")
        path = release.joinpath(*relative.parts)
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(release):
            raise ValueError(f"Archive input leaves the release directory: {name}")
        payloads[name] = path.read_bytes()
    for item in records:
        data = payloads[item["file"]]
        if len(data) != item["sizeBytes"] or digest(data) != item["sha256"].upper():
            raise ValueError(f"Release file differs from verified manifest: {item['file']}")
    marker = manifest["portableProfile"]["marker"]
    if payloads.get(marker) != b"ACGN Hub portable profile v1\n":
        raise ValueError("Portable profile marker is missing or invalid")
    if manifest.get("bundledUserData") is not False or manifest.get("bundledUserMedia") is not False:
        raise ValueError("Release manifest must exclude user data and media")
    archive = release / f"ACGN-Hub-{manifest['version']}-windows-x64-portable.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for name, data in payloads.items():
            output.writestr(name, data)
    with zipfile.ZipFile(archive) as check:
        if check.testzip() is not None or check.namelist() != names:
            raise ValueError("Portable ZIP content or CRC validation failed")
        for name, expected in payloads.items():
            if digest(check.read(name)) != digest(expected):
                raise ValueError(f"Portable ZIP member differs: {name}")
    return {"file": archive.name, "sizeBytes": archive.stat().st_size,
            "sha256": digest(archive.read_bytes()), "members": names,
            "crcPassed": True, "memberHashesPassed": True,
            "bundledUserData": False, "bundledUserMedia": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_directory", type=Path)
    args = parser.parse_args()
    print(json.dumps(create_archive(args.release_directory), ensure_ascii=True, indent=2))
