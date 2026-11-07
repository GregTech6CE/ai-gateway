"""标签门禁：白名单、轴归属、类型兼容与数量上限。

`issue_type` 承载类型轴，`labels` 承载性质、领域、分流状态、优先级与游戏版本。类型标签
不重复写入 `labels`；门禁只保留仓库配置里声明过的标签，并按轴丢弃超限项。
"""

from __future__ import annotations

import re

TYPE_AXIS = "type"
UNKNOWN = "unknown"
DEFAULT_TYPES = ("bug", "enhancement", "rfc")
DEFAULT_LIMITS = {
    TYPE_AXIS: 1,
    "kind": 2,
    "scope": 2,
    "status": 1,
    "priority": 1,
    "version": 1,
}
# 性质标签适用的类型；未列出的性质不做类型约束。
KIND_TYPES = {
    "crash": {"bug"},
    "regression": {"bug"},
    "perf": {"bug"},
    "parity": {"bug", "enhancement", "rfc"},
    "translation": {"bug", "enhancement"},
    "qol": {"enhancement"},
    "balance": {"enhancement"},
    "refactor": {"enhancement"},
}


def normalize(value) -> str:
    text = " ".join(str(value or "").split())
    # 模型偶尔写成 scope:machine / priority:low；统一成配置里的规范写法。
    return re.sub(r"^(scope|priority)\s*:\s*", r"\1: ", text, flags=re.I)


def _triage(repo_cfg: dict) -> dict:
    return (repo_cfg or {}).get("triage") or {}


def axes(repo_cfg: dict) -> dict[str, list[str]]:
    raw = _triage(repo_cfg).get("label_axes") or {}
    result: dict[str, list[str]] = {}
    for axis, values in raw.items():
        items = []
        for item in values or []:
            text = normalize(item)
            if text:
                items.append(text)
        if items:
            result[str(axis)] = items
    return result


def limits(repo_cfg: dict) -> dict[str, int]:
    raw = _triage(repo_cfg).get("label_limits") or {}
    result = dict(DEFAULT_LIMITS)
    for axis, value in raw.items():
        try:
            result[str(axis)] = max(0, int(value))
        except (TypeError, ValueError):
            continue
    return result


def type_values(repo_cfg: dict) -> list[str]:
    return axes(repo_cfg).get(TYPE_AXIS) or list(DEFAULT_TYPES)


def is_valid_type(value, repo_cfg: dict) -> bool:
    text = normalize(value).lower()
    if text == UNKNOWN:
        return True
    return text in {item.lower() for item in type_values(repo_cfg)}


def resolve_type(value, repo_cfg: dict) -> str:
    text = normalize(value).lower()
    for item in type_values(repo_cfg):
        if item.lower() == text:
            return item
    return UNKNOWN


def _lookup(repo_cfg: dict) -> dict[str, tuple[str, str]]:
    table: dict[str, tuple[str, str]] = {}
    for axis, values in axes(repo_cfg).items():
        for value in values:
            table[value.lower()] = (axis, value)
    return table


def _fallback(labels, issue_type, repo_cfg: dict):
    allowed = {
        normalize(item).lower(): normalize(item)
        for item in _triage(repo_cfg).get("write_only") or []
        if normalize(item)
    }
    kept: list[str] = []
    dropped: list[dict] = []
    seen: set[str] = set()
    for raw in labels or []:
        text = normalize(raw)
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        if key not in allowed:
            dropped.append({"label": text, "reason": "not_allowed"})
            continue
        kept.append(allowed[key])
    return kept, dropped, resolve_type(issue_type, repo_cfg)


def sanitize(labels, issue_type, repo_cfg: dict):
    """返回 ``(kept, dropped, resolved_type)``。

    - 不在白名单内的标签、类型标签、与类型不兼容的性质标签、超过轴上限的标签都会被丢弃。
    - 类型标签只由 ``issue_type`` 表达；``labels`` 里出现类型标签时按重复处理。
    - 类型无法识别时归为 ``unknown``，此时性质标签一并丢弃，避免输出自相矛盾的组合。
    """
    table = _lookup(repo_cfg)
    if not table:
        return _fallback(labels, issue_type, repo_cfg)

    resolved = resolve_type(issue_type, repo_cfg)
    maximum = limits(repo_cfg)
    counts: dict[str, int] = {}
    kept: list[str] = []
    dropped: list[dict] = []
    seen: set[str] = set()

    for raw in labels or []:
        text = normalize(raw)
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        entry = table.get(key)
        if entry is None:
            dropped.append({"label": text, "reason": "not_allowed"})
            continue
        axis, canonical = entry
        if axis == TYPE_AXIS:
            dropped.append({"label": canonical, "reason": "type_in_labels"})
            continue
        if axis == "kind":
            if resolved == UNKNOWN:
                dropped.append({"label": canonical, "reason": "kind_without_type"})
                continue
            allowed_types = KIND_TYPES.get(canonical.lower())
            if allowed_types and resolved.lower() not in allowed_types:
                dropped.append(
                    {"label": canonical, "reason": f"kind_not_for_{resolved}"}
                )
                continue
        limit = maximum.get(axis)
        if limit is not None and counts.get(axis, 0) >= limit:
            dropped.append({"label": canonical, "reason": f"limit_{axis}"})
            continue
        counts[axis] = counts.get(axis, 0) + 1
        kept.append(canonical)

    return kept, dropped, resolved


def format_dropped(dropped: list[dict]) -> str:
    return ", ".join(f"{item['label']}({item['reason']})" for item in dropped)
