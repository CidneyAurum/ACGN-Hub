"""Small JSON bridge for the optional jmcomic Python dependency.

The desktop application invokes this file with ``py -3`` and removes the
temporary copy immediately after the request.  It deliberately does not
accept cookies or arbitrary Python code from the UI.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def emit(value: dict) -> None:
    # Windows GUI 子进程的 stdout 可能仍是 GBK；ASCII 转义能稳定跨编码传回 Rust。
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else "health"
    import jmcomic

    if action == "health":
        emit({"ok": True, "version": getattr(jmcomic, "__version__", "unknown")})
        return

    from jmcomic import JmOption

    option = JmOption.default()
    client = option.new_jm_client(impl="api")

    if action == "search":
        keyword = sys.argv[2]
        page = client.search_site(keyword, page=1)
        items = []
        for album_id, data in page.content:
            items.append({
                "id": str(album_id),
                "title": str(data.get("name", "")).strip(),
                "tags": [str(tag) for tag in data.get("tags", [])] if isinstance(data.get("tags"), list) else [],
            })
        emit({"items": items})
        return

    if action == "chapters":
        album_id = sys.argv[2]
        album = client.get_album_detail(album_id)
        chapters = [
            {"id": str(photo_id), "index": str(index), "title": str(title).strip()}
            for photo_id, index, title, *_ in album.episode_list
        ]
        emit({"title": album.name, "chapters": chapters})
        return

    if action == "download":
        photo_id = sys.argv[2]
        output_dir = Path(sys.argv[3]).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        option = JmOption.construct({
            "log": False,
            "dir_rule": {"base_dir": str(output_dir), "rule": "Bd"},
            "download": {"threading": {"photo": 1, "image": 1}},
        })
        jmcomic.download_photo(photo_id, option)
        suffixes = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
        image_paths = sorted(
            str(path.resolve())
            for path in output_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in suffixes
        )
        if not image_paths:
            raise RuntimeError("jmcomic 未生成图片")
        emit({"imagePaths": image_paths})
        return

    raise ValueError(f"未知 jmcomic 操作: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - JSON boundary for the desktop app
        emit({"error": f"{type(exc).__name__}: {exc}"})
        raise
