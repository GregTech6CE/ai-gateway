import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import render  # noqa: E402
import scan_out  # noqa: E402


class RenderTest(unittest.TestCase):
    def test_answer_renders_sections(self):
        answer = json.loads((ROOT / "tests/fixtures/answer.sample.json").read_text(encoding="utf-8"))
        tenant = {"issue_repo": "Tanimodori/GregTech6", "_issue": "1", "_tenant": "gt6ce-fork"}
        text = render.render_answer(
            answer, tenant, "https://example/run/1", "abc123", partial=False
        )
        self.assertIn("## 结论", text)
        self.assertIn("RecipeMap.java:120-138", text)
        self.assertIn("lily:done", text)
        self.assertNotIn("lily:partial", text)

    def test_partial_has_banner(self):
        tenant = {"issue_repo": "Tanimodori/GregTech6", "_issue": "1", "_tenant": "gt6ce-fork"}
        text = render.render_markdown("# 片段", tenant, "", "abc", "timeout 60min")
        self.assertIn("部分结论", text)
        self.assertIn("lily:partial", text)

    def test_scan_blocks_exact_secret(self):
        hits = scan_out.scan_text("here is abcdefghijk", ["abcdefghijk"])
        self.assertIn("exact-secret", hits)

    def test_scan_blocks_pem(self):
        hits = scan_out.scan_text("-----BEGIN PRIVATE KEY-----")
        self.assertTrue(hits)


if __name__ == "__main__":
    unittest.main()
