#!/usr/bin/env python3
"""阶段二 B：在墙钟与循环检测下运行固定版本的 Codex CLI。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402
import labels  # noqa: E402
import model_pool  # noqa: E402
import scan_out  # noqa: E402

REPO = c.env("REPO")
ISSUE = str(c.env("ISSUE"))
GH_RO = c.env("GH_RO_TOKEN", "")
BOT_ENABLED = c.env("BOT_ENABLED", "true").lower()
RERUN_PROMPT = os.environ.get("RERUN_PROMPT", "")

repo_cfg = c.load_repo(REPO)
budget = c.budgets()
pool_cfg = budget.get("model_pool", {})
OUTPUTS = c.ROOT / "outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
LOG_PATH = OUTPUTS / "agent_output.log"
BRIDGE_LOG = OUTPUTS / "bridge.log"
ANSWER_MD = OUTPUTS / "answer.md"
ANSWER_JSON = OUTPUTS / "answer.json"
RESULT_PATH = OUTPUTS / "result.json"
HEALTH_PATH = OUTPUTS / "model_health.json"
RELEVANCE_PATH = OUTPUTS / "relevance.json"
SUPERVISOR_LOG = OUTPUTS / "supervisor.log"
REQUIRED = ("issue_type", "conclusion", "confidence", "evidence", "fix_plan", "labels", "partial")
CST = timezone(timedelta(hours=8))
# 绑定未写 context 时的兜底；当前两个 endpoint 都是 1M，缺省与之一致，避免低估窗口。
DEFAULT_CONTEXT_WINDOW = 1_048_576
# Codex 可执行文件；命令行固定为 `exec --dangerously-bypass-approvals-and-sandbox <prompt>`。
# 用元组而不是字符串，避免路径含空格时的拆分问题，也便于测试整体替换成脚本。
CODEX_BIN = (os.environ.get("CODEX_BIN") or "codex",)
# 只提供 chat/completions 的 endpoint 由这个桥翻译成 Responses；见 responses_bridge.py。
BRIDGE_SCRIPT = Path(__file__).with_name("responses_bridge.py")
# 子进程不需要的 GitHub / 写回凭据；Codex 只保留 GH_RO 对应的 GH_TOKEN。
TOKEN_ENVS = (
    "GITHUB_TOKEN",
    "SELF_TOKEN",
    "GH_TOKEN",
    "GH_RO_TOKEN",
    "GH_RW_TOKEN",
    "MODEL_HEALTH_TOKEN",
)


def one_line(value) -> str:
    return " ".join(str(value or "").split())


def format_event(event: str, fields: dict) -> str:
    if event == "exec":
        cwd = one_line(fields.get("cwd", ""))
        command = one_line(fields.get("command", ""))
        return f"{cwd} $ {command}" if cwd else f"$ {command}"
    if event == "supervisor_start":
        return f"开始 supervisor：repo={fields.get('repo')} issue={fields.get('issue')} bot_enabled={fields.get('bot_enabled')} repo_enabled={fields.get('repo_enabled')}"
    if event == "analysis_entries":
        entries = ",".join(str(x) for x in (fields.get("entries") or []))
        return f"可用分析入口：pool={fields.get('pool')} count={fields.get('count')} entries={entries}"
    if event == "attempt_archive":
        return f"开始 attempt {fields.get('attempt')}：entry={fields.get('entry')}"
    if event == "stall":
        return f"停滞终止：连续 {fields.get('stall_seconds')}s 无任何输出，attempt={fields.get('attempt')}"
    if event == "codex_retry":
        return f"Codex {fields.get('kind')} 等待重试：attempt={fields.get('attempt')} entry={fields.get('entry')} retry={fields.get('retry')}/{fields.get('max_retries')} wait={fields.get('wait_sec')}s"
    if event == "codex_retry_skip":
        return f"Codex {fields.get('kind')} 跳过重试：attempt={fields.get('attempt')} entry={fields.get('entry')} wait={fields.get('wait_sec')}s remaining={fields.get('remaining_sec')}s"
    if event == "attempt_start":
        return f"开始 Codex：attempt={fields.get('attempt')} model={fields.get('model')} context={fields.get('context')} effort={fields.get('effort')} wire_api={fields.get('wire_api')} bridge={fields.get('bridge')} timeout={fields.get('timeout_minutes')}min"
    if event == "bridge_start":
        return f"协议桥已启动：entry={fields.get('entry')} port={fields.get('port')} upstream={fields.get('upstream')}"
    if event == "bridge_error":
        return f"协议桥启动失败：entry={fields.get('entry')} error={fields.get('error')}"
    if event == "codex_start":
        return f"Codex 已启动：attempt={fields.get('attempt')} pid={fields.get('pid')} prompt_chars={fields.get('prompt_chars')}"
    if event == "heartbeat":
        return f"attempt={fields.get('attempt')} elapsed={fields.get('elapsed_sec')}s turns={fields.get('turns')} exec={fields.get('exec_count')} answer_md={fields.get('answer_md_bytes')}B answer_json={fields.get('answer_json')} repeats={fields.get('repeats')}"
    if event == "loop_detected":
        return f"停止：检测到重复命令，attempt={fields.get('attempt')} repeats={fields.get('repeats')} command={fields.get('command')}"
    if event == "timeout":
        return f"停止：超时，attempt={fields.get('attempt')} elapsed={fields.get('elapsed_sec')}s"
    if event == "bot_stop":
        return f"停止：命中 bot:stop，attempt={fields.get('attempt')}"
    if event == "attempt_end":
        return f"Codex 结束：status={fields.get('status')} reason={fields.get('reason')} turns={fields.get('turns')} tokens={fields.get('tokens')} elapsed={fields.get('elapsed_sec')}s"
    if event == "entry_success":
        return f"入口成功：entry={fields.get('entry')}"
    if event == "result":
        return f"结束：status={fields.get('status')} confidence={fields.get('confidence') or 'unknown'} reason={fields.get('reason')} turns={fields.get('turns')} tokens={fields.get('tokens')} elapsed={fields.get('elapsed_sec')}s"
    if event == "relevance":
        return f"相关性分类：category={fields.get('category')} confidence={fields.get('confidence')} reason={fields.get('reason')}"
    if event == "relevance_rejected":
        return f"相关性拒绝：category={fields.get('category')} confidence={fields.get('confidence')}"
    if event == "preflight_ok":
        return f"preflight 通过：entry={fields.get('entry')} 耗时={fields.get('elapsed_ms')}ms"
    if event == "preflight_error":
        return f"preflight 失败，换下一个入口：entry={fields.get('entry')} kind={fields.get('kind')} status={fields.get('status')}"
    if event == "preflight_unparsed":
        return f"preflight 有响应但分类不可解析：entry={fields.get('entry')} error={fields.get('error') or '-'}"
    if event == "entry_unusable":
        return f"入口不可用，换下一个：entry={fields.get('entry')} kind={fields.get('kind')}"
    if event == "missing_api_key":
        return f"缺少 API key：entry={fields.get('entry')} env={fields.get('api_key_env')}"
    if event == "codex_error":
        return f"Codex 错误：entry={fields.get('entry')} kind={fields.get('kind')} status={fields.get('status')}"
    return one_line(" ".join(f"{key}={value}" for key, value in fields.items()))


def scrub(text: str) -> str:
    """日志行在写出前就地脱敏，命中片段替换为占位符，其余内容保留。"""
    return scan_out.redact(text, secret_values())


def log_event(event: str, message: str | None = None, **fields) -> None:
    kind = (
        "MSG"
        if event == "assistant"
        else "BASH"
        if event == "exec"
        else "HEARTBEAT"
        if event == "heartbeat"
        else "SYSTEM"
    )
    if message is None:
        message = format_event(event, fields)
    line = f"[{datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')}] [{kind}] {scrub(one_line(message))}"
    with open(SUPERVISOR_LOG, "a", encoding="utf-8", newline="\n") as fh:
        fh.write(line + "\n")
    print(line, flush=True)


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
    if not labels.is_valid_type(data.get("issue_type"), repo_cfg):
        return False
    if data.get("confidence") not in ("high", "medium", "low"):
        return False
    if not isinstance(data.get("evidence"), list) or not isinstance(data.get("fix_plan"), list):
        return False
    if not isinstance(data.get("conclusion"), str) or len(data["conclusion"].strip()) < 10:
        return False
    return True


def prompt_text(kind: str) -> str:
    common_path = c.ROOT / "prompts" / "common" / f"{kind}.md"
    base = common_path.read_text(encoding="utf-8").rstrip()
    profile = str(repo_cfg.get("prompt_profile") or "").strip().lower()
    if not profile:
        return base
    if not re.fullmatch(r"[a-z0-9_-]+", profile):
        raise SystemExit(f"invalid prompt_profile: {profile}")
    overlay_path = c.ROOT / "prompts" / "repos" / profile / f"{kind}.md"
    if overlay_path.exists():
        overlay = overlay_path.read_text(encoding="utf-8").strip()
        return f"{base}\n\n## 仓库特定规则（优先于 common）\n\n{overlay}\n"
    return base


def build_prompt() -> str:
    if RERUN_PROMPT:
        return RERUN_PROMPT
    skill = prompt_text("analyze")
    nodes = prompt_text("nodes")
    return (
        f"{skill}\n\n{nodes}\n\n"
        f"目标 issue：{REPO}#{ISSUE}\n"
        "工作目录：inputs/、code/、outputs/。只读 inputs/ 与 code/，只写 outputs/。\n"
        "code/current 指向报告里的版本；若存在 code/golden，它是上游原版 GT6 的固定提交，"
        "即参照实现基准，用于判断某个行为是移植偏差还是上游本就如此。\n"
    )


def write_codex_config(entry: dict, key: str, bridge_base_url: str | None = None) -> dict[str, str]:
    alias = re.sub(r"[^A-Za-z0-9_]", "_", entry.get("provider_alias") or entry["id"])
    home = c.ROOT / ".codex"
    home.mkdir(exist_ok=True)
    base_url = bridge_base_url or entry["base_url"]
    wire_api = "responses" if bridge_base_url else entry.get("wire_api", "responses")
    config = "\n".join(
        [
            f'model = "{entry["model"]}"',
            f'model_provider = "{alias}"',
            f'model_context_window = {int(entry.get("context") or DEFAULT_CONTEXT_WINDOW)}',
            f'model_reasoning_effort = "{entry.get("effort", "")}"',
            'approval_policy = "never"',
            'sandbox_mode = "danger-full-access"',
            'web_search = "disabled"',
            "",
            f"[model_providers.{alias}]",
            f'name = "{alias}"',
            f'base_url = "{base_url}"',
            'env_key = "LLM_API_KEY"',
            f'wire_api = "{wire_api}"',
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


def exec_blocks(text: str) -> list[tuple[str, str, str]]:
    """解析全部 BASH 调用，返回 ``(command, cwd, output)``。

    Codex 的人类可读输出格式是 ``exec`` 后跟 ``command in cwd``；只认带 `` in `` 的
    行，避免把 assistant 文本里单独出现的 ``exec`` 当成命令。一次轮询可能跨过多个调用，
    因此必须按顺序全部返回，不能只看最后一个。
    """
    lines = text.splitlines()
    boundaries = ("exec", "codex", "apply patch", "tokens used")
    blocks: list[tuple[str, str, str]] = []
    index = 0
    while index < len(lines) - 1:
        if lines[index].strip() != "exec":
            index += 1
            continue
        line = lines[index + 1].strip()
        command, separator, cwd = line.rpartition(" in ")
        if not separator or not cwd:
            index += 1
            continue
        output: list[str] = []
        cursor = index + 2
        while cursor < len(lines) and lines[cursor].strip() not in boundaries:
            output.append(lines[cursor])
            cursor += 1
        blocks.append((command.strip(), cwd.strip(), "\n".join(output).strip()))
        index = cursor
    return blocks


def last_exec_command(text: str) -> tuple[str, str]:
    blocks = exec_blocks(text)
    return (blocks[-1][0], blocks[-1][1]) if blocks else ("", "")


def count_exec(text: str) -> int:
    return len(exec_blocks(text))


def answer_progress() -> tuple[int, int]:
    """用大小与 mtime 判断 ``answer.md`` 是否真的写过；只看大小会漏掉等长改写。"""
    if not ANSWER_MD.exists():
        return (0, 0)
    try:
        stat = ANSWER_MD.stat()
    except OSError:
        return (0, 0)
    return (stat.st_size, stat.st_mtime_ns)


def assistant_blocks(text: str, include_last: bool = False) -> list[str]:
    lines = text.splitlines()
    blocks: list[str] = []
    index = 0
    boundaries = ("exec", "apply patch", "tokens used", "codex")
    while index < len(lines):
        if lines[index].strip() != "codex":
            index += 1
            continue
        cursor = index + 1
        buffer: list[str] = []
        while cursor < len(lines) and lines[cursor].strip() not in boundaries:
            buffer.append(lines[cursor])
            cursor += 1
        finished = cursor < len(lines)
        if buffer and (finished or include_last):
            block = "\n".join(buffer).strip()
            if block:
                blocks.append(block)
        index = cursor if finished else len(lines)
    return blocks


def emit_assistant(block: str) -> None:
    """assistant 文本交给 log_event 统一脱敏，不在这里另做判断。"""
    log_event("assistant", message=block)


def relevance_text() -> str:
    path = c.ROOT / "inputs/snapshot.json"
    if not path.exists():
        return ""
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    issue = snap.get("issue") or {}
    parts = [
        f"标题：{issue.get('title', '')}",
        f"标签：{', '.join(issue.get('labels') or [])}",
        f"正文：\n{issue.get('body') or ''}",
    ]
    comments = snap.get("comments") or []
    if comments:
        parts.append("评论：\n" + "\n".join(
            f"- {(item.get('body') or '')[:2000]}" for item in comments[:10]
        ))
    attachments = snap.get("attachments") or []
    if attachments:
        parts.append("附件：\n" + "\n".join(f"- {url}" for url in attachments[:20]))
    return "\n\n".join(parts)[:12000]


def classify_relevance(entry: dict, key: str) -> dict | None:
    """preflight 轮：一次 JSON 调用同时完成相关性分类与入口可用性判定。

    传输层失败以 `ModelError` 抛出，由调用方计罚并换下一个入口；回答无法解析或类别非法
    只说明这次分类没给出结论，请求本身已经成功，按"入口可用、无分类结论"处理。
    """
    if not key:
        return None
    prompt = prompt_text("relevance")
    text = relevance_text()
    if not text:
        return None
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": text},
    ]
    content = model_pool.chat(
        entry,
        key,
        messages,
        max_tokens=int(budget["relevance"].get("max_tokens", 400)),
        temperature=0,
        response_format={"type": "json_object"},
        timeout=int(budget["relevance"].get("timeout_seconds", 90)),
    )
    try:
        match = re.search(r"\{.*\}", content or "", re.S)
        data = json.loads(match.group(0) if match else (content or "{}"))
        category = str(data.get("relevance", "")).lower()
        if category not in ("in_scope", "spam", "out_of_scope"):
            log_event("preflight_unparsed", entry=entry["id"])
            return None
        try:
            confidence = min(max(float(data.get("confidence", 0)), 0.0), 1.0)
        except (TypeError, ValueError):
            confidence = 0.0
        return {
            "relevance": category,
            "confidence": confidence,
            "reason": str(data.get("reason") or "")[:800],
            "evidence": [str(item)[:500] for item in (data.get("evidence") or [])][:10],
            "entry_id": entry["id"],
            "classified_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        log_event("preflight_unparsed", entry=entry["id"], error=f"{type(exc).__name__}"[:80])
        return None


def stop_requested() -> bool:
    try:
        issue = c.request("GET", f"/repos/{REPO}/issues/{ISSUE}", "", timeout=12)
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


def parse_retry_after(text: str) -> int:
    patterns = (
        r"retry[-_ ]?after[\"']?\s*[:=]\s*(\d+)",
        r"(?:try again|retry) in\s+(\d+)\s*(?:s|sec|seconds?)",
        r"after\s+(\d+)\s*(?:s|sec|seconds?)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                pass
    return 0


def rate_wait_seconds(error: model_pool.ModelError, cfg: dict) -> int:
    wait = int(error.retry_after or cfg.get("rate_limit_wait_seconds", 60))
    wait = max(wait, int(cfg.get("rate_limit_min_wait_seconds", 5)))
    return min(wait, int(cfg.get("rate_limit_max_wait_seconds", 300)))


def failure_reason(error: model_pool.ModelError, retries: int) -> str:
    status = f" {error.status}" if error.status else ""
    suffix = f" after {retries} retries" if retries else ""
    return f"{error.kind}{status}{suffix}"


def classify_log(text: str) -> model_pool.ModelError | None:
    error_lines = []
    for line in text.splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        if not lowered.startswith(("error", "failed", "http")):
            continue
        if any(marker in lowered for marker in ("error", "failed", "http", "unauthorized", "invalid api key", "rate limit", "too many requests", "model not found", "does not exist")):
            error_lines.append(lowered)
    if not error_lines:
        return None
    joined = "\n".join(error_lines)
    # 配置层错误发生在会话建立之前，CLI 会直接退出且不产生任何事件；归为 config 让上层
    # 换一个入口，而不是把它当成上游故障。
    if "error loading config.toml" in joined or "no longer supported" in joined:
        return model_pool.ModelError("config", 0, 0, "codex config rejected")
    if "401" in joined or "unauthorized" in joined or "invalid api key" in joined:
        return model_pool.ModelError("auth", 401, 0, "codex log")
    if "429" in joined or "rate limit" in joined or "too many requests" in joined:
        return model_pool.ModelError("rate", 429, parse_retry_after(text), "codex log")
    if "404" in joined or "model not found" in joined or "does not exist" in joined:
        return model_pool.ModelError("config", 404, 0, "codex log")
    if any(
        marker in joined
        for marker in ("timeout", "timed out", "connection reset", "connection refused", "http 5", " 500", " 502", " 503", " 504")
    ):
        return model_pool.ModelError("upstream", 0, parse_retry_after(text), "codex log")
    return None


def archive_attempt(number: int) -> None:
    target = OUTPUTS / f"attempt-{number}"
    target.mkdir(parents=True, exist_ok=True)
    for path in (ANSWER_MD, ANSWER_JSON, LOG_PATH, BRIDGE_LOG):
        if path.exists():
            path.replace(target / path.name)


def terminate_tree(proc: subprocess.Popen, hard: bool = False) -> None:
    """按进程组终止子进程；Windows 没有进程组信号，退回 terminate/kill。

    托管 runner 是 Linux，走 `killpg` 分支，行为与原先一致；本地 Windows 调试不再因为
    `os.getpgid` 不存在而抛 AttributeError。
    """
    if hasattr(os, "killpg"):
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL if hard else signal.SIGTERM)
        except ProcessLookupError:
            pass
        return
    try:
        proc.kill() if hard else proc.terminate()
    except OSError:
        pass


class BridgeProcess:
    """Responses→Chat 协议桥的句柄；run_codex 结束时必须 stop。"""

    def __init__(self, process: subprocess.Popen, port: int):
        self.process = process
        self.port = port

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


def start_bridge(entry: dict) -> BridgeProcess:
    """启动本地协议桥，返回句柄；启动失败抛 RuntimeError。

    端口由父进程先绑定一次 0 号端口取得，再交给子进程；CI runner 内不存在并发抢端口
    的竞争者，这个先取后放的窗口足够小。健康检查通过才算就绪。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])

    command = [
        sys.executable,
        "-I",
        str(BRIDGE_SCRIPT),
        "--port",
        str(port),
        "--upstream",
        entry["base_url"],
        "--model",
        entry["model"],
        "--api-key-env",
        entry.get("api_key_env", ""),
        "--timeout",
        str(int(entry.get("bridge_timeout_seconds", 600))),
    ]
    for name, value in (entry.get("headers") or {}).items():
        command.extend(["--header", f"{name}: {value}"])

    log = open(BRIDGE_LOG, "a", encoding="utf-8", errors="replace")
    bridge_env = os.environ.copy()
    for name in TOKEN_ENVS:
        bridge_env.pop(name, None)
    keep_key = entry.get("api_key_env", "")
    for name in list(bridge_env):
        if name.startswith("MODEL_KEY_") and name != keep_key:
            bridge_env.pop(name, None)
    try:
        process = subprocess.Popen(
            command,
            stdout=log,
            stderr=subprocess.STDOUT,
            env=bridge_env,
            cwd=str(c.ROOT),
            start_new_session=True,
        )
    finally:
        log.close()

    bridge = BridgeProcess(process, port)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"bridge exited with {process.returncode}")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                if response.status == 200:
                    return bridge
        except Exception:
            time.sleep(0.2)
    bridge.stop()
    raise RuntimeError("bridge did not become ready")


