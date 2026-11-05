#!/usr/bin/env python3
"""阶段三 A：确定性渲染器，不调用任何模型。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c  # noqa: E402

MAX_LENGTH = 60_000
REQUIRED = ("issue_type", "conclusion", "confidence", "evidence", "fix_plan", "labels", "partial")


def validate(data) -> str | None:
    if not isinstance(data, dict):
        return "not an object"
    for key in REQUIRED:
        if key not in data:
            return f"missing {key}"
    if data.get("confidence") not in ("high", "medium", "low"):
        return "bad confidence"
    if not isinstance(data.get("conclusion"), str) or len(data["conclusion"].strip()) < 10:
        return "conclusion too short"
    if not isinstance(data.get("evidence"), list) or not isinstance(data.get("fix_plan"), list):
        return "evidence/fix_plan not lists"
    return None


def evidence_block(items: list) -> str:
    lines = []
    for item in items[:40]:
        if not isinstance(item, dict):
            continue
        summary = str(item.get("summary", "")).strip()
        location = ""
        file = item.get("file")
        if file:
            location = f"{file}"
            if item.get("line_start"):
                location += f":{item['line_start']}"
                if item.get("line_stop"):
                    location += f"-{item['line_stop']}"
        ref = item.get("ref")
        suffix = f"（{location}）" if location else (f"（{ref}）" if ref else "")
        if summary:
            lines.append(f"- {summary}{suffix}")
    return "\n".join(lines) or "未提供。"


def render_answer(answer: dict, tenant: dict, run_url: str, snapshot: str, partial: bool) -> str:
    template = (c.ROOT / "templates/comment.md").read_text(encoding="utf-8")
    root = str(answer.get("root_cause") or "").strip()
    notes = str(answer.get("notes") or "").strip()
    values = {
        "{{partial_banner}}": (
            "> ⚠️ **部分结论**：分析在时限内未完成，以下为已完成内容。\n\n" if partial else ""
        ),
        "{{conclusion}}": str(answer.get("conclusion") or "").strip(),
        "{{root_cause_block}}": f"## 根因\n\n{root}" if root else "",
        "{{confidence}}": str(answer.get("confidence") or "low"),
        "{{evidence}}": evidence_block(answer.get("evidence") or []),
        "{{fix_plan}}": "\n".join(
            f"{index}. {str(item).strip()}"
            for index, item in enumerate(answer.get("fix_plan") or [], 1)
        )
        or "未提供。",
        "{{affected_versions}}": "\n".join(
            f"- {item}" for item in answer.get("affected_versions") or []
        )
        or "未确定。",
        "{{labels}}": ", ".join(str(item) for item in answer.get("labels") or []) or "无",
        "{{notes_block}}": f"> 备注：{notes}\n\n" if notes else "",
        "{{run_link}}": f"[运行记录]({run_url})" if run_url else "",
        "{{marker}}": c.marker(
            "partial" if partial else "done",
            repo=tenant["issue_repo"],
            issue=tenant.get("_issue", ""),
            snapshot=snapshot,
            tenant=tenant.get("_tenant", ""),
        ),
    }
    text = template
    for key, value in values.items():
        text = text.replace(key, value)
    if len(text) > MAX_LENGTH:
        text = (
            "## 结论\n\n"
            + values["{{conclusion}}"]
            + "\n\n> 评论过长，完整证据与修复方案见运行 artifact。\n\n"
            + values["{{run_link}}"]
            + "\n\n"
            + values["{{marker}}"]
        )
    return text


def render_markdown(markdown: str, tenant: dict, run_url: str, snapshot: str, reason: str) -> str:
    banner = f"> ⚠️ **部分结论**：{reason}，以下为已完成内容。\n\n"
    text = banner + markdown.strip()
    if run_url:
        text += f"\n\n---\n\n[运行记录]({run_url})"
    text += "\n\n" + c.marker(
        "partial",
        repo=tenant["issue_repo"],
        issue=tenant.get("_issue", ""),
        snapshot=snapshot,
        tenant=tenant.get("_tenant", ""),
    )
    return text[:MAX_LENGTH]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--issue", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--run-url", default="")
    parser.add_argument("--answer", default="outputs/answer.json")
    parser.add_argument("--markdown", default="outputs/answer.md")
    parser.add_argument("--status", default="complete")
    parser.add_argument("--reason", default="")
    parser.add_argument("--out", default="outputs/comment.md")
    args = parser.parse_args()

    tenant = c.load_tenant(args.tenant)
    tenant["_issue"] = args.issue
    tenant["_tenant"] = args.tenant
    partial = args.status != "complete"

    answer_path = Path(args.answer)
    markdown_path = Path(args.markdown)
    text = ""
    if answer_path.exists() and not partial:
        try:
            data = json.loads(answer_path.read_text(encoding="utf-8"))
        except Exception:
            data = None
        if data is not None and validate(data) is None:
            text = render_answer(data, tenant, args.run_url, args.snapshot, False)
        elif markdown_path.exists():
            text = render_markdown(
                markdown_path.read_text(encoding="utf-8"),
                tenant,
                args.run_url,
                args.snapshot,
                "结构化结果无效",
            )
    elif markdown_path.exists():
        text = render_markdown(
            markdown_path.read_text(encoding="utf-8"),
            tenant,
            args.run_url,
            args.snapshot,
            args.reason or "分析未完成",
        )

    if not text:
        text = (
            "分析未能完成。可以稍后重新触发，或由维护者手动查看运行记录。\n\n"
            + (f"[运行记录]({args.run_url})\n\n" if args.run_url else "")
            + c.marker(
                "failed",
                repo=tenant["issue_repo"],
                issue=args.issue,
                snapshot=args.snapshot,
                tenant=args.tenant,
            )
        )

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(text + "\n", encoding="utf-8")
    print(args.out)


if __name__ == "__main__":
    main()
