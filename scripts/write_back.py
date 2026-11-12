#!/usr/bin/env python3
"""阶段三 C：复查开关、扫描渲染结果、发布或更新评论。"""

from __future__ import annotations

import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402
import labels  # noqa: E402
import scan_out  # noqa: E402

OUTPUTS = c.ROOT / "outputs"
COMMENT = OUTPUTS / "comment.md"
ANSWER = OUTPUTS / "answer.json"


def load_config() -> dict:
    """读取运行期配置。

    这一步以前发生在 import 时（模块级 `c.env(...)` + `load_repo`），代价是无法导入测试——
    缺 `REPO` 就直接 `SystemExit`。现在收进函数，导入成为纯操作，`main()` 才解析环境。
    """
    repo = c.env("REPO")
    gh_rw = c.env("GH_RW_TOKEN")
    return {
        "repo": repo,
        "issue": str(c.env("ISSUE")),
        "comment_id": c.env("COMMENT_ID", ""),
        "gh_rw": gh_rw,
        "gh_ro": c.env("GH_RO_TOKEN", gh_rw),
        "bot_enabled": c.env("BOT_ENABLED", "true").lower(),
        "run_url": c.env("RUN_URL", ""),
        "dry_run": c.env("DRY_RUN", "false").lower() == "true",
        "repo_cfg": c.load_repo(repo),
    }


def apply_triage(issue: dict, cfg: dict) -> None:
    repo, issue_number = cfg["repo"], cfg["issue"]
    repo_cfg = cfg["repo_cfg"]
    if not ANSWER.exists():
        return
    try:
        answer = json.loads(ANSWER.read_text(encoding="utf-8"))
    except Exception:
        return
    if not labels.is_valid_type(answer.get("issue_type"), repo_cfg):
        print("invalid issue_type; skip triage", file=sys.stderr)
        return
    triage_cfg = repo_cfg.get("triage", {})
    kept, dropped, _ = labels.sanitize(
        answer.get("labels") or [], answer.get("issue_type"), repo_cfg
    )
    if dropped:
        print(f"labels dropped: {labels.format_dropped(dropped)}", file=sys.stderr)
    if not kept:
        return
    current = {
        str(label.get("name", "")).lower(): str(label.get("name", ""))
        for label in issue.get("labels", [])
    }
    try:
        repo_labels = c.paginate(f"/repos/{repo}/labels", cfg["gh_ro"], max_pages=2)
        existing = {
            str(label.get("name", "")).lower(): str(label.get("name", ""))
            for label in repo_labels
        }
    except Exception as exc:
        print(f"读取 label 失败: {exc}", file=sys.stderr)
        existing = {}
    to_add: list[str] = []
    resolved = False
    for label in kept:
        key = label.lower()
        if key in current or key in existing:
            resolved = True
        if key in existing and key not in current:
            to_add.append(existing[key])
    if to_add:
        c.request(
            "POST", f"/repos/{repo}/issues/{issue_number}/labels", cfg["gh_rw"], {"labels": to_add}
        )
    triggers = {str(item).lower() for item in triage_cfg.get("triage_labels", [])}
    if triage_cfg.get("remove_after_triage", True) and resolved and (triggers & set(current)):
        for trigger in triggers & set(current):
            name = current[trigger]
            c.request(
                "DELETE",
                f"/repos/{repo}/issues/{issue_number}/labels/{urllib.parse.quote(name, safe='')}",
                cfg["gh_rw"],
            )


def post(body: str, cfg: dict) -> None:
    if cfg["comment_id"]:
        try:
            c.request(
                "PATCH",
                f"/repos/{cfg['repo']}/issues/comments/{cfg['comment_id']}",
                cfg["gh_rw"],
                {"body": body},
            )
            return
        except c.GitHubApiError as exc:
            if exc.status not in (404, 410):
                raise
            print("placeholder comment missing; posting a new comment", file=sys.stderr)
    c.request(
        "POST",
        f"/repos/{cfg['repo']}/issues/{cfg['issue']}/comments",
        cfg["gh_rw"],
        {"body": body},
    )


def stopped(reason: str, cfg: dict) -> None:
    body = (
        f"分析已停止（{reason}）。\n\n"
        + c.marker("stopped", repo=cfg["repo"], issue=cfg["issue"])
    )
    post(body, cfg)


def main(cfg: dict | None = None) -> None:
    cfg = cfg or load_config()
    repo, issue_number = cfg["repo"], cfg["issue"]
    if cfg["dry_run"]:
        print("dry_run=true: skip write-back")
        return
    if cfg["bot_enabled"] == "false" or not cfg["repo_cfg"].get("enabled"):
        stopped("功能已被禁用", cfg)
        return

    try:
        issue = c.request("GET", f"/repos/{repo}/issues/{issue_number}", cfg["gh_ro"])
        if "bot:stop" in {label.get("name") for label in issue.get("labels", [])}:
            stopped("bot:stop", cfg)
            return
        if issue.get("state") != "open":
            stopped("issue 已关闭", cfg)
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
            + (f"[运行记录]({cfg['run_url']})\n\n" if cfg["run_url"] else "")
            + c.marker("blocked", repo=repo, issue=issue_number)
        )
        post(blocked, cfg)
        sys.exit(1)

    if COMMENT.exists():
        text = COMMENT.read_text(encoding="utf-8")
    else:
        reason = str(result.get("reason") or "").strip()
        detail = f"（{reason}）" if reason and reason != "result missing" else ""
        text = (
            f"分析未能完成{detail}。可以稍后重新触发，或由维护者手动查看运行记录。\n\n"
            + (f"[运行记录]({cfg['run_url']})\n\n" if cfg["run_url"] else "")
            + c.marker("failed", repo=repo, issue=issue_number)
        )

    # 精确密钥必须一起传，否则 `SCAN_SECRET_*` 在这一层不被拦截。
    hits = scan_out.scan_text(text, scan_out.secrets_from_env())
    if hits:
        print(f"BLOCKED: {hits}", file=sys.stderr)
        blocked = (
            "分析结果包含疑似敏感信息，已被拦截，未公开。维护者可在运行 artifact 中查看。\n\n"
            + (f"[运行记录]({cfg['run_url']})\n\n" if cfg["run_url"] else "")
            + c.marker("blocked", repo=repo, issue=issue_number)
        )
        post(blocked, cfg)
        sys.exit(1)

    post(text, cfg)

    try:
        apply_triage(issue, cfg)
    except Exception as exc:
        print(f"triage apply failed: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
