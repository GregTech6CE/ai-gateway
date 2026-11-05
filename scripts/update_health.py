#!/usr/bin/env python3
"""B 侧独立步骤：用 MODEL_HEALTH_TOKEN 写 MODEL_HEALTH variable。"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402


def main() -> None:
    token = os.environ.get("MODEL_HEALTH_TOKEN", "").strip()
    repo = os.environ.get("B_REPO") or os.environ.get("GITHUB_REPOSITORY", "")
    path = Path(os.environ.get("MODEL_HEALTH_PATH", "outputs/model_health.json"))
    if not token:
        print("MODEL_HEALTH_TOKEN missing; skip health update", file=sys.stderr)
        sys.exit(1)
    if not repo:
        print("B_REPO missing; skip health update", file=sys.stderr)
        sys.exit(1)
    if not path.exists():
        print(f"{path} missing; skip health update")
        return
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"invalid health state: {exc}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(state, dict):
        print("invalid health state: not an object", file=sys.stderr)
        sys.exit(1)
    if not state.get("endpoints"):
        print("no endpoint state; skip health update")
        return
    body = {"name": "MODEL_HEALTH", "value": json.dumps(state, ensure_ascii=False)}
    try:
        c.request("PATCH", f"/repos/{repo}/actions/variables/MODEL_HEALTH", token, body)
    except Exception as exc:
        if "-> 404" not in str(exc):
            print(f"update health failed: {exc}", file=sys.stderr)
            sys.exit(1)
        c.request("POST", f"/repos/{repo}/actions/variables", token, body)
    endpoints = state.get("endpoints") or {}
    print(f"MODEL_HEALTH updated ({len(endpoints)} endpoints)")


if __name__ == "__main__":
    main()
