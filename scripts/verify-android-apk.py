"""Verify release identity, ABI contents, ELF alignment and APK signature.

Uses the Android SDK build-tools and Python's standard library. The receipt
contains public package metadata and hashes; no signing material is read.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
from datetime import datetime, timezone
import zipfile


def run(*args: str) -> str:
    result = subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return result.stdout.decode("utf-8", errors="replace").replace("\r\n", "\n")


def elf_receipt(body: bytes, machine: int) -> dict:
    assert body[:6] == b"\x7fELF\x02\x01", "Expected a 64-bit little-endian ELF library"
    assert struct.unpack_from("<H", body, 18)[0] == machine, "ELF architecture mismatch"
    offset = struct.unpack_from("<Q", body, 32)[0]
    size, count = struct.unpack_from("<HH", body, 54)
    segments = [struct.unpack_from("<IIQQQQQQ", body, offset + index * size) for index in range(count)]
    alignments = [segment[7] for segment in segments if segment[0] == 1]
    assert alignments and all(value >= 16384 for value in alignments), "ELF lacks 16 KiB PT_LOAD alignment"
    return {"machine": machine, "loadAlignments": alignments, "sha256": hashlib.sha256(body).hexdigest().upper(), "sizeBytes": len(body)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--sdk", type=Path, default=os.environ.get("ANDROID_HOME"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    assert args.sdk and args.apk.is_file(), "SDK and APK are required"
    tools = sorted((path for path in (args.sdk / "build-tools").iterdir() if re.fullmatch(r"\d+\.\d+\.\d+", path.name)), key=lambda path: tuple(map(int, path.name.split("."))), reverse=True)
    build_tools = next(path for path in tools if (path / "apksigner.bat").is_file() and (path / "aapt2.exe").is_file())
    badging = run(str(build_tools / "aapt2.exe"), "dump", "badging", str(args.apk.resolve()))
    package = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging)
    assert package and package[1] == "local.acgnhub.mobile" and package[3] == args.version, "Unexpected Android application identity"
    assert int(package[2]) == args.version_code, "Unexpected Android update version code"
    assert re.search(r"^(?:minSdkVersion|sdkVersion):'26'$", badging, re.M) and "targetSdkVersion:'36'" in badging, "Unexpected SDK compatibility"
    signature = run(str(build_tools / "apksigner.bat"), "verify", "--verbose", "--print-certs", str(args.apk.resolve()))
    assert "Verified using v2 scheme (APK Signature Scheme v2): true" in signature, "APK v2 signature not verified"
    assert "Verified using v3 scheme (APK Signature Scheme v3): true" in signature, "APK v3 signature not verified"
    run(str(build_tools / "zipalign.exe"), "-c", "-P", "16", "4", str(args.apk.resolve()))
    libraries = {}
    with zipfile.ZipFile(args.apk) as archive:
        assert archive.testzip() is None, "APK ZIP CRC failed"
        members = archive.namelist()
        forbidden = [name for name in members if re.search(r"\.(?:exe|bat|cmd|ps1|p12|pfx|jks|keystore|sqlite|sqlite3|db)$", name, re.I)
                     or any(part in {"Data", "Incoming", "Library", ".http-tasks", "android-signing"} for part in name.split("/"))]
        assert not forbidden, f"Private, desktop or user-data payloads in APK: {forbidden}"
        abis = {name.split("/")[1] for name in members if name.startswith("lib/") and name.endswith(".so")}
        assert abis == {"arm64-v8a", "x86_64"}, f"Unexpected ABI set: {abis}"
        for abi, machine in [("arm64-v8a", 183), ("x86_64", 62)]:
            path = f"lib/{abi}/libacgn_hub_lib.so"
            libraries[abi] = elf_receipt(archive.read(path), machine)
    result = {"verifiedAt": datetime.now(timezone.utc).isoformat(), "file": args.apk.name,
              "sha256": hashlib.file_digest(args.apk.open("rb"), "sha256").hexdigest().upper(),
              "sizeBytes": args.apk.stat().st_size, "package": package[1], "versionCode": int(package[2]), "versionName": package[3],
              "minSdk": 26, "targetSdk": 36, "libraries": libraries,
              "signatureV2Verified": True, "signatureV3Verified": True, "zipCrcVerified": True, "zipAlignment16KiBVerified": True,
              "privateSigningMaterialBundled": False, "userDataBundled": False, "windowsBinariesBundled": False,
              "certificateSummary": [line for line in signature.splitlines() if "certificate SHA-256 digest:" in line]}
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
