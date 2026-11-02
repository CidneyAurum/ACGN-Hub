"""List the four final Windows / Android downloads without packaging local data.

Run after Windows packaging, portable ZIP creation and Android verification:
  python scripts/create-crossplatform-manifest.py release/v0.5.0
  # Optionally add: --apk-receipt .work/android-v050/apk-verification.json

Writes RELEASE-ASSETS.json and CHECKSUMS-SHA256.txt beside the four artifacts.
The Windows-only VERSION.json and SHA256SUMS.txt are left unchanged.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile


REPOSITORY = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)")
PRIVATE_PARTS = {"data", "incoming", "library", "backups", "webview2", ".work", ".local", "android-signing", ".http-tasks"}
PRIVATE_SUFFIXES = {".p12", ".pfx", ".jks", ".keystore", ".pem", ".key", ".db", ".sqlite", ".sqlite3", ".part", ".tmp"}
DISTRIBUTION_SUFFIXES = {".exe", ".apk", ".aab", ".zip", ".msi", ".msix", ".7z", ".rar"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def plain_path(path: Path) -> None:
    info = path.lstat()
    require(not (path.is_symlink() or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT),
            f"Links and reparse points are not release inputs: {path.name}")


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest().upper()


def public_member(name: str) -> None:
    relative = PurePosixPath(name)
    require(not (relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name), "Unsafe archive member")
    require(not any(part.casefold() in PRIVATE_PARTS for part in relative.parts), "User data in release archive")
    require(relative.suffix.casefold() not in PRIVATE_SUFFIXES, "Private or incomplete file in release archive")
    require(not re.search(r"(?:password|keystore|signing-key)", relative.name, re.I), "Signing material in release archive")


def atomic_write(path: Path, body: str) -> None:
    if path.exists():
        plain_path(path)
        require(path.is_file(), "Manifest destination must be a regular file")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
            target.write(body)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def create_manifest(directory: Path, apk_receipt: Path | None = None) -> dict:
    require(".." not in directory.parts, "Parent traversal is not a release directory")
    requested = Path(os.path.abspath(directory))
    match = VERSION.fullmatch(requested.name)
    require(match is not None, "Expected release/v<version>")
    version = match[1]
    expected = REPOSITORY / "release" / f"v{version}"
    require(requested == expected, "Release directory must be this repository's release/v<version>")
    for path in (REPOSITORY, REPOSITORY / "release", expected):
        plain_path(path)
    require(expected.is_dir() and expected.resolve(strict=True) == expected, "Release directory leaves the repository")

    names = {
        f"ACGN-Hub-{version}.exe": "Windows x64",
        f"ACGN-Hub-{version}-x64-setup.exe": "Windows x64",
        f"ACGN-Hub-{version}-windows-x64-portable.zip": "Windows x64",
        f"ACGN-Hub-{version}-android-64bit.apk": "Android arm64-v8a / x86_64",
    }
    for path in expected.iterdir():
        plain_path(path)
        require(path.name.casefold() not in PRIVATE_PARTS, "User-data directory present in release folder")
        require(path.suffix.casefold() not in PRIVATE_SUFFIXES and not re.search(r"password|keystore", path.name, re.I),
                "Private or incomplete file present in release folder")
        if path.suffix.casefold() in DISTRIBUTION_SUFFIXES:
            require(path.name in names, f"Unexpected distribution artifact: {path.name}")
    artifacts = []
    for name, platform in names.items():
        path = expected / name
        require(path.is_file() and path.stat().st_size > 0, f"Missing or empty release artifact: {name}")
        artifacts.append({"file": name, "sizeBytes": path.stat().st_size, "sha256": sha256(path), "platform": platform})

    windows = json.loads((expected / "VERSION.json").read_text(encoding="utf-8-sig"))
    require(windows.get("version") == version and windows.get("product") == "ACGN Hub", "Windows manifest identity differs")
    require(windows.get("bundledUserData") is False and windows.get("bundledUserMedia") is False, "Windows manifest must exclude user data")
    for artifact in artifacts[:2]:
        records = [item for item in windows["artifacts"] if item.get("file") == artifact["file"]]
        require(len(records) == 1 and records[0].get("sizeBytes") == artifact["sizeBytes"]
                and str(records[0].get("sha256", "")).upper() == artifact["sha256"], "Windows artifact differs from verified packaging")
    with zipfile.ZipFile(expected / artifacts[2]["file"]) as archive:
        members = archive.namelist()
        allowed = [artifacts[0]["file"], "VERSION.json", "SHA256SUMS.txt"] + [item["file"] for item in windows["supportFiles"]]
        require(len(members) == len(set(members)) and set(members) == set(allowed), "Portable archive differs from Windows member list")
        for member in members:
            public_member(member)
        require(archive.testzip() is None, "Portable ZIP CRC failed")
        require(hashlib.sha256(archive.read(artifacts[0]["file"])).hexdigest().upper() == artifacts[0]["sha256"], "Portable EXE differs")
    with zipfile.ZipFile(expected / artifacts[3]["file"]) as archive:
        require(archive.testzip() is None, "APK ZIP CRC failed")
        for member in archive.namelist():
            public_member(member)
            require(PurePosixPath(member).suffix.casefold() not in {".exe", ".bat", ".cmd", ".ps1"}, "Desktop executable in APK")
        abis = {name.split("/")[1] for name in archive.namelist() if name.startswith("lib/") and name.endswith(".so")}
        require(abis == {"arm64-v8a", "x86_64"}, "APK must contain exactly the two supported ABIs")

    result = {"product": "ACGN Hub", "version": version,
              "generatedAt": datetime.now(timezone.utc).isoformat(), "artifacts": artifacts}
    if apk_receipt:
        receipt = json.loads(apk_receipt.read_text(encoding="utf-8-sig"))
        require(receipt.get("sha256", "").upper() == artifacts[3]["sha256"] and receipt.get("sizeBytes") == artifacts[3]["sizeBytes"], "APK receipt describes different bytes")
        require(receipt.get("versionName") == version and receipt.get("package") == "local.acgnhub.mobile"
                and set(receipt.get("libraries", {})) == {"arm64-v8a", "x86_64"}, "APK receipt identity differs")
        require(type(receipt.get("versionCode")) is int and receipt["versionCode"] > 0
                and receipt.get("minSdk") == 26 and receipt.get("targetSdk") == 36, "APK update or SDK identity differs")
        require(all(receipt.get(key) is True for key in ("signatureV2Verified", "signatureV3Verified", "zipCrcVerified", "zipAlignment16KiBVerified"))
                and all(receipt.get(key) is False for key in ("privateSigningMaterialBundled", "userDataBundled", "windowsBinariesBundled")), "APK static checks did not pass")
        result["androidVerification"] = {key: receipt[key] for key in ("package", "versionName", "versionCode", "minSdk", "targetSdk", "signatureV2Verified", "signatureV3Verified", "zipAlignment16KiBVerified")}
    atomic_write(expected / "RELEASE-ASSETS.json", json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    atomic_write(expected / "CHECKSUMS-SHA256.txt", "".join(f"{item['sha256']}  {item['file']}\n" for item in artifacts))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("release_directory", type=Path)
    parser.add_argument("--apk-receipt", type=Path, help="Optional static verification receipt for these exact APK bytes")
    arguments = parser.parse_args()
    try:
        print(json.dumps(create_manifest(arguments.release_directory, arguments.apk_receipt), ensure_ascii=False, indent=2))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Release manifest refused: {error}\n")