def run_codex(entry: dict, key: str, deadline: float, attempt: int) -> dict:
    """启动协议桥（如需要），运行 body，最后保证桥被终止。"""
    bridge: BridgeProcess | None = None
    if entry.get("codex_bridge"):
        try:
            bridge = start_bridge(entry)
        except Exception as exc:
            log_event(
                "bridge_error",
                entry=entry["id"],
                error=f"{type(exc).__name__}: {exc}"[:200],
            )
            return {
                "status": "failed",
                "reason": "bridge start failed",
                "turns": 0,
                "elapsed_sec": 0,
                "tokens": 0,
                "exit_code": -1,
                "entry_id": entry["id"],
                "answer_md_bytes": 0,
                "answer_json": False,
            }
        log_event(
            "bridge_start",
            entry=entry["id"],
            port=bridge.port,
            upstream=entry["base_url"],
        )
    try:
        return _run_codex_body(entry, key, deadline, attempt, bridge)
    finally:
        if bridge:
            bridge.stop()


def _run_codex_body(
    entry: dict,
    key: str,
    deadline: float,
    attempt: int,
    bridge: BridgeProcess | None,
) -> dict:
    prompt = build_prompt()
    (OUTPUTS / "prompt.txt").write_text(prompt, encoding="utf-8")
    env = os.environ.copy()
    env.update(write_codex_config(entry, key, bridge.base_url if bridge else None))
    for name in TOKEN_ENVS:
        env.pop(name, None)
    env["GH_TOKEN"] = GH_RO

    timeout_minutes = int(budget["l2"]["timeout_minutes"])
    stall_seconds = int(budget["l2"].get("stall_seconds", 180))
    threshold = int(budget["l2"].get("loop_repeat_threshold", 3))
    started = time.monotonic()
    reason = "completed"
    turns = 0
    log_event(
        "attempt_start",
        attempt=attempt,
        entry=entry["id"],
        model=entry["model"],
        context=entry.get("context"),
        effort=entry.get("effort"),
        wire_api=entry.get("wire_api"),
        bridge=bool(entry.get("codex_bridge")),
        timeout_minutes=timeout_minutes,
        loop_threshold=threshold,
    )

    with open(LOG_PATH, "w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen(
            [*CODEX_BIN, "exec", "--dangerously-bypass-approvals-and-sandbox", prompt],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            cwd=str(c.ROOT),
            start_new_session=True,
        )
        log_event("codex_start", attempt=attempt, pid=proc.pid, prompt_chars=len(prompt))
        last_check = 0.0
        last_heartbeat = 0.0
        seen_exec = 0
        last_started_command = ""
        last_signature = ("", "")
        last_progress = (-1, -1)
        repeats = 0
        seen_assistant = 0
        last_growth_at = started
        last_log_size = -1
        try:
            while proc.poll() is None:
                time.sleep(1)
                if time.monotonic() > deadline:
                    reason = f"timeout {timeout_minutes}min"
                    log_event("timeout", attempt=attempt, elapsed_sec=round(time.monotonic() - started, 1))
                    break
                if time.monotonic() - last_growth_at > stall_seconds:
                    # 只看"是否还有输出"，不看它是第几轮：入口可用性已由 preflight 判定，
                    # 这里只负责不让一次挂死吃掉整个 job 预算。
                    reason = f"no output for {stall_seconds}s"
                    log_event(
                        "stall",
                        attempt=attempt,
                        entry=entry["id"],
                        stall_seconds=stall_seconds,
                    )
                    break
                if time.monotonic() - last_check >= 5:
                    text = read_log()
                    turns = count_turns(text)
                    calls = exec_blocks(text)
                    execs = len(calls)
                    blocks = assistant_blocks(text)
                    for block in blocks[seen_assistant:]:
                        emit_assistant(block)
                    if len(blocks) > seen_assistant:
                        seen_assistant = len(blocks)
                    try:
                        log_size = LOG_PATH.stat().st_size
                    except OSError:
                        log_size = last_log_size
                    if log_size != last_log_size:
                        last_log_size = log_size
                        last_growth_at = time.monotonic()
                    progress = answer_progress()
                    answer_size = progress[0]
                    for command, cwd, output in calls[seen_exec:]:
                        signature = (
                            command,
                            hashlib.sha256(output.encode("utf-8")).hexdigest(),
                        )
                        if command and signature == last_signature and progress == last_progress:
                            repeats += 1
                        else:
                            repeats = 0
                        last_started_command = command
                        last_signature = signature
                        last_progress = progress
                        log_event(
                            "exec",
                            attempt=attempt,
                            exec_count=execs,
                            repeats=repeats,
                            answer_md_bytes=answer_size,
                            cwd=cwd,
                            command=command[:240],
                        )
                    seen_exec = execs
                    if threshold and repeats >= threshold:
                        reason = f"loop detected ({threshold}x same command without progress)"
                        log_event(
                            "loop_detected",
                            attempt=attempt,
                            repeats=repeats,
                            command=last_started_command[:240],
                        )
                        break
                    if time.monotonic() - last_heartbeat >= 30:
                        log_event(
                            "heartbeat",
                            attempt=attempt,
                            elapsed_sec=round(time.monotonic() - started, 1),
                            turns=turns,
                            exec_count=execs,
                            answer_md_bytes=answer_size,
                            answer_json=ANSWER_JSON.exists(),
                            repeats=repeats,
                        )
                        last_heartbeat = time.monotonic()
                    last_check = time.monotonic()
                if int(time.monotonic() - started) % 60 == 0 and stop_requested():
                    reason = "bot:stop label"
                    log_event("bot_stop", attempt=attempt)
                    break
        finally:
            if proc.poll() is None:
                terminate_tree(proc)
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    terminate_tree(proc, hard=True)
                    proc.wait(timeout=10)

    elapsed = time.monotonic() - started
    text = read_log()
    blocks = assistant_blocks(text, include_last=True)
    for block in blocks[seen_assistant:]:
        emit_assistant(block)
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
    elif status == "failed":
        reason = f"codex exit {code}" if code else "no valid answer"
    elif status == "partial":
        reason = "incomplete answer"
    result = {
        "status": status,
        "reason": reason,
        "turns": turns,
        "elapsed_sec": round(elapsed, 1),
        "tokens": tokens,
        "exit_code": code,
        "entry_id": entry["id"],
        "answer_md_bytes": ANSWER_MD.stat().st_size if ANSWER_MD.exists() else 0,
        "answer_json": ANSWER_JSON.exists(),
    }
    return result


