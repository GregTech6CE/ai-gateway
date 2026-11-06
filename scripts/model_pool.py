"""共享模型池：endpoint 是健康单位，role 只是绑定。仅使用标准库。

- endpoint：provider + base_url + api_key_env + model，是会被 401/429 打挂的对象。
- role：共享模型池的绑定（当前为 analysis），只决定用哪个 endpoint、context、effort 与权重。
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
# 待机时长上限：超过一个月按一个月计，从未使用过的取同值。没有上限时，一条陈旧或
# 被清空的时间戳会让该 endpoint 永久占据首位。
MAX_IDLE_SECONDS = 30 * 24 * 60 * 60


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


def _weight(entry: dict) -> int:
    """绑定的调度权重，非负整数；缺失或非法时取 1，保持中性。"""
    try:
        return max(0, int(entry.get("weight", 1)))
    except (TypeError, ValueError):
        return 1


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
    result.sort(key=lambda entry: (-_weight(entry), entry["id"]))
    return result


# 兼容旧调用名
def entries(pool: dict, role: str) -> list[dict]:
    return bindings(pool, role)


def read_health_file(path: str | Path) -> dict:
    path = Path(path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_health_file(path: str | Path, state: dict) -> None:
    c.dump_json(path, state)


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
    item.update(
        {
            "status": "ok",
            "failures": 0,
            "early_failures": 0,
            "late_failures": 0,
            "updated_at": _iso(_now()),
        }
    )
    for key in ("until", "reason", "first_failure_at"):
        item.pop(key, None)


def mark_used(state: dict, entry: dict) -> None:
    """记录最后一次被选中，供下一轮按最久未用优先调度。"""
    _endpoint_state(state, entry["id"])["last_used_at"] = _iso(_now())


def _bucket(kind: str) -> str:
    return "early" if kind in ("auth", "config") else "late"


def mark_failure(state: dict, entry: dict, error: ModelError, cfg: dict) -> None:
    """只标记 endpoint；早期/晚期分别累计，退避时间按 2^(n-1) 增长，成功时清零。"""
    item = _endpoint_state(state, entry["id"])
    bucket = _bucket(error.kind)
    counter = f"{bucket}_failures"
    item[counter] = int(item.get(counter, 0)) + 1
    item["failures"] = int(item.get("failures", 0)) + 1
    item["reason"] = error.kind
    item["updated_at"] = _iso(_now())

    base = float(cfg.get(f"{bucket}_base_minutes", 15 if bucket == "early" else 5))
    cap = float(cfg.get(f"{bucket}_max_minutes", 1440 if bucket == "early" else 360))
    if bucket == "late" and error.retry_after:
        base = max(base, error.retry_after / 60)
    minutes = min(cap, base * (2 ** (int(item[counter]) - 1)))
    item["status"] = "disabled" if minutes >= cap else "cooldown"
    item["until"] = _iso(_now() + timedelta(minutes=minutes))


def key_for(entry: dict) -> str:
    return os.environ.get(entry.get("api_key_env", ""), "")


def _post(entry: dict, key: str, payload: dict, timeout: int) -> dict:
    url = entry["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    headers.update({str(k): str(v) for k, v in (entry.get("headers") or {}).items()})
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
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


def select(pool: dict, role: str, state: dict) -> tuple[dict, str]:
    for entry in candidates(pool, role, state):
        return entry, key_for(entry)
    raise ModelError("unavailable", 0, 0, f"no healthy entry for {role}")


def candidates(pool: dict, role: str, state: dict, require_key: bool = True) -> list[dict]:
    """按 `weight × 待机时长` 从高到低排序，作为带权的最久未用调度。

    待机时长 = 距上次被选中的秒数，上限 `MAX_IDLE_SECONDS`；从未使用过的取上限值，因此
    「闲置一个月」与「从未用过」等价。得分 = 权重 × 待机时长，选中即刷新 `last_used_at`，
    所以长期选择次数趋于权重之比——权重翻倍的效果是间隔减半，而不是永久优先。
    """
    items = [
        entry
        for entry in bindings(pool, role)
        if is_available(entry, state) and (not require_key or key_for(entry))
    ]
    now = _now()

    def idle_seconds(entry: dict) -> float:
        used = _endpoint_state(state, entry["id"]).get("last_used_at")
        if not used:
            return MAX_IDLE_SECONDS
        try:
            elapsed = (now - _parse(used)).total_seconds()
        except Exception:
            # 时间戳来自外部 variable，坏值按「从未使用」处理，不让它打断调度。
            return MAX_IDLE_SECONDS
        return min(MAX_IDLE_SECONDS, max(0.0, elapsed))

    def sort_key(entry: dict):
        weight = _weight(entry)
        return (-weight * idle_seconds(entry), -weight, entry["id"])

    items.sort(key=sort_key)
    return items


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


