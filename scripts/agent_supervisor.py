#!/usr/bin/env python3
"""阶段二 B：在墙钟与循环检测下运行固定版本的 Codex CLI。"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402
import model_pool  # noqa: E402

TENANT_ID = c.env("TENANT")
REPO = c.env("REPO")
ISSUE = str(c.env("ISSUE"))
GH_RO = c.env("GH_RO_TOKEN", "")
BOT_ENABLED = c.env("BOT_ENABLED", "true").lower()
RERUN_PROMPT = os.environ.get("RERUN_PROMPT", "")

tenant = c.load_tenant(TENANT_ID)
budget = c.budgets()
pool_cfg = budget.get("model_pool", {})
OUTPUTS = c.ROOT / "outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
LOG_PATH = OUTPUTS / "agent_output.log"
ANSWER_MD = OUTPUTS / "answer.md"
ANSWER_JSON = OUTPUTS / "answer.json"
RESULT_PATH = OUTPUTS / "result.json"
HEALTH_PATH = OUTPUTS / "model_health.json"
REQUIRED = ("issue_type", "conclusion", "confidence", "evidence", "fix_plan", "labels", "partial")


def validate_answer() -> bool:
    if not ANSWER_JSON.exists():
        return False
    try:
        data = json.loads(ANSWER_JSON.read_text(encoding="utf-8"))
    except Exception:
        return False
    if not isinstance(data, dict):
        return False
    if any(key not in data for key in REQUIRED):
        return False
    if data.get("confidence") not in ("high", "medium", "low"):
        return False
    if not isinstance(data.get("evidence"), list) or not isinstance(data.get("fix_plan"), list):
        return False
    if not isinstance(data.get("conclusion"), str) or len(data["conclusion"].strip()) < 10:
        return False
    return True


def build_prompt() -> str:
    if RERUN_PROMPT:
        return RERUN_PROMPT
    skill = (c.ROOT / "prompts/analyze.md").read_text(encoding="utf-8")
    nodes = (c.ROOT / "prompts/nodes.md").read_text(encoding="utf-8")
    return (
        f"{skill}\n\n{nodes}\n\n"
        f"目标 issue：{REPO}#{ISSUE}\n"
        "工作目录：inputs/、code/、outputs/。只读 inputs/ 与 code/，只写 outputs/。\n"
    )


def write_codex_config(entry: dict, key: str) -> dict[str, str]:
    alias = re.sub(r"[^A-Za-z0-9_]", "_", entry.get("provider_alias") or entry["id"])
    home = c.ROOT / ".codex"
    home.mkdir(exist_ok=True)
    config = "\n".join(
        [
            f'model = "{entry["model"]}"',
            f'model_provider = "{alias}"',
            f'model_context_window = {int(entry.get("context", 200000))}',
            f'model_reasoning_effort = "{entry.get("effort", "")}"',
            'approval_policy = "never"',
            'sandbox_mode = "danger-full-access"',
            "",
            f"[model_providers.{alias}]",
            f'name = "{alias}"',
            f'base_url = "{entry["base_url"]}"',
            'env_key = "LLM_API_KEY"',
            f'wire_api = "{entry.get("wire_api", "chat")}"',
            "requires_openai_auth = false",
            "",
        ]
    )
    (home / "config.toml").write_text(config, encoding="utf-8")
    return {"CODEX_HOME": str(home), "LLM_API_KEY": key, "GH_TOKEN": GH_RO}


def read_log() -> str:
    if not LOG_PATH.exists():
        return ""
    try:
        if LOG_PATH.stat().st_size > 10_000_000:
            with open(LOG_PATH, "rb") as fh:
                fh.seek(-5_000_000, os.SEEK_END)
                return fh.read().decode("utf-8", "replace")
        return LOG_PATH.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def count_turns(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip() == "codex")


def last_exec_command(text: str) -> str:
    lines = text.splitlines()
    for index in range(len(lines) - 1, 0, -1):
        if lines[index - 1].strip() == "exec":
            return lines[index].strip()
    return ""


def stop_requested() -> bool:
    if not GH_RO:
        return False
    try:
        issue = c.request("GET", f"/repos/{REPO}/issues/{ISSUE}", GH_RO, timeout=12)
        return "bot:stop" in {item.get("name") for item in issue.get("labels", [])}
    except Exception:
        return False


def parse_tokens(text: str) -> int:
    lines = [line.strip() for line in text.splitlines()]
    for index, line in enumerate(lines):
        if line == "tokens used":
            for follow in lines[index + 1 : index + 4]:
                digits = re.sub(r"[^\d]", "", follow)
                if digits:
                    return int(digits)
    return 0


def classify_log(text: str) -> model_pool.ModelError | None:
    lowered = text.lower()
    if "401" in lowered or "unauthorized" in lowered or "invalid api key" in lowered:
        return model_pool.ModelError("auth", 401, 0, "codex log")
    if "429" in lowered or "rate limit" in lowered or "too many requests" in lowered:
        return model_pool.ModelError("rate", 429, 0, "codex log")
    if "404" in lowered or "model not found" in lowered or "does not exist" in lowered:
        return model_pool.ModelError("config", 404, 0, "codex log")
    return None


def archive_attempt(number: int) -> None:
    target = OUTPUTS / f"attempt-{number}"
    target.mkdir(parents=True, exist_ok=True)
    for path in (ANSWER_MD, ANSWER_JSON, LOG_PATH):
        if path.exists():
            path.replace(target / path.name)


def run_codex(entry: dict, key: str, deadline: float) -> dict:
    prompt = build_prompt()
    (OUTPUTS / "prompt.txt").write_text(prompt, encoding="utf-8")
    env = os.environ.copy()
    env.update(write_codex_config(entry, key))
    for name in ("GITHUB_TOKEN", "SELF_TOKEN", "GH_TOKEN"):
        env.pop(name, None)
    env["GH_TOKEN"] = GH_RO

    timeout_minutes = int(budget["l2"]["timeout_minutes"])
    threshold = int(budget["l2"].get("loop_repeat_threshold", 3))
    started = time.monotonic()
    reason = "completed"
    turns = 0

    with open(LOG_PATH, "w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen(
            ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", prompt],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            cwd=str(c.ROOT),
            start_new_session=True,
        )
        last_check = 0.0
        last_command = ""
        repeats = 0
        try:
            while proc.poll() is None:
                time.sleep(1)
                if time.monotonic() > deadline:
                    reason = f"timeout {timeout_minutes}min"
                    break
                if time.monotonic() - last_check >= 5:
                    text = read_log()
                    turns = count_turns(text)
                    command = last_exec_command(text)
                    if command and command == last_command:
                        repeats += 1
                    else:
                        repeats = 0
                        last_command = command
                    if threshold and repeats >= threshold:
                        reason = f"loop detected ({threshold}x same command)"
                        break
                    last_check = time.monotonic()
                if int(time.monotonic() - started) % 60 == 0 and stop_requested():
                    reason = "bot:stop label"
                    break
        finally:
            if proc.poll() is None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=10)

    elapsed = time.monotonic() - started
    text = read_log()
    turns = max(turns, count_turns(text))
    tokens = parse_tokens(text)
    code = proc.returncode if proc.returncode is not None else -1
    if validate_answer():
        status = "complete"
    elif ANSWER_MD.exists() and ANSWER_MD.stat().st_size > 0:
        status = "partial"
    else:
        status = "failed"
    if reason != "completed":
        status = "partial" if status in ("complete", "partial") else "failed"
    return {
        "status": status,
        "reason": reason,
        "turns": turns,
        "elapsed_sec": round(elapsed, 1),
        "tokens": tokens,
        "exit_code": code,
        "entry_id": entry["id"],
    }


def write_result(result: dict, state: dict, attempts: int) -> None:
    payload = {
        **result,
        "attempts": attempts,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    c.dump_json(RESULT_PATH, payload)
    c.dump_json(HEALTH_PATH, state)
    print(json.dumps(payload, ensure_ascii=False))


def main() -> None:
    if BOT_ENABLED == "false":
        write_result({"status": "failed", "reason": "BOT_ENABLED=false"}, {"endpoints": {}}, 0)
        return
    model_path = c.ROOT / "inputs/model.json"
    if not model_path.exists():
        write_result({"status": "failed", "reason": "inputs/model.json missing"}, {"endpoints": {}}, 0)
        return
    model = json.loads(model_path.read_text(encoding="utf-8"))
    entries = model.get("l2_entries") or []
    if not entries:
        write_result({"status": "failed", "reason": "no healthy L2 entry"}, {"endpoints": {}}, 0)
        return

    deadline = time.monotonic() + int(budget["l2"]["timeout_minutes"]) * 60
    state: dict = {"endpoints": {}}
    attempts = 0
    final: dict = {"status": "failed", "reason": "no attempt", "turns": 0, "elapsed_sec": 0, "tokens": 0, "exit_code": 0, "entry_id": ""}

    for entry in entries:
        key = model_pool.key_for(entry)
        if not key:
            model_pool.mark_failure(
                state, entry, model_pool.ModelError("auth", 0, 0, "missing key"), pool_cfg
            )
            continue
        attempts += 1
        archive_attempt(attempts)
        try:
            model_pool.preflight(entry, key, pool_cfg)
        except model_pool.ModelError as exc:
            model_pool.mark_failure(state, entry, exc, pool_cfg)
            if exc.kind in ("rate", "upstream", "network") and time.monotonic() < deadline - 120:
                wait = min(max(int(exc.retry_after or 15), 5), 60)
                time.sleep(wait)
                try:
                    model_pool.preflight(entry, key, pool_cfg)
                except model_pool.ModelError as second:
                    model_pool.mark_failure(state, entry, second, pool_cfg)
                    final = {**final, "reason": f"preflight: {second.kind}", "entry_id": entry["id"]}
                    continue
            else:
                final = {**final, "reason": f"preflight: {exc.kind}", "entry_id": entry["id"]}
                continue

        result = run_codex(entry, key, deadline)
        final = result
        if result["status"] == "complete":
            model_pool.mark_success(state, entry)
            break
        error = classify_log(read_log())
        if error:
            model_pool.mark_failure(state, entry, error, pool_cfg)
            if not bool(pool_cfg.get("l2_retry_once", True)):
                break
            if time.monotonic() > deadline - 300:
                break
            continue
        break

    write_result(final, state, attempts)


if __name__ == "__main__":
    main()