SECRET_ENVS = ("MODEL_KEY_MISTRAL", "MODEL_KEY_CLINEPASS")
MAX_SCAN_BYTES = 16_000_000


def secret_values() -> list[str]:
    return [value for name in SECRET_ENVS if (value := os.environ.get(name, ""))]


def scan_file(path: Path, secrets: list[str]) -> bool:
    """整体扫描并就地脱敏单个文件，返回是否命中。

    不做分块：模式与私钥块都可能跨行，分块会把它们切断后漏检。文件超过上限时只保留可
    扫描的前段，其余连同被切断的半行一起丢弃——未扫描的内容不进 artifact。读取或改写
    失败抛出 OSError，由调用方按扫描失败处理。
    """
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        text = fh.read(MAX_SCAN_BYTES)
        oversized = bool(fh.read(1))
    hits = scan_out.scan_text(text, secrets)
    if not hits and not oversized:
        return False
    if oversized:
        cut = text.rfind("\n")
        text = text[: cut + 1] if cut >= 0 else ""
    cleaned = scan_out.redact(text, secrets)
    if oversized:
        cleaned = cleaned.rstrip("\n") + "\n[内容超过扫描上限，其余部分已丢弃]\n"
    tmp = path.with_suffix(path.suffix + ".scan")
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(cleaned)
        tmp.replace(path)
    finally:
        if tmp.exists():
            tmp.unlink()
    return bool(hits)


