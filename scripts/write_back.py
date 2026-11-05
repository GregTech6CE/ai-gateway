#!/usr/bin/env python3
"""阶段三 C：复查开关、扫描渲染结果、发布或更新评论。"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402
import scan_out  # noqa: E402

REPO = c.env("REPO")
ISSUE = str(c.env("ISSUE"))
COMMENT_ID = c.env("COMMENT_ID", "")
GH_RW = c.env("GH_RW_TOKEN")
GH_RO = c.env("GH_RO_TOKEN", GH_RW)
BOT_ENABLED = c.env("BOT_ENABLED", "true").lower()
SNAPSHOT = c.env("SNAPSHOT_HASH", "")
RUN_URL = c.env("RUN_URL", "")
DRY_RUN = c.env("DRY_RUN", "false").lower() == "true"

repo_cfg = c.load_repo(REPO)
OUTPUTS = c.ROOT / "outputs"
COMMENT = OUTPUTS / "comment.md"
ANSWER = OUTPUTS / "answer.json"


def apply_triage(issue: dict) -> None:
    if not ANSWER.exists():
        return
    try:
        answer = json.loads(ANSWER.read_text(encoding="utf-8"))
    except Exception:
        return
    cfg = repo_cfg.get("triage", {})
    allowed = {str(item).lower() for item in cfg.get("write_only", [])} - {"needs triage"}
    raw = [str(item).strip() for item in answer.get("labels") or []]
    labels = [item for item in dict.fromkeys(raw) if item.lower() in allowed]
    if not labels:
        return
    current = {
        str(label.get("name", "")).lower(): str(label.get("name", ""))
        for label in issue.get("labels", [])
    }
    try:
        repo_labels = c.paginate(f"/repos/{REPO}/labels", GH_RO, max_pages=2)
        existing = {
            str(label.get("name", "")).lower(): str(label.get("name", ""))
            for label in repo_labels
        }
    except Exception as exc:
        print(f"读取 label 失败: {exc}", file=sys.stderr)
        existing = {}
    to_add: list[str] = []
    resolved = False
    for label in labels:
        key = label.lower()
        if key in current or key in existing:
            resolved = True
        if key in existing and key not in current:
            to_add.append(existing[key])
    if to_add:
        c.request("POST", f"/repos/{REPO}/issues/{ISSUE}/labels", GH_RW, {"labels": to_add})
    triggers = {str(item).lower() for item in cfg.get("triage_labels", [])}
    if cfg.get("remove_after_triage", True) and resolved and (triggers & set(current)):
        for trigger in triggers & set(current):
            name = current[trigger]
            c.request(
                "DELETE",
                f"/repos/{REPO}/issues/{ISSUE}/labels/{urllib.parse.quote(name, safe='')}",
                GH_RW,
            )


def post(body: str) -> None:
    if COMMENT_ID:
        c.request("PATCH", f"/repos/{REPO}/issues/comments/{COMMENT_ID}", GH_RW, {"body": body})
    else:
        c.request("POST", f"/repos/{REPO}/issues/{ISSUE}/comments", GH_RW, {"body": body})


def stopped(reason: str) -> None:
    body = (
        f"分析已停止（{reason}）。\n\n"
        + c.marker("stopped", repo=REPO, issue=ISSUE, snapshot=SNAPSHOT)
    )
    post(body)


def main() -> None:
    if DRY_RUN:
        print("dry_run=true: skip write-back")
        return
    if BOT_ENABLED == "false" or not repo_cfg.get("enabled"):
        stopped("功能已被禁用")
        return

    try:
        issue = c.request("GET", f"/repos/{REPO}/issues/{ISSUE}", GH_RO)
        if "bot:stop" in {label.get("name") for label in issue.get("labels", [])}:
            stopped("bot:stop")
            return
        if issue.get("state") != "open":
            stopped("issue 已关闭")
            return
    except Exception as exc:
        print(f"switch check failed: {exc}", file=sys.stderr)
        issue = {}

    result = {"status": "failed", "reason": "result missing"}
    if (OUTPUTS / "result.json").exists():
        result = json.loads((OUTPUTS / "result.json").read_text(encoding="utf-8"))

    scan = result.get("secret_scan") or {}
    if scan.get("ok") is False or scan.get("hits"):
        print(f"BLOCKED: supervisor secret_scan {scan}", file=sys.stderr)
        blocked = (
            "分析结果包含疑似敏感信息，已被拦截，未公开。维护者可在运行 artifact 中查看。\n\n"
            + (f"[运行记录]({RUN_URL})\n\n" if RUN_URL else "")
            + c.marker("blocked", repo=REPO, issue=ISSUE, snapshot=SNAPSHOT)
        )
        post(blocked)
        sys.exit(1)

    if COMMENT.exists():
        text = COMMENT.read_text(encoding="utf-8")
    else:
        text = (
            "分析未能完成。可以稍后重新触发，或由维护者手动查看运行记录。\n\n"
            + (f"[运行记录]({RUN_URL})\n\n" if RUN_URL else "")
            + c.marker("failed", repo=REPO, issue=ISSUE, snapshot=SNAPSHOT)
        )

    hits = scan_out.scan_text(text)
    if hits:
        print(f"BLOCKED: {hits}", file=sys.stderr)
        blocked = (
            "分析结果包含疑似敏感信息，已被拦截，未公开。维护者可在运行 artifact 中查看。\n\n"
            + (f"[运行记录]({RUN_URL})\n\n" if RUN_URL else "")
            + c.marker("blocked", repo=REPO, issue=ISSUE, snapshot=SNAPSHOT)
        )
        post(blocked)
        sys.exit(1)

    post(text)

    try:
        apply_triage(issue)
    except Exception as exc:
        print(f"triage apply failed: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
