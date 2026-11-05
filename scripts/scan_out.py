#!/usr/bin/env python3
"""阶段三 B：在内容公开前拦截疑似凭据。"""

from __future__ import annotations

import argparse
import os
import re
import sys

PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}"),
]


def scan_text(text: str, extra: list[str] | None = None) -> list[str]:
    hits: list[str] = []
    for secret in extra or []:
        if secret and len(secret) >= 8 and secret in text:
            hits.append("exact-secret")
    for pattern in PATTERNS:
        if pattern.search(text):
            hits.append(pattern.pattern)
    return hits


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    args = parser.parse_args()
    text = open(args.path, encoding="utf-8").read()
    extra = [value for key, value in os.environ.items() if key.startswith("SCAN_SECRET_")]
    hits = scan_text(text, extra)
    if hits:
        print("BLOCKED: " + ", ".join(sorted(set(hits))))
        sys.exit(2)
    print("clean")


if __name__ == "__main__":
    main()
