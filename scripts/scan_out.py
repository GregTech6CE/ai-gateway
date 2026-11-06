#!/usr/bin/env python3
"""阶段三 B：在内容公开前拦截并就地脱敏疑似凭据。"""

from __future__ import annotations

import argparse
import os
import re
import sys

REDACTED = "[REDACTED]"

PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}"),
]

# 私钥是块状结构：只替换头部会把 base64 主体留在正文里，因此整块匹配。
# 缺 END 的半截块（日志被截断、粘贴不完整）一直吞到文末，宁可多删也不留主体。
PEM_BLOCK = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)"
)


def _secrets(extra: list[str] | None) -> list[str]:
    """长值先替换，避免短值先命中导致长值被切碎后无法整体匹配。"""
    return sorted({s for s in extra or [] if s and len(s) >= 8}, key=len, reverse=True)


def scan_text(text: str, extra: list[str] | None = None) -> list[str]:
    hits: list[str] = []
    for secret in _secrets(extra):
        if secret in text:
            hits.append("exact-secret")
            break
    for pattern in PATTERNS:
        if pattern.search(text):
            hits.append(pattern.pattern)
    return hits


def redact(text: str, extra: list[str] | None = None) -> str:
    """就地脱敏：私钥块整体替换，其后是精确值与单行模式。"""
    out = PEM_BLOCK.sub(REDACTED, text)
    for secret in _secrets(extra):
        out = out.replace(secret, REDACTED)
    for pattern in PATTERNS:
        out = pattern.sub(REDACTED, out)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--redact", action="store_true", help="命中后就地脱敏，而不是只报告")
    args = parser.parse_args()
    with open(args.path, encoding="utf-8", newline="") as fh:
        text = fh.read()
    extra = [value for key, value in os.environ.items() if key.startswith("SCAN_SECRET_")]
    hits = scan_text(text, extra)
    if args.redact:
        cleaned = redact(text, extra)
        if cleaned != text:
            with open(args.path, "w", encoding="utf-8", newline="") as fh:
                fh.write(cleaned)
            print(f"redacted: {', '.join(sorted(set(hits)))}")
            return
        if hits:
            print("BLOCKED: 命中但无法改写")
            sys.exit(2)
        print("clean")
        return
    if hits:
        print("BLOCKED: " + ", ".join(sorted(set(hits))))
        sys.exit(2)
    print("clean")


if __name__ == "__main__":
    main()