def discard(path: Path) -> None:
    """扫描失败的文件尽量清空，退而删除；成败不影响上传闸门。"""
    try:
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write("[内容未能扫描，已丢弃]\n")
        return
    except OSError:
        pass
    try:
        path.unlink()
    except OSError:
        pass


def scan_outputs() -> dict:
    """递归扫描 outputs/ 下的文本产物，命中即就地脱敏。

    result.json 被排除在文件扫描之外：它由 write_result 在序列化后扫描，否则扫描结论
    写入自身会形成循环。按 attempt 归档的历史副本同样在扫描范围内。扫描失败的文件记入
    failed，上传闸门据此关闭产物目录。
    """
    secrets = secret_values()
    hits: list[str] = []
    failed: list[str] = []
    for path in sorted(OUTPUTS.rglob("*")):
        if not path.is_file() or path.name == RESULT_PATH.name:
            continue
        relative = path.relative_to(OUTPUTS).as_posix()
        try:
            if scan_file(path, secrets):
                hits.append(relative)
        except OSError:
            hits.append(f"{relative}（扫描失败）")
            failed.append(relative)
            discard(path)
    return {"ok": not hits, "hits": hits, "failed": failed}


def merge_secret_scan(previous, current: dict) -> dict:
    previous = previous if isinstance(previous, dict) else {}
    hits = list(dict.fromkeys([*(previous.get("hits") or []), *(current.get("hits") or [])]))
    failed = list(dict.fromkeys([*(previous.get("failed") or []), *(current.get("failed") or [])]))
    ok = previous.get("ok") is not False and current.get("ok") is not False and not hits
    return {"ok": ok, "hits": hits, "failed": failed}


