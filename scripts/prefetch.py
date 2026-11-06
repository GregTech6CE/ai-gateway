#!/usr/bin/env python3
"""阶段二 A：用确定性脚本下载并解压 issue 附件。"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402

INPUTS = c.ROOT / "inputs"
LOGS = INPUTS / "logs"
OUTPUTS = c.ROOT / "outputs"
LOGS.mkdir(parents=True, exist_ok=True)
OUTPUTS.mkdir(parents=True, exist_ok=True)

budget = c.budgets()["artifacts"]
TEXT_SUFFIXES = {".log", ".txt", ".json", ".md", ".cfg", ".toml", ".yaml", ".yml"}
INTERESTING = re.compile(r"error|exception|crash|caused by|gregtech|warn|fail", re.I)


def safe_name(url: str) -> str:
    name = url.split("?")[0].rstrip("/").split("/")[-1]
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
    return name[:120] or "attachment.bin"


def download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "gt6ce-ai-gateway"})
    with urllib.request.urlopen(request, timeout=60) as response:
        length = int(response.headers.get("Content-Length") or 0)
        if length and length > budget["max_attachment_bytes"]:
            raise RuntimeError(f"too large: {length} bytes")
        data = response.read(budget["max_attachment_bytes"] + 1)
    if len(data) > budget["max_attachment_bytes"]:
        raise RuntimeError("download exceeded size limit")
    target.write_bytes(data)


def extract(archive: Path, target_dir: Path) -> None:
    with zipfile.ZipFile(archive) as zf:
        total = 0
        for info in zf.infolist():
            if info.is_dir():
                continue
            total += info.file_size
            if total > budget["max_total_attachment_bytes"]:
                raise RuntimeError("archive expansion limit reached")
            name = Path(info.filename)
            if name.is_absolute() or ".." in name.parts:
                continue
            destination = target_dir / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as source, open(destination, "wb") as sink:
                sink.write(source.read())


def digest() -> str:
    lines: list[str] = ["# 日志摘要（已脱敏）", ""]
    for path in sorted(LOGS.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:400_000]
        except OSError:
            continue
        picked = [line for line in text.splitlines() if INTERESTING.search(line)][:120]
        lines.append(f"## {path.relative_to(INPUTS)}")
        lines.append("")
        lines.extend(c.redact(line)[:500] for line in picked[:80])
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    snapshot_path = INPUTS / "snapshot.json"
    if not snapshot_path.exists():
        raise SystemExit("snapshot.json missing")
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    total = 0
    notes = ["# 附件清单", ""]
    for url in snapshot.get("attachments", []):
        name = safe_name(url)
        target = LOGS / name
        try:
            download(url, target)
            total += target.stat().st_size
            if total > budget["max_total_attachment_bytes"]:
                raise RuntimeError("total attachment limit reached")
            notes.append(f"- {name}")
            if name.lower().endswith(".zip"):
                extract(target, LOGS / target.stem)
        except Exception as exc:
            notes.append(f"- {name}: 下载/解压失败 ({exc})")
    (LOGS / "README.md").write_text("\n".join(notes) + "\n", encoding="utf-8")
    (OUTPUTS / "log_digest.md").write_text(digest() + "\n", encoding="utf-8")
    print("\n".join(notes))


if __name__ == "__main__":
    main()
