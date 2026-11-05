import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import render  # noqa: E402
import scan_out  # noqa: E402


class RenderTest(unittest.TestCase):
    def test_answer_renders_maamend_style_sections(self):
        answer = json.loads((ROOT / "tests/fixtures/answer.sample.json").read_text(encoding="utf-8"))
        repo_cfg = {"_repo": "Tanimodori/GregTech6", "_issue": "1"}
        text = render.render_answer(
            answer,
            repo_cfg,
            "https://example/run/1",
            "abc123",
            partial=False,
            issue_title="测试标题",
            issue_number="1",
        )
        self.assertIn("# GT6 Issue #1 分析：测试标题", text)
        self.assertIn("## Issue 概要", text)
        self.assertIn("## 关键证据", text)
        self.assertIn("<details><summary>点击此处展开</summary>", text)
        self.assertIn("## 根因判断", text)
        self.assertIn("## 给用户的建议", text)
        self.assertIn("## 修复方案", text)
        self.assertIn("## 置信度", text)
        self.assertIn("RecipeMap.java:120-138", text)
        self.assertIn("lily:done", text)
        self.assertNotIn("lily:partial", text)

    def test_partial_has_banner_and_title(self):
        repo_cfg = {"_repo": "Tanimodori/GregTech6", "_issue": "1"}
        text = render.render_markdown(
            "# 片段",
            repo_cfg,
            "",
            "abc",
            "timeout 60min",
            issue_title="测试标题",
            issue_number="1",
        )
        self.assertIn("# GT6 Issue #1 分析：测试标题", text)
        self.assertIn("部分结论", text)
        self.assertIn("lily:partial", text)

    def test_validate_requires_new_fields(self):
        answer = json.loads((ROOT / "tests/fixtures/answer.sample.json").read_text(encoding="utf-8"))
        self.assertIsNone(render.validate(answer))
        broken = dict(answer)
        broken.pop("issue_summary")
        self.assertIn("missing issue_summary", render.validate(broken))


    def test_labels_filtered_by_write_only(self):
        answer = json.loads((ROOT / "tests/fixtures/answer.sample.json").read_text(encoding="utf-8"))
        answer["labels"] = ["crash", "wontfix"]
        repo_cfg = {
            "_repo": "Tanimodori/GregTech6",
            "_issue": "1",
            "triage": {"write_only": ["crash"]},
        }
        text = render.render_answer(
            answer, repo_cfg, "", "abc", partial=False, issue_title="t", issue_number="1"
        )
        self.assertIn("建议标签：crash", text)
        self.assertNotIn("wontfix", text)

    def test_scan_blocks_exact_secret(self):
        hits = scan_out.scan_text("here is abcdefghijk", ["abcdefghijk"])
        self.assertIn("exact-secret", hits)

    def test_scan_blocks_pem(self):
        hits = scan_out.scan_text("-----BEGIN PRIVATE KEY-----")
        self.assertTrue(hits)


if __name__ == "__main__":
    unittest.main()
