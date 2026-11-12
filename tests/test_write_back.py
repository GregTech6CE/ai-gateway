"""`write_back` 的可测性与写回路径：S-1 / P0-3。"""

import importlib
import os
import sys
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import common  # noqa: E402
import scan_out  # noqa: E402
import write_back  # noqa: E402

CFG = {
    "repo": "GregTech6CE/GregTech6",
    "issue": "42",
    "comment_id": "123",
    "gh_rw": "rw",
    "gh_ro": "ro",
    "bot_enabled": "true",
    "run_url": "",
    "dry_run": False,
    "repo_cfg": {"_repo": "GregTech6CE/GregTech6", "enabled": True},
}


class ImportSideEffectTest(unittest.TestCase):
    def test_import_does_not_require_env(self):
        saved = {key: os.environ.pop(key, None) for key in ("REPO", "ISSUE", "GH_RW_TOKEN")}
        try:
            importlib.reload(write_back)
        finally:
            for key, value in saved.items():
                if value is not None:
                    os.environ[key] = value
        self.assertTrue(callable(write_back.load_config))

    def test_load_config_reads_env(self):
        saved = dict(os.environ)
        os.environ.update({"REPO": "GregTech6CE/GregTech6", "ISSUE": "7", "GH_RW_TOKEN": "rw"})
        os.environ.pop("COMMENT_ID", None)
        try:
            cfg = write_back.load_config()
        finally:
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual(cfg["issue"], "7")
        self.assertEqual(cfg["gh_ro"], "rw")  # GH_RO_TOKEN 缺省时回落到 GH_RW_TOKEN
        self.assertEqual(cfg["comment_id"], "")


class PostFallbackTest(unittest.TestCase):
    def _run(self, patch_error: Exception | None):
        calls = []

        def fake_request(method, path, token, data=None, timeout=30):  # noqa: ARG001
            calls.append((method, path))
            if method == "PATCH" and patch_error is not None:
                raise patch_error
            return {}

        with unittest.mock.patch.object(common, "request", fake_request):
            write_back.post("body", CFG)
        return calls

    def test_patch_404_falls_back_to_new_comment(self):
        calls = self._run(common.GitHubApiError("PATCH", "/x", 404, "nf"))
        self.assertEqual([m for m, _ in calls], ["PATCH", "POST"])

    def test_patch_410_falls_back_to_new_comment(self):
        calls = self._run(common.GitHubApiError("PATCH", "/x", 410, "gone"))
        self.assertEqual([m for m, _ in calls], ["PATCH", "POST"])

    def test_patch_500_is_raised(self):
        with self.assertRaises(common.GitHubApiError):
            self._run(common.GitHubApiError("PATCH", "/x", 500, "boom"))

    def test_without_comment_id_posts_directly(self):
        cfg = dict(CFG, comment_id="")
        calls = []

        def fake_request(method, path, token, data=None, timeout=30):  # noqa: ARG001
            calls.append(method)
            return {}

        with unittest.mock.patch.object(common, "request", fake_request):
            write_back.post("body", cfg)
        self.assertEqual(calls, ["POST"])


class ExactSecretScanTest(unittest.TestCase):
    def test_scan_secret_env_is_picked_up(self):
        os.environ["SCAN_SECRET_TOKEN"] = "zzz-super-secret-value"
        try:
            text = "正文里出现了 zzz-super-secret-value 这一串"
            self.assertEqual(scan_out.scan_text(text), [])
            self.assertIn("exact-secret", scan_out.scan_text(text, scan_out.secrets_from_env()))
        finally:
            os.environ.pop("SCAN_SECRET_TOKEN", None)

    def test_short_values_are_ignored(self):
        # `_secrets` 会丢弃短于 8 字符的值：太短的串做子串匹配会大面积误伤。
        os.environ["SCAN_SECRET_SHORT"] = "abc"
        try:
            self.assertEqual(scan_out.scan_text("xabcx", scan_out.secrets_from_env()), [])
        finally:
            os.environ.pop("SCAN_SECRET_SHORT", None)


if __name__ == "__main__":
    unittest.main()
