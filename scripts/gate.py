#!/usr/bin/env python3
"""阶段一（B 侧只读）：校验请求、构建快照、选择模型入口。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402
import model_pool  # noqa: E402

INPUTS = c.ROOT / "inputs"
INPUTS.mkdir(exist_ok=True)

REPO = c.env("REPO")
ISSUE = str(c.env("ISSUE"))
COMMENT_ID = c.env("COMMENT_ID", "")
EVENT = c.env("EVENT", "issues")
GH_RO = c.env("GH_RO_TOKEN", "")
SELF_TOKEN = c.env("SELF_TOKEN", GH_RO)
BOT_ENABLED = c.env("BOT_ENABLED", "true").lower()
B_REPO = c.env("B_REPO", os.environ.get("GITHUB_REPOSITORY", ""))
REQUEST_ID = c.env("REQUEST_ID", "")

budget = c.budgets()
repo_cfg: dict = {}
pool = None
health = None
ALLOWED_ASSOC = {"OWNER", "MEMBER", "COLLABORATOR"}


def cache_prefix(code_repo: str) -> str:
    return "gt6-mirror-" + code_repo.lower().replace("/", "-")


def finish(decision: str, reason: str, **extra) -> None:
    verdict = {
        "decision": decision,
        "reason": reason,
        "repo": REPO,
        "issue": int(ISSUE),
        "captured_at": datetime.now(timezone.utc).isoformat(),
        **extra,
    }
    c.dump_json(INPUTS / "verdict.json", verdict)
    c.set_output("decision", decision)
    c.set_output("reason", reason)
    for key, value in extra.items():
        if isinstance(value, (str, int)):
            c.set_output(key, str(value))
    print(json.dumps(verdict, ensure_ascii=False))
    sys.exit(0)


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def is_current(parsed: dict) -> bool:
    return bool(REQUEST_ID) and parsed.get("request") == REQUEST_ID


def remote_tags(repo: str) -> set[str] | None:
    try:
        result = subprocess.run(
            ["git", "ls-remote", "--tags", f"https://github.com/{repo}.git"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        tags = set()
        for line in result.stdout.splitlines():
            ref = line.split("	")[-1]
            if ref.startswith("refs/tags/"):
                tags.add(ref[len("refs/tags/"):].removesuffix("^{}"))
        return tags
    except Exception:
        return None


def resolve_ref() -> str:
    body = issue.get("body") or ""
    version = c.form_field(body, "模组版本 / Mod version", "模组版本", "Mod version").strip()
    base = version[1:] if version[:1].lower() == "v" else version
    template = repo_cfg.get("tag_template", "v{version}")
    candidates: list[str] = []
    if base and repo_cfg.get("code_ref_mode", "tag") == "tag":
        formatted = template.replace("{version}", base)
        if formatted:
            candidates.append(formatted)
        if base not in candidates:
            candidates.append(base)
    fallback = repo_cfg.get("fallback_ref", "master")
    candidates.append(fallback)
    tags = remote_tags(repo_cfg["code_repo"])
    if tags:
        for candidate in candidates:
            if candidate in tags:
                return candidate
        return fallback
    return candidates[0] if candidates else fallback


def main() -> None:
    global repo_cfg, pool, health
    try:
        repo_cfg = c.load_repo(REPO)
    except SystemExit as exc:
        finish("skip", str(exc))
    if BOT_ENABLED == "false":
        finish("skip", "BOT_ENABLED=false")
    if not repo_cfg.get("enabled"):
        finish("skip", "repo disabled")
    if EVENT not in ("issues", "issue_comment"):
        finish("skip", f"unknown event: {EVENT}")

    pool = model_pool.load_pool(repo_cfg.get("model_pool", "shared"))
    health = model_pool.read_health(SELF_TOKEN, B_REPO)

    # App installation 已由 A 侧的 token 生成步骤证明；B 只读公开 A。
    try:
        if B_REPO:
            bot_repo = c.request("GET", f"/repos/{B_REPO}", SELF_TOKEN)
            if not bot_repo.get("private"):
                target_repo = c.request("GET", f"/repos/{REPO}", GH_RO)
                if target_repo.get("private"):
                    finish("skip", "private issue repo with public bot repo")
    except Exception as exc:
        finish("skip", f"visibility check failed: {exc}")

    global issue
    issue = c.request("GET", f"/repos/{REPO}/issues/{ISSUE}", GH_RO)
    if issue.get("pull_request"):
        finish("skip", "pull request, not an issue")
    if issue.get("state") != "open":
        finish("skip", "issue is not open")

    triage_cfg = repo_cfg.get("triage", {})
    groups = triage_cfg.get("process_only") or []
    if groups:
        groups = [group if isinstance(group, list) else [group] for group in groups]
        issue_labels = {str(label.get("name", "")).lower() for label in issue.get("labels", [])}
        matched = any(all(str(item).lower() in issue_labels for item in group) for group in groups)
        if not matched:
            finish("skip", "process_only not matched")

    association = issue.get("author_association", "")
    if EVENT == "issue_comment":
        if not COMMENT_ID:
            finish("skip", "comment id missing")
        comment = c.request("GET", f"/repos/{REPO}/issues/comments/{COMMENT_ID}", GH_RO)
        if not str(comment.get("issue_url", "")).endswith(f"/issues/{ISSUE}"):
            finish("skip", "comment does not belong to this issue")
        if (comment.get("user") or {}).get("type") == "Bot":
            finish("skip", "bot comment")
        mention = repo_cfg.get("bot_mention", "").lower()
        if not mention or mention not in (comment.get("body") or "").lower():
            finish("skip", "mention missing")
        association = comment.get("author_association", "")
        if association not in ALLOWED_ASSOC:
            finish("skip", f"comment author is not a maintainer ({association})")

    comments = c.paginate(f"/repos/{REPO}/issues/{ISSUE}/comments", GH_RO, max_pages=5)
    now = datetime.now(timezone.utc)
    markers = []
    for item in comments:
        if c.bot_login_matches(item.get("user") or {}, repo_cfg):
            for parsed in c.parse_markers(item.get("body") or ""):
                markers.append((parsed, item))
    if any(parsed["kind"] == "done" and not is_current(parsed) for parsed, _ in markers):
        finish("skip", "already done")
    if any(parsed["kind"] == "rejected" and not is_current(parsed) for parsed, _ in markers):
        finish("skip", "already rejected")
    for parsed, item in markers:
        if is_current(parsed):
            continue
        if parsed["kind"] in ("requested", "running"):
            age = now - parse_time(item["created_at"])
            if age < timedelta(minutes=budget["running_stale_minutes"]):
                finish("skip", "request already in flight")

    since_1h = (now - timedelta(hours=1)).isoformat()
    recent = c.paginate(
        f"/repos/{REPO}/issues/comments?since={urllib.parse.quote(since_1h)}", GH_RO, max_pages=3
    )
    same_issue = 0
    for item in recent:
        if not c.bot_login_matches(item.get("user") or {}, repo_cfg):
            continue
        if not str(item.get("issue_url", "")).endswith(f"/issues/{ISSUE}"):
            continue
        if any(
            p["kind"] in ("requested", "running") and not is_current(p)
            for p in c.parse_markers(item.get("body") or "")
        ):
            same_issue += 1
    if same_issue >= budget["per_issue_per_hour"]:
        finish("skip", "per-issue hourly quota reached")

    since_24h = (now - timedelta(hours=24)).isoformat()
    repo_recent = c.paginate(
        f"/repos/{REPO}/issues/comments?since={urllib.parse.quote(since_24h)}", GH_RO, max_pages=5
    )
    repo_count = sum(
        1
        for item in repo_recent
        if c.bot_login_matches(item.get("user") or {}, repo_cfg)
        and any(
            p["kind"] == "requested" and not is_current(p)
            for p in c.parse_markers(item.get("body") or "")
        )
    )
    if repo_count >= budget["per_repo_per_day"]:
        finish("skip", "per-repo daily quota reached")

    if B_REPO:
        runs = c.request(
            "GET",
            f"/repos/{B_REPO}/actions/workflows/orchestrator.yml/runs"
            f"?created=>={urllib.parse.quote(since_24h)}&per_page=1",
            SELF_TOKEN,
        )
        if runs.get("total_count", 0) >= budget["global_per_day"]:
            finish("skip", "global daily quota reached")

    body = issue.get("body") or ""
    texts = "\n".join([body] + [(item.get("body") or "") for item in comments])
    attachments = c.attachments(texts)
    snapshot = {
        "repo": REPO,
        "issue": {
            "number": issue["number"],
            "title": issue.get("title") or "",
            "body": body,
            "labels": [label["name"] for label in issue.get("labels", [])],
            "author": (issue.get("user") or {}).get("login", ""),
            "author_association": association,
            "created_at": issue.get("created_at"),
            "updated_at": issue.get("updated_at"),
        },
        "comments": [
            {
                "id": item["id"],
                "author": (item.get("user") or {}).get("login", ""),
                "association": item.get("author_association", ""),
                "created_at": item.get("created_at"),
                "body": item.get("body") or "",
            }
            for item in comments
            if not c.bot_login_matches(item.get("user") or {}, repo_cfg)
        ],
        "attachments": attachments,
        "code_repo": repo_cfg["code_repo"],
        "code_ref": resolve_ref(),
        "captured_at": now.isoformat(),
    }
    canonical = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
    snapshot["sha256"] = c.sha256_text(canonical)
    c.dump_json(INPUTS / "snapshot.json", snapshot)
    (INPUTS / "issue.md").write_text(
        f"# {snapshot['issue']['title']}\n\n{body}\n", encoding="utf-8"
    )

    analysis_entries = model_pool.candidates(pool, "analysis", health, require_key=False)
    c.dump_json(
        INPUTS / "model.json",
        {
            "pool": repo_cfg.get("model_pool", "shared"),
            "analysis_entries": analysis_entries,
        },
    )

    refs = [snapshot["code_ref"]]
    for extra in repo_cfg.get("extra_code_refs", []) or []:
        extra = str(extra).strip()
        if extra and extra not in refs:
            refs.append(extra)
    code_refs = " ".join(refs)
    run_cache_prefix = cache_prefix(repo_cfg["code_repo"])

    finish(
        "proceed",
        "accepted",
        snapshot_hash=snapshot["sha256"],
        code_ref=snapshot["code_ref"],
        code_repo=snapshot["code_repo"],
        code_refs=code_refs,
        cache_prefix=run_cache_prefix,
        issue_title=issue.get("title", ""),
    )


if __name__ == "__main__":
    main()
