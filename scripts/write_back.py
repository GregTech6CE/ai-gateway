#!/usr/bin/env python3
"""阶段三 C：复查开关、扫描渲染结果、发布或更新评论。"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402
import model_pool  # noqa: E402
import scan_out  # noqa: E402

TENANT_ID = c.env("TENANT")
REPO = c.env("REPO")
ISSUE = str(c.env("ISSUE"))
COMMENT_ID = c.env("COMMENT_ID", "")
GH_RW = c.env("GH_RW_TOKEN")
GH_RO = c.env("GH_RO_TOKEN", GH_RW)
SELF_TOKEN = c.env("SELF_TOKEN", "")
B_REPO = c.env("B_REPO", "")
BOT_ENABLED = c.env("BOT_ENABLED", "true").lower()
SNAPSHOT = c.env("SNAPSHOT_HASH", "")
RUN_URL = c.env("RUN_URL", "")
MODEL_KEY = c.env("MODEL_KEY_MISTRAL", "")

tenant = c.load_tenant(TENANT_ID)
OUTPUTS = c.ROOT / "outputs"
COMMENT = OUTPUTS / "comment.md"


def post(body: str) -> None:
    if COMMENT_ID:
        c.request("PATCH", f"/repos/{REPO}/issues/comments/{COMMENT_ID}", GH_RW, {"body": body})
    else:
        c.request("POST", f"/repos/{REPO}/issues/{ISSUE}/comments", GH_RW, {"body": body})


def stopped(reason: str) -> None:
    body = (
        f"分析已停止（{reason}）。\n\n"
        + c.marker("stopped", repo=REPO, issue=ISSUE, tenant=TENANT_ID, snapshot=SNAPSHOT)
    )
    post(body)


def main() -> None:
    if BOT_ENABLED == "false" or not tenant.get("enabled"):
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

    result = {"status": "failed", "reason": "result missing"}
    if (OUTPUTS / "result.json").exists():
        result = json.loads((OUTPUTS / "result.json").read_text(encoding="utf-8"))

    if COMMENT.exists():
        text = COMMENT.read_text(encoding="utf-8")
    else:
        text = (
            "分析未能完成。可以稍后重新触发，或由维护者手动查看运行记录。\n\n"
            + (f"[运行记录]({RUN_URL})\n\n" if RUN_URL else "")
            + c.marker("failed", repo=REPO, issue=ISSUE, snapshot=SNAPSHOT, tenant=TENANT_ID)
        )

    hits = scan_out.scan_text(text, [MODEL_KEY])
    if hits:
        print(f"BLOCKED: {hits}", file=sys.stderr)
        blocked = (
            "分析结果包含疑似敏感信息，已被拦截，未公开。维护者可在运行 artifact 中查看。\n\n"
            + (f"[运行记录]({RUN_URL})\n\n" if RUN_URL else "")
            + c.marker("blocked", repo=REPO, issue=ISSUE, snapshot=SNAPSHOT, tenant=TENANT_ID)
        )
        post(blocked)
        sys.exit(1)

    post(text)

    model_pool.merge_health(SELF_TOKEN, B_REPO, OUTPUTS / "model_health.json")

    answer_path = OUTPUTS / "answer.json"
    if answer_path.exists() and result.get("status") == "complete":
        try:
            answer = json.loads(answer_path.read_text(encoding="utf-8"))
            allowed = set(tenant.get("labels_allowlist", []))
            labels = [label for label in answer.get("labels", []) if label in allowed]
            if labels:
                c.request(
                    "POST", f"/repos/{REPO}/issues/{ISSUE}/labels", GH_RW, {"labels": labels}
                )
        except Exception as exc:
            print(f"label update skipped: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