def scan_payload(payload: dict) -> dict:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    hits = scan_out.scan_text(text, secret_values())
    return {"ok": not hits, "hits": ["result.json"] if hits else [], "failed": []}


def loggable(payload: dict) -> dict:
    """只保留可写进日志的字段；reason 先脱敏再落盘。"""
    keys = ("status", "confidence", "reason", "turns", "tokens", "elapsed_sec", "attempts", "secret_scan")
    safe = {key: payload[key] for key in keys if key in payload}
    reason = str(safe.get("reason") or "")
    if reason:
        safe["reason"] = scan_out.redact(reason, secret_values())
    return safe


def write_result(result: dict, state: dict, attempts: int) -> None:
    payload = {
        **result,
        "attempts": attempts,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    if "confidence" not in payload:
        confidence = ""
        if ANSWER_JSON.exists():
            try:
                confidence = str(json.loads(ANSWER_JSON.read_text(encoding="utf-8")).get("confidence") or "")
            except Exception:
                confidence = ""
        payload["confidence"] = confidence
    if "secret_scan" not in payload:
        payload["secret_scan"] = scan_outputs()
    payload["secret_scan"] = merge_secret_scan(
        payload.get("secret_scan"), scan_payload({**payload, "secret_scan": None})
    )
    text = scan_out.redact(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", secret_values())
    RESULT_PATH.write_text(text, encoding="utf-8")
    c.dump_json(HEALTH_PATH, state)
    # 上传闸门：任一文件扫描失败都不上传产物目录，只留 result.json 报告。
    c.set_output("scan_upload", "false" if payload["secret_scan"].get("failed") else "true")
    log_event("result", **loggable(payload))


def main() -> None:
    log_event(
        "supervisor_start",
        repo=REPO,
        issue=ISSUE,
        bot_enabled=BOT_ENABLED,
        repo_enabled=bool(repo_cfg.get("enabled")),
    )
    if BOT_ENABLED == "false":
        write_result({"status": "failed", "reason": "BOT_ENABLED=false"}, {"endpoints": {}}, 0)
        return
    if not repo_cfg.get("enabled"):
        write_result({"status": "failed", "reason": "repo disabled"}, {"endpoints": {}}, 0)
        return
    model_path = c.ROOT / "inputs/model.json"
    if not model_path.exists():
        write_result({"status": "failed", "reason": "inputs/model.json missing"}, {"endpoints": {}}, 0)
        sys.exit(1)
    model = json.loads(model_path.read_text(encoding="utf-8"))
    entries = model.get("analysis_entries") or []
    log_event("analysis_entries", pool=model.get("pool"), count=len(entries), entries=[item.get("id") for item in entries])
    if not entries:
        write_result({"status": "failed", "reason": "no healthy L2 entry"}, {"endpoints": {}}, 0)
        sys.exit(1)

    log_event(
        "selected_entry",
        entry=entries[0]["id"],
        candidates=[item.get("id") for item in entries],
    )
    deadline = time.monotonic() + int(budget["l2"]["timeout_minutes"]) * 60
    state: dict = model_pool.read_health_file(c.ROOT / "inputs/model_health.json")
    attempts = 0
    final: dict = {"status": "failed", "reason": "no attempt", "turns": 0, "elapsed_sec": 0, "tokens": 0, "exit_code": 0, "entry_id": ""}

    # preflight 轮：用相关性分类的调用判定入口可用性。它是纯 HTTP 调用、没有工具，判定发生
    # 在任何 agent 代码执行之前；成功即锁定该入口，失败按探测规则计罚并换下一个候选。
    chosen: dict | None = None
    relevance: dict | None = None
    for entry in entries:
        key = model_pool.key_for(entry)
        if not key:
            log_event("missing_api_key", entry=entry["id"], api_key_env=entry.get("api_key_env"))
            model_pool.mark_failure(
                state, entry, model_pool.ModelError("auth", 0, 0, "missing key"), pool_cfg
            )
            continue
        preflight_started = time.monotonic()
        try:
            relevance = classify_relevance(entry, key)
        except model_pool.ModelError as exc:
            log_event(
                "preflight_error",
                entry=entry["id"],
                kind=exc.kind,
                status=exc.status,
            )
            model_pool.mark_failure(state, entry, exc, pool_cfg)
            relevance = None
            continue
        model_pool.mark_used(state, entry)
        log_event(
            "preflight_ok",
            entry=entry["id"],
            elapsed_ms=round((time.monotonic() - preflight_started) * 1000),
        )
        chosen = entry
        break

    if chosen is None:
        final["reason"] = "no endpoint passed preflight"
        final["secret_scan"] = scan_outputs()
        write_result(final, state, attempts)
        sys.exit(1)

    if relevance:
        c.dump_json(RELEVANCE_PATH, relevance)
        log_event(
            "relevance",
            category=relevance["relevance"],
            confidence=relevance["confidence"],
            reason=relevance["reason"],
            entry=relevance["entry_id"],
        )
        reject_cfg = repo_cfg.get("reject", {})
        only = {str(item).lower() for item in reject_cfg.get("only", ["spam", "out_of_scope"])}
        min_confidence = float(reject_cfg.get("min_confidence", 0.9))
        if relevance["relevance"] in only and relevance["confidence"] >= min_confidence:
            log_event(
                "relevance_rejected",
                category=relevance["relevance"],
                confidence=relevance["confidence"],
            )
            write_result(
                {
                    "status": "rejected",
                    "reason": f"relevance {relevance['relevance']} confidence={relevance['confidence']:.2f}",
                    "turns": 0,
                    "elapsed_sec": 0,
                    "tokens": 0,
                    "exit_code": 0,
                    "entry_id": relevance["entry_id"],
                    "relevance": relevance["relevance"],
                    "confidence": relevance["confidence"],
                },
                state,
                0,
            )
            return

    # 入口已确定：此后的失败只在该入口上按退避重试。确定性错误（auth/config）说明这个入口
    # 在当前 CLI 下根本不可用，才继续沿候选序换人。
    max_retries = int(pool_cfg.get("rate_limit_retries", 5))
    for entry in entries[entries.index(chosen):]:
        key = model_pool.key_for(entry)
        if not key:
            continue
        retries = 0
        switch = False
        while True:
            attempts += 1
            model_pool.mark_used(state, entry)
            archive_attempt(attempts)
            log_event("attempt_archive", attempt=attempts, entry=entry["id"])
            result = run_codex(entry, key, deadline, attempts)
            final = result
            if result["status"] == "complete":
                model_pool.mark_success(state, entry)
                break

            error = classify_log(read_log())
            if not error:
                break
            log_event(
                "codex_error",
                attempt=attempts,
                entry=entry["id"],
                kind=error.kind,
                status=error.status,
            )
            model_pool.mark_failure(state, entry, error, pool_cfg)
            final = {**final, "reason": failure_reason(error, retries)}
            if error.kind in ("auth", "config"):
                log_event("entry_unusable", attempt=attempts, entry=entry["id"], kind=error.kind)
                switch = True
                break
            if error.kind in ("rate", "upstream", "network") and retries < max_retries:
                wait = rate_wait_seconds(error, pool_cfg)
                remaining = deadline - time.monotonic()
                if remaining > wait + 120:
                    retries += 1
                    log_event(
                        "codex_retry",
                        attempt=attempts,
                        entry=entry["id"],
                        kind=error.kind,
                        retry=retries,
                        max_retries=max_retries,
                        wait_sec=wait,
                    )
                    time.sleep(wait)
                    continue
                log_event(
                    "codex_retry_skip",
                    attempt=attempts,
                    entry=entry["id"],
                    kind=error.kind,
                    wait_sec=wait,
                    remaining_sec=round(remaining),
                )
            break

        if final.get("status") == "complete" or not switch:
            break

    final["secret_scan"] = scan_outputs()
    write_result(final, state, attempts)
    if final.get("status") == "failed":
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        log_event("supervisor_crash", error=f"{type(exc).__name__}: {exc}"[:300])
        write_result(
            {
                "status": "failed",
                "reason": f"supervisor error: {type(exc).__name__}: {exc}"[:200],
                "turns": 0,
                "elapsed_sec": 0,
                "tokens": 0,
                "exit_code": -1,
                "entry_id": "",
                "secret_scan": scan_outputs(),
            },
            {},
            0,
        )
        sys.exit(1)
