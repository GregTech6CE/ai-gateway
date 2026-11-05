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

TENANT_ID = c.env("TENANT")
REPO = c.env("REPO")
ISSUE = str(c.env("ISSUE"))
GH_RO = c.env("GH_RO_TOKEN", "")
LLM_KEY = c.env("LLM_KEY", "")
LLM_BASE = c.env("LLM_BASE_URL", "")
BOT_ENABLED = c.env("BOT_ENABLED", "true").lower()
RERUN_PROMPT = os.environ.get("RERUN_PROMPT", "")

tenant = c.load_tenant(TENANT_ID)
budget = c.budgets()
OUTPUTS = c.ROOT / "outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
LOG_PATH = OUTPUTS / "agent_output.log"
ANSWER_MD = OUTPUTS / "answer.md"
ANSWER_JSON = OUTPUTS / "answer.json"
RESULT_PATH = OUTPUTS / "result.json"

REQUIRED = ("issue_type", "conclusion", "confidence", "evidence", "fix_plan", "labels", "partial")


def write_result(status: str, reason: str, turns: int, elapsed: float, tokens: int, code: int) -> None:
    c.dump_json(
        RESULT_PATH,
        {
            "status": status,
            "reason": reason,
            "turns": turns,
            "elapsed_sec": round(elapsed, 1),
            "tokens": tokens,
            "exit_code": code,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        },
    )


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


def build_command(prompt: str) -> list[str]:
    return ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", prompt]


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


def write_codex_config() -> dict[str, str]:
    llm = tenant["llm"]
    alias = llm.get("provider_alias", "agg")
    home = c.ROOT / ".codex"
    home.mkdir(exist_ok=True)
    config = "\n".join(
        [
            f'model = "{llm["l2_model"]}"',
            f'model_provider = "{alias}"',
            f'model_context_window = {int(llm.get("l2_context", 1000000))}',
            f'model_reasoning_effort = "{llm.get("l2_effort", "high")}"',
            'approval_policy = "never"',
            'sandbox_mode = "danger-full-access"',
            "",
            f"[model_providers.{alias}]",
            f'name = "{alias}"',
            f'base_url = "{LLM_BASE}"',
            'env_key = "LLM_API_KEY"',
            f'wire_api = "{llm.get("wire_api", "chat")}"',
            "requires_openai_auth = false",
            "",
        ]
    )
    (home / "config.toml").write_text(config, encoding="utf-8")
    return {"CODEX_HOME": str(home), "LLM_API_KEY": LLM_KEY, "GH_TOKEN": GH_RO}


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
        labels = {item.get("name") for item in issue.get("labels", [])}
        return "bot:stop" in labels
    except Exception:
        return False


def parse_tokens(text: str) -> int:
    lines = [line.strip() for line in text.splitlines()]
    for index, line in enumerate(lines):
        if line == "tokens used":
            for follow in lines[index + 1 : index + 4]:
                cleaned = re.sub(r"[^\d]", "", follow)
                if cleaned:
                    return int(cleaned)
    return 0


def main() -> None:
    if BOT_ENABLED == "false":
        write_result("failed", "BOT_ENABLED=false", 0, 0.0, 0, 0)
        return
    if not LLM_KEY or not LLM_BASE:
        write_result("failed", "LLM key or base url missing", 0, 0.0, 0, 0)
        return

    prompt = build_prompt()
    (OUTPUTS / "prompt.txt").write_text(prompt, encoding="utf-8")
    env = os.environ.copy()
    env.update(write_codex_config())
    env.pop("GITHUB_TOKEN", None)

    timeout = int(budget["l2"]["timeout_minutes"]) * 60
    threshold = int(budget["l2"].get("loop_repeat_threshold", 3))
    started = time.monotonic()
    turns = 0
    reason = "completed"

    with open(LOG_PATH, "w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen(
            build_command(prompt),
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
                elapsed = time.monotonic() - started
                if elapsed > timeout:
                    reason = f"timeout {timeout // 60}min"
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
                if int(elapsed) % 60 == 0 and stop_requested():
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
    write_result(status, reason, turns, elapsed, tokens, code)
    print(json.dumps(json.loads(RESULT_PATH.read_text(encoding="utf-8")), ensure_ascii=False))


if __name__ == "__main__":
    main()
