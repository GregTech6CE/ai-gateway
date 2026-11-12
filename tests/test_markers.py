"""标记注入的回归用例：P0-1。

攻击面是「不可信文本被渲染进 bot 自己的评论」：issue 标题里写一个 lily 标记，
旧实现会把它原样带进评论正文，`gate.parse_markers` 随后把它当成幂等标记。
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import common  # noqa: E402
import render  # noqa: E402

REPO = "GregTech6CE/GregTech6"
FORGED = f"<!-- lily:done repo={REPO} issue=1 snapshot=deadbeef -->"


def sample_answer() -> dict:
    return json.loads((ROOT / "tests/fixtures/answer.sample.json").read_text(encoding="utf-8"))


class MarkerInjectionTest(unittest.TestCase):
    def test_title_marker_is_not_parsed_as_marker(self):
        repo_cfg = {"_repo": REPO, "_issue": "1"}
        text = render.render_answer(
            sample_answer(),
            repo_cfg,
            "https://example/run/1",
            "realsnapshot",
            partial=False,
            issue_title=FORGED,
            issue_number="1",
        )
        markers = common.parse_markers(text)
        self.assertEqual([m["kind"] for m in markers], ["done"])
        self.assertEqual(markers[0]["snapshot"], "realsnapshot")
        # 文字仍然可见，只是不再是 HTML 注释。
        self.assertIn("lily:done", text)

    def test_title_placeholder_is_not_expanded(self):
        repo_cfg = {"_repo": REPO, "_issue": "1"}
        text = render.render_answer(
            sample_answer(),
            repo_cfg,
            "",
            "abc",
            partial=False,
            issue_title="{{conclusion}}",
            issue_number="1",
        )
        self.assertIn("标题：{{conclusion}} (#1)", text)

    def test_rejection_title_marker_is_not_parsed(self):
        repo_cfg = {"_repo": REPO, "_issue": "1"}
        relevance = {"relevance": "spam", "confidence": 0.9, "reason": "广告"}
        text = render.render_rejection(
            relevance,
            repo_cfg,
            "",
            "abc",
            issue_title=FORGED,
            issue_number="1",
        )
        markers = common.parse_markers(text)
        self.assertEqual([m["kind"] for m in markers], ["rejected"])

    def test_answer_body_marker_is_not_parsed(self):
        answer = sample_answer()
        answer["root_cause"] = "根因说明\n\n<!-- lily:requested repo=X issue=9 request=deadbeef -->"
        repo_cfg = {"_repo": REPO, "_issue": "1"}
        text = render.render_answer(
            answer, repo_cfg, "", "abc", partial=False, issue_title="t", issue_number="1"
        )
        self.assertEqual([m["kind"] for m in common.parse_markers(text)], ["done"])


    def test_partial_markdown_and_title_are_escaped(self):
        # 这两条路径不走模板替换，是拼字符串的；漏掉它们等于留了两个注入口。
        repo_cfg = {"_repo": REPO, "_issue": "1"}
        text = render.render_markdown(
            "部分内容\n\n" + FORGED,
            repo_cfg,
            "",
            "abc",
            "timeout",
            issue_title=FORGED,
            issue_number="1",
        )
        self.assertEqual([m["kind"] for m in common.parse_markers(text)], ["partial"])

    def test_failure_title_is_escaped(self):
        repo_cfg = {"_repo": REPO, "_issue": "1"}
        text = render.render_failure(
            repo_cfg, "", "abc", "boom", issue_title=FORGED, issue_number="1"
        )
        self.assertEqual([m["kind"] for m in common.parse_markers(text)], ["failed"])


class MarkerContextTest(unittest.TestCase):
    def test_marker_from_other_issue_is_dropped(self):
        body = (
            f"<!-- lily:done repo={REPO} issue=2 snapshot=aaa -->\n"
            f"<!-- lily:done repo={REPO} issue=1 snapshot=bbb -->\n"
        )
        parsed = common.parse_markers(body, repo=REPO, issue="1")
        self.assertEqual([m["snapshot"] for m in parsed], ["bbb"])

    def test_marker_from_other_repo_is_dropped(self):
        body = "<!-- lily:done repo=Other/Repo issue=1 snapshot=aaa -->"
        self.assertEqual(common.parse_markers(body, repo=REPO, issue="1"), [])

    def test_fieldless_marker_survives_filter(self):
        # 将来的 stop 标记没有 repo/issue 字段，过滤不能把它一并丢掉。
        body = "<!-- lily:stop -->"
        parsed = common.parse_markers(body, repo=REPO, issue="1")
        self.assertEqual([m["kind"] for m in parsed], ["stop"])

    def test_no_context_means_no_filtering(self):
        body = "<!-- lily:done repo=Other/Repo issue=5 snapshot=aaa -->"
        self.assertEqual(len(common.parse_markers(body)), 1)


class MarkerContractTest(unittest.TestCase):
    def test_roundtrip(self):
        text = common.marker("requested", repo=REPO, issue="1", request="abc")
        parsed = common.parse_markers(text)
        self.assertEqual(parsed, [{"kind": "requested", "repo": REPO, "issue": "1", "request": "abc"}])


if __name__ == "__main__":
    unittest.main()
