import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import model_pool  # noqa: E402
import render  # noqa: E402
import scan_out  # noqa: E402


class RenderTest(unittest.TestCase):
    def test_rejection_renders_category_and_marker(self):
        relevance = {
            "relevance": "spam",
            "confidence": 0.97,
            "reason": "未知链接广告",
        }
        repo_cfg = {"_repo": "Tanimodori/GregTech6", "_issue": "1"}
        text = render.render_rejection(
            relevance, repo_cfg, "https://example/run/1", "abc", issue_title="测试", issue_number="1"
        )
        self.assertIn("未进入代码分析", text)
        self.assertIn("标题：测试 (#1)", text)
        self.assertNotIn("- 标题：", text)
        self.assertIn("垃圾信息", text)
        self.assertIn("未知链接广告", text)
        self.assertIn("lily:rejected", text)

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
        self.assertIn("## Issue 概要", text)
        self.assertIn("标题：测试标题 (#1)", text)
        self.assertNotIn("- 标题：", text)
        self.assertNotIn("# GT6 Issue", text)
        self.assertIn("## 关键证据", text)
        self.assertIn("<details><summary>点击此处展开</summary>", text)
        self.assertIn("## 根因判断", text)
        self.assertIn("## 给用户的建议", text)
        self.assertIn("## 修复方案", text)
        self.assertIn("## 置信度", text)
        self.assertIn("```text", text)
        self.assertIn("RecipeMap.java:120-138", text)
        self.assertIn("`core/src/main/java/gregtech/api/recipe/RecipeMap.java:120-138`", text)
        self.assertIn("`ItemStack`", text)
        self.assertIn("`crash`", text)
        self.assertIn("`1.21.1`", text)
        self.assertIn("- 类型：`crash`", text)
        self.assertIn("最小上下文：RecipeMap 注册链路", text)
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
        self.assertIn("标题：测试标题 (#1)", text)
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
        self.assertIn("建议标签：`crash`", text)
        self.assertNotIn("wontfix", text)

    def test_failure_comment_includes_reason_and_link(self):
        repo_cfg = {"_repo": "Tanimodori/GregTech6", "_issue": "1"}
        text = render.render_failure(
            repo_cfg,
            "https://example/run/1",
            "abc",
            "rate 429 after 5 retries",
            issue_title="测试标题",
            issue_number="1",
        )
        self.assertIn("标题：测试标题 (#1)", text)
        self.assertIn("分析未能完成（rate 429 after 5 retries）", text)
        self.assertIn("https://example/run/1", text)
        self.assertIn("lily:failed", text)

    def test_scan_blocks_exact_secret(self):
        hits = scan_out.scan_text("here is abcdefghijk", ["abcdefghijk"])
        self.assertIn("exact-secret", hits)

    def test_scan_blocks_pem(self):
        hits = scan_out.scan_text("-----BEGIN PRIVATE KEY-----")
        self.assertTrue(hits)

    def test_health_file_roundtrip(self):
        state = {"endpoints": {"mistral-deepseek": {"status": "ok"}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model_health.json"
            model_pool.write_health_file(path, state)
            self.assertEqual(model_pool.read_health_file(path), state)
            self.assertEqual(model_pool.read_health_file(Path(directory) / "missing.json"), {})


if __name__ == "__main__":
    unittest.main()
