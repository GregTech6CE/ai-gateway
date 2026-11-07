#!/usr/bin/env python3
"""A 侧控制：占位评论、dispatch B、轮询 run、下载 artifact。"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def api(method: str, path: str, token: str, data=None):
    return c.request(method, path, token, data)


def placeholder_body(run_url: str) -> str:
    repo = env("REPO")
    issue = env("ISSUE")
    request_id = env("REQUEST_ID")
    bot_name = env("BOT_NAME", "gt6ce-bot")
    return (
        f"**{bot_name} 正在分析该 Issue...**\n\n"
        "感谢您的反馈！AI 正在自动分析该问题，预计耗时约 10 分钟。\n\n"
        "---\n\n"
        + (f"[GitHub Action 运行记录]({run_url})\n\n" if run_url else "")
        + c.marker("requested", repo=repo, issue=issue, request=request_id)
    )


def post_placeholder() -> dict:
    repo = env("REPO")
    issue = env("ISSUE")
    token = env("GH_RW_TOKEN")
    body = placeholder_body(env("RUN_URL"))
    return api("POST", f"/repos/{repo}/issues/{issue}/comments", token, {"body": body})


def update_placeholder(comment_id: str, run_url: str) -> None:
    if not comment_id:
        return
    repo = env("REPO")
    token = env("GH_RW_TOKEN")
    request_id = env("REQUEST_ID")
    try:
        current = api("GET", f"/repos/{repo}/issues/comments/{comment_id}", token)
        markers = c.parse_markers(current.get("body") or "")
        if not any(
            marker.get("kind") == "requested" and marker.get("request") == request_id
            for marker in markers
        ):
            return
        api(
            "PATCH",
            f"/repos/{repo}/issues/comments/{comment_id}",
            token,
            {"body": placeholder_body(run_url)},
        )
    except Exception as exc:
        print(f"placeholder update failed: {exc}", file=sys.stderr)


def precheck(repo: str, issue: str, token: str) -> tuple[str, str]:
    repo_cfg = c.load_repo(repo)
    if not repo_cfg.get("enabled"):
        return "repo disabled", ""
    data = api("GET", f"/repos/{repo}/issues/{issue}", token)
    title = ""
    try:
        repo_data = api("GET", f"/repos/{repo}", token)
        if not repo_data.get("private"):
            title = " ".join(str(data.get("title") or "").split())[:120]
    except Exception:
        title = ""
    if data.get("pull_request"):
        return "pull request, not an issue", title
    if data.get("state") != "open":
        return "issue is not open", title
    groups = (repo_cfg.get("triage") or {}).get("process_only") or []
    if groups:
        groups = [group if isinstance(group, list) else [group] for group in groups]
        labels = {str(item.get("name", "")).lower() for item in data.get("labels", [])}
        if not any(all(str(x).lower() in labels for x in group) for group in groups):
            return "process_only not matched", title
    return "", title


def start() -> None:
    repo = env("REPO")
    issue = env("ISSUE")
    event = env("EVENT", "issues")
    comment_id = env("COMMENT_ID")
    request_id = env("REQUEST_ID")
    dry_run = env("DRY_RUN", "false").lower() == "true"
    b_repo = env("B_REPO", "GregTech6CE/ai-gateway")
    b_pat = env("B_PAT")
    if not b_pat:
        raise SystemExit("B_PAT missing")
    skip, issue_title = precheck(repo, issue, env("GH_RW_TOKEN"))
    if skip:
        print(json.dumps({"skipped": skip, "repo": repo, "issue": issue}, ensure_ascii=False))
        return

    comment = {} if dry_run else post_placeholder()
    payload = {
        "ref": "master",
        "return_run_details": True,
        "inputs": {
            "repo": repo,
            "issue": issue,
            "issue_title": issue_title,
            "event": event,
            "comment_id": comment_id,
            "placeholder_comment_id": str(comment.get("id", "")),
            "dry_run": "true" if dry_run else "false",
            "request_id": request_id,
        },
    }
    try:
        result = api(
            "POST",
            f"/repos/{b_repo}/actions/workflows/orchestrator.yml/dispatches",
            b_pat,
            payload,
        )
    except Exception:
        if comment.get("id"):
            try:
                api("DELETE", f"/repos/{repo}/issues/comments/{comment['id']}", env("GH_RW_TOKEN"))
            except Exception:
                pass
        raise
    run_id = result.get("workflow_run_id") or result.get("run_id")
    if not run_id:
        if comment.get("id"):
            try:
                api("DELETE", f"/repos/{repo}/issues/comments/{comment['id']}", env("GH_RW_TOKEN"))
            except Exception:
                pass
        raise SystemExit(f"dispatch did not return workflow_run_id: {result}")
    run_url = f"https://github.com/{b_repo}/actions/runs/{run_id}"
    update_placeholder(str(comment.get("id", "")), run_url)
    c.set_output("comment_id", str(comment.get("id", "")))
    c.set_output("run_id", str(run_id))
    c.set_output("run_url", str(run_url))
    print(
        json.dumps(
            {
                "repo": repo,
                "issue": issue,
                "comment_id": comment.get("id", ""),
                "run_id": run_id,
                "run_url": run_url,
                "dry_run": dry_run,
            },
            ensure_ascii=False,
        )
    )


def wait_run(b_repo: str, pat: str, run_id: str) -> dict:
    timeout = int(env("TIMEOUT_MINUTES", "90")) * 60
    deadline = time.monotonic() + timeout
    while True:
        try:
            run = api("GET", f"/repos/{b_repo}/actions/runs/{run_id}", pat)
        except Exception as exc:
            message = str(exc)
            if any(code in message for code in ("-> 401:", "-> 403:", "-> 404:")):
                raise
            print(f"poll failed: {exc}", file=sys.stderr)
            if time.monotonic() > deadline:
                print(f"B run {run_id} timeout after {timeout // 60} minutes")
                return {"status": "timeout", "conclusion": "timed_out"}
            time.sleep(20)
            continue
        status = run.get("status")
        conclusion = run.get("conclusion")
        print(f"B run {run_id}: status={status} conclusion={conclusion}")
        if status == "completed":
            return run
        if time.monotonic() > deadline:
            print(f"B run {run_id} timeout after {timeout // 60} minutes")
            return {"status": "timeout", "conclusion": "timed_out"}
        time.sleep(20)


def fallback_result(run_id: str, run: dict) -> dict:
    outcome = run.get("conclusion") or run.get("status") or "unknown"
    return {
        "status": "failed",
        "reason": f"B run {run_id} {outcome}",
        "turns": 0,
        "elapsed_sec": 0,
        "tokens": 0,
        "exit_code": -1,
        "entry_id": "",
        "run_conclusion": outcome,
    }


class StripAuthRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            new.remove_header("Authorization")
        return new


def download_artifact(b_repo: str, pat: str, artifact: dict, target: Path, prefix: str) -> None:
    url = f"https://api.github.com/repos/{b_repo}/actions/artifacts/{artifact['id']}/zip"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {pat}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "gt6ce-ai-gateway-control",
        },
    )
    opener = urllib.request.build_opener(StripAuthRedirect)
    with opener.open(request, timeout=120) as response:
        payload = response.read()
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        names = zf.namelist()
        extract_root = target
        if any(name.startswith(prefix + "/") for name in names):
            extract_root = target.parent
        extract_root.mkdir(parents=True, exist_ok=True)
        for info in zf.infolist():
            name = info.filename
            if name.startswith("/") or ".." in Path(name).parts:
                continue
            zf.extract(info, extract_root)


def finish() -> None:
    b_repo = env("B_REPO", "GregTech6CE/ai-gateway")
    pat = env("B_PAT")
    run_id = env("RUN_ID")
    if not pat or not run_id:
        raise SystemExit("B_PAT/RUN_ID missing")
    out = Path(env("OUT_DIR", "."))
    run = wait_run(b_repo, pat, run_id)
    try:
        artifacts = api(
            "GET",
            f"/repos/{b_repo}/actions/runs/{run_id}/artifacts?per_page=100",
            pat,
        ).get("artifacts", [])
    except Exception as exc:
        print(f"list artifacts failed: {exc}", file=sys.stderr)
        artifacts = []
    found = []
    for artifact in artifacts:
        name = artifact.get("name", "")
        try:
            if name == f"gate-{run_id}":
                download_artifact(b_repo, pat, artifact, out / "inputs", "inputs")
                found.append(name)
            elif name == f"analysis-{run_id}":
                download_artifact(b_repo, pat, artifact, out / "outputs", "outputs")
                found.append(name)
        except Exception as exc:
            print(f"download {name} failed: {exc}", file=sys.stderr)
    verdict_path = out / "inputs/verdict.json"
    verdict = {}
    if verdict_path.exists():
        try:
            verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
            print(json.dumps({"verdict": verdict}, ensure_ascii=False))
        except Exception:
            verdict = {}
    result_path = out / "outputs/result.json"
    if not result_path.exists():
        decision = verdict.get("decision")
        if decision == "proceed" or (not verdict and run.get("conclusion") != "success"):
            fallback = fallback_result(run_id, run)
            c.dump_json(result_path, fallback)
            print(json.dumps({"result_fallback": fallback}, ensure_ascii=False))
    print(
        json.dumps(
            {
                "run_id": run_id,
                "conclusion": run.get("conclusion"),
                "artifacts": found,
            },
            ensure_ascii=False,
        )
    )


def cleanup() -> None:
    repo = env("REPO")
    comment_id = env("COMMENT_ID")
    token = env("GH_RW_TOKEN")
    if not comment_id:
        return
    try:
        api("DELETE", f"/repos/{repo}/issues/comments/{comment_id}", token)
        print(f"deleted placeholder {comment_id}")
    except Exception as exc:
        print(f"delete placeholder failed: {exc}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("start", "finish", "cleanup"))
    args = parser.parse_args()
    if args.command == "start":
        start()
    elif args.command == "finish":
        finish()
    else:
        cleanup()


if __name__ == "__main__":
    main()
