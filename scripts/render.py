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
REQUIRED = (
    "issue_type",
    "issue_summary",
    "conclusion",
    "root_cause",
    "confidence",
    "confidence_reason",
    "evidence",
    "user_advice",
    "fix_plan",
    "labels",
    "partial",
)


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
    if not isinstance(data.get("root_cause"), str) or len(data["root_cause"].strip()) < 10:
        return "root_cause too short"
    for key in ("issue_summary", "evidence", "user_advice", "fix_plan"):
        if not isinstance(data.get(key), list):
            return f"{key} not a list"
    return None


def bullets(items, empty: str = "未提供。") -> str:
    lines = [f"- {str(item).strip()}" for item in items or [] if str(item).strip()]
    return "\n".join(lines) or empty


def numbered(items, empty: str = "未提供。") -> str:
    lines = [
        f"{index}. {str(item).strip()}"
        for index, item in enumerate(items or [], 1)
        if str(item).strip()
    ]
    return "\n".join(lines) or empty


def evidence_block(items) -> str:
    lines = []
    for item in (items or [])[:40]:
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


def marker_for(kind: str, tenant: dict, issue: str, snapshot: str) -> str:
    return c.marker(
        kind,
        repo=tenant["issue_repo"],
        issue=issue,
        snapshot=snapshot,
        tenant=tenant.get("_tenant", ""),
    )


def render_answer(
    answer: dict,
    tenant: dict,
    run_url: str,
    snapshot: str,
    partial: bool,
    issue_title: str = "",
    issue_number: str = "",
) -> str:
    template = (c.ROOT / "templates/comment.md").read_text(encoding="utf-8")
    issue = str(issue_number or tenant.get("_issue", ""))
    title = issue_title.strip() or "未提供标题"
    root = str(answer.get("root_cause") or "").strip()
    notes = str(answer.get("notes") or "").strip()
    hint = str(answer.get("ai_fix_hint") or "").strip()
    versions = "、".join(str(item) for item in answer.get("affected_versions") or []) or "未确定"
    labels = ", ".join(str(item) for item in answer.get("labels") or []) or "无"
    values = {
        "{{issue_number}}": issue,
        "{{issue_title}}": title,
        "{{partial_banner}}": (
            "> ⚠️ **部分结论**：分析在时限内未完成，以下为已完成内容。\n\n" if partial else ""
        ),
        "{{issue_summary}}": bullets(answer.get("issue_summary")),
        "{{issue_type}}": str(answer.get("issue_type") or "unknown"),
        "{{affected_versions}}": versions,
        "{{labels}}": labels,
        "{{evidence}}": evidence_block(answer.get("evidence")),
        "{{root_cause}}": root,
        "{{conclusion}}": str(answer.get("conclusion") or "").strip(),
        "{{user_advice}}": bullets(answer.get("user_advice")),
        "{{fix_plan}}": numbered(answer.get("fix_plan")),
        "{{ai_fix_hint_block}}": (
            "## 给修复 AI 的建议（可复制）\n\n"
            "<details><summary>点击此处展开</summary>\n\n"
            f"{hint}\n\n"
            "</details>\n\n"
            if hint
            else ""
        ),
        "{{confidence}}": str(answer.get("confidence") or "low"),
        "{{confidence_reason}}": str(answer.get("confidence_reason") or "未提供。").strip(),
        "{{notes_block}}": f"> 备注：{notes}\n\n" if notes else "",
        "{{run_link_block}}": (
            f"🔗 [GitHub Action 运行记录]({run_url})" if run_url else ""
        ),
        "{{marker}}": marker_for(
            "partial" if partial else "done", tenant, issue, snapshot
        ),
    }
    text = template
    for key, value in values.items():
        text = text.replace(key, value)
    if len(text) > MAX_LENGTH:
        text = (
            f"# GT6 Issue #{issue} 分析：{title}\n\n"
            "## 结论\n\n"
            + values["{{conclusion}}"]
            + "\n\n> 评论过长，完整证据与修复方案见运行 artifact。\n\n"
            + (f"🔗 [GitHub Action 运行记录]({run_url})\n\n" if run_url else "")
            + values["{{marker}}"]
        )
    return text


def render_markdown(
    markdown: str,
    tenant: dict,
    run_url: str,
    snapshot: str,
    reason: str,
    issue_title: str = "",
    issue_number: str = "",
) -> str:
    issue = str(issue_number or tenant.get("_issue", ""))
    title = issue_title.strip() or "未提供标题"
    banner = f"> ⚠️ **部分结论**：{reason}，以下为已完成内容。\n\n"
    text = f"# GT6 Issue #{issue} 分析：{title}\n\n" + banner + markdown.strip()
    if run_url:
        text += f"\n\n---\n\n🔗 [GitHub Action 运行记录]({run_url})"
    text += "\n\n" + marker_for("partial", tenant, issue, snapshot)
    return text[:MAX_LENGTH]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--issue", required=True)
    parser.add_argument("--issue-title", default="")
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
            text = render_answer(
                data,
                tenant,
                args.run_url,
                args.snapshot,
                False,
                issue_title=args.issue_title,
                issue_number=args.issue,
            )
        elif markdown_path.exists():
            text = render_markdown(
                markdown_path.read_text(encoding="utf-8"),
                tenant,
                args.run_url,
                args.snapshot,
                "结构化结果无效",
                issue_title=args.issue_title,
                issue_number=args.issue,
            )
    elif markdown_path.exists():
        text = render_markdown(
            markdown_path.read_text(encoding="utf-8"),
            tenant,
            args.run_url,
            args.snapshot,
            args.reason or "分析未完成",
            issue_title=args.issue_title,
            issue_number=args.issue,
        )

    if not text:
        text = (
            f"# GT6 Issue #{args.issue} 分析：{args.issue_title or '未提供标题'}\n\n"
            "分析未能完成。可以稍后重新触发，或由维护者手动查看运行记录。\n\n"
            + (f"🔗 [GitHub Action 运行记录]({args.run_url})\n\n" if args.run_url else "")
            + marker_for("failed", tenant, args.issue, args.snapshot)
        )

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(text + "\n", encoding="utf-8")
    print(args.out)


if __name__ == "__main__":
    main()
