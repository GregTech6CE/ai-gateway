"""共享模型池：endpoint 是健康单位，role 只是绑定。仅使用标准库。

- endpoint：provider + base_url + api_key_env + model，是会被 401/429 打挂的对象。
- role：共享模型池的绑定（当前为 analysis），只决定用哪个 endpoint、context、effort 与顺序。
- down/cooldown 只记在 endpoint 上；一个 endpoint 挂了，所有绑定它的 role 都不可用。
"""

from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import common as c

POOL_PATH = c.ROOT / "config/models.json"
STATE_VAR = "MODEL_HEALTH"


class ModelError(RuntimeError):
    def __init__(self, kind: str, status: int = 0, retry_after: int = 0, detail: str = ""):
        super().__init__(f"{kind} status={status} {detail}"[:300])
        self.kind = kind
        self.status = status
        self.retry_after = retry_after
        self.detail = detail


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_pool(name: str) -> dict:
    pools = c.load_json(POOL_PATH)["pools"]
    if name not in pools:
        raise SystemExit(f"unknown model pool: {name}")
    return pools[name]


def _endpoints(pool: dict) -> dict[str, dict]:
    return {
        endpoint["id"]: endpoint
        for endpoint in pool.get("endpoints", [])
        if endpoint.get("enabled", True)
    }


def bindings(pool: dict, role: str) -> list[dict]:
    """把 role 绑定与 endpoint 合并；id 保持 endpoint id，用作健康状态的 key。"""
    available = _endpoints(pool)
    result = []
    for binding in pool.get("roles", {}).get(role, []):
        endpoint = available.get(binding.get("endpoint"))
        if not endpoint:
            continue
        merged = dict(endpoint)
        merged.update({key: value for key, value in binding.items() if key != "endpoint"})
        merged["role"] = role
        result.append(merged)
    result.sort(key=lambda entry: (int(entry.get("priority", 100)), entry["id"]))
    return result


# 兼容旧调用名
def entries(pool: dict, role: str) -> list[dict]:
    return bindings(pool, role)


def read_health(token: str, repo: str) -> dict:
    if not token or not repo:
        return {}
    try:
        data = c.request("GET", f"/repos/{repo}/actions/variables/{STATE_VAR}", token)
        return json.loads(data.get("value") or "{}")
    except Exception as exc:
        if "-> 404" in str(exc):
            return {}
        print(f"读取模型健康状态失败: {exc}")
        return {}


def write_health(token: str, repo: str, state: dict) -> None:
    if not token or not repo:
        return
    body = {"name": STATE_VAR, "value": json.dumps(state, ensure_ascii=False)}
    try:
        c.request("PATCH", f"/repos/{repo}/actions/variables/{STATE_VAR}", token, body)
    except Exception as exc:
        if "-> 404" in str(exc):
            try:
                c.request("POST", f"/repos/{repo}/actions/variables", token, body)
                return
            except Exception as inner:
                print(f"创建模型健康状态失败: {inner}")
                return
        print(f"写入模型健康状态失败: {exc}")


def _endpoint_state(state: dict, endpoint_id: str) -> dict:
    return state.setdefault("endpoints", {}).setdefault(endpoint_id, {})


def is_available(entry: dict, state: dict) -> bool:
    item = _endpoint_state(state, entry["id"])
    if item.get("status") in ("cooldown", "disabled"):
        until = item.get("until")
        if until and _parse(until) > _now():
            return False
        item["status"] = "ok"
        item.pop("until", None)
    return True


def mark_success(state: dict, entry: dict) -> None:
    item = _endpoint_state(state, entry["id"])
    item.update({"status": "ok", "failures": 0, "updated_at": _iso(_now())})
    for key in ("until", "reason", "first_failure_at"):
        item.pop(key, None)


def mark_failure(state: dict, entry: dict, error: ModelError, cfg: dict) -> None:
    """只标记 endpoint；role 绑定不单独保存健康状态。"""
    item = _endpoint_state(state, entry["id"])
    first = item.get("first_failure_at")
    window = timedelta(hours=int(cfg.get("strike_window_hours", 24)))
    if not first or _now() - _parse(first) > window:
        item["failures"] = 1
        item["first_failure_at"] = _iso(_now())
    else:
        item["failures"] = int(item.get("failures", 0)) + 1
    item["reason"] = error.kind
    item["updated_at"] = _iso(_now())

    if error.kind == "auth":
        minutes = int(cfg.get("auth_cooldown_minutes", 15))
        item["status"] = "cooldown"
    elif error.kind == "rate":
        seconds = error.retry_after or int(cfg.get("rate_limit_default_minutes", 5)) * 60
        minutes = max(1, min(math.ceil(seconds / 60), int(cfg.get("rate_limit_max_minutes", 30))))
        item["status"] = "cooldown"
    elif error.kind == "config":
        minutes = int(cfg.get("config_cooldown_minutes", 60))
        item["status"] = "disabled"
    else:
        minutes = int(cfg.get("upstream_cooldown_minutes", 5))
        item["status"] = "cooldown"

    if int(item["failures"]) >= int(cfg.get("strikes", 3)):
        item["status"] = "disabled"
        minutes = int(cfg.get("strike_disable_minutes", 60))
    item["until"] = _iso(_now() + timedelta(minutes=minutes))


def key_for(entry: dict) -> str:
    return os.environ.get(entry.get("api_key_env", ""), "")


def _post(entry: dict, key: str, payload: dict, timeout: int) -> dict:
    url = entry["base_url"].rstrip("/") + "/chat/completions"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        retry_after = 0
        try:
            retry_after = int(exc.headers.get("Retry-After") or 0)
        except (TypeError, ValueError):
            retry_after = 0
        if exc.code in (401, 403):
            kind = "auth"
        elif exc.code == 429:
            kind = "rate"
        elif exc.code in (400, 404):
            kind = "config"
        else:
            kind = "upstream"
        raise ModelError(kind, exc.code, retry_after, detail) from None
    except Exception as exc:
        raise ModelError("network", 0, 0, str(exc)) from None


def chat(
    entry: dict,
    key: str,
    messages: list[dict],
    max_tokens: int = 200,
    temperature: float = 0,
    response_format: dict | None = None,
    timeout: int = 90,
) -> str:
    payload = {
        "model": entry["model"],
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if response_format:
        payload["response_format"] = response_format
    data = _post(entry, key, payload, timeout)
    return data["choices"][0]["message"]["content"]


def probe(entry: dict, key: str, cfg: dict) -> None:
    chat(
        entry,
        key,
        [{"role": "user", "content": "ping"}],
        max_tokens=int(cfg.get("analysis_probe_max_tokens", 8)),
        temperature=0,
        timeout=30,
    )


def select(pool: dict, role: str, state: dict) -> tuple[dict, str]:
    for entry in bindings(pool, role):
        if not is_available(entry, state):
            continue
        key = key_for(entry)
        if key:
            return entry, key
    raise ModelError("unavailable", 0, 0, f"no healthy entry for {role}")


def candidates(pool: dict, role: str, state: dict, require_key: bool = True) -> list[dict]:
    return [
        entry
        for entry in bindings(pool, role)
        if is_available(entry, state) and (not require_key or key_for(entry))
    ]


def failover_chat(
    pool: dict,
    role: str,
    state: dict,
    cfg: dict,
    messages: list[dict],
    **kwargs,
) -> tuple[str, dict]:
    last: ModelError | None = None
    for entry in bindings(pool, role):
        if not is_available(entry, state):
            continue
        key = key_for(entry)
        if not key:
            last = ModelError("auth", 0, 0, f"missing env {entry.get('api_key_env')}")
            mark_failure(state, entry, last, cfg)
            continue
        try:
            content = chat(entry, key, messages, **kwargs)
            mark_success(state, entry)
            return content, entry
        except ModelError as exc:
            last = exc
            mark_failure(state, entry, exc, cfg)
    raise last or ModelError("unavailable", 0, 0, f"no healthy entry for {role}")


def merge_health(token: str, repo: str, path: str | Path) -> None:
    path = Path(path)
    if not path.exists():
        return
    try:
        delta = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return
    state = read_health(token, repo)
    for endpoint_id, patch in (delta.get("endpoints") or {}).items():
        state.setdefault("endpoints", {}).setdefault(endpoint_id, {}).update(patch)
    write_health(token, repo, state)
