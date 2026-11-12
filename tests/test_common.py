"""`common.request` 的错误契约：P0-2。

异常文本仍是 `GitHub API {m} {p} -> {code}: {detail}`（日志与历史 run 以它为对照物），
但调用方改为判 `status`。本文件锁住「两者同时成立」。
"""

import io
import sys
import unittest
import unittest.mock
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import common  # noqa: E402


class GitHubApiErrorTest(unittest.TestCase):
    def _request_with(self, code: int, body: bytes = b"boom"):
        def fake_urlopen(req, timeout=30):  # noqa: ARG001
            raise urllib.error.HTTPError(req.full_url, code, "err", {}, io.BytesIO(body))

        with unittest.mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            return common.request("GET", "/repos/a/b", "t")

    def test_status_is_exposed(self):
        with self.assertRaises(common.GitHubApiError) as ctx:
            self._request_with(404)
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(ctx.exception.method, "GET")
        self.assertEqual(ctx.exception.path, "/repos/a/b")

    def test_message_format_is_unchanged(self):
        with self.assertRaises(common.GitHubApiError) as ctx:
            self._request_with(410)
        self.assertEqual(str(ctx.exception), "GitHub API GET /repos/a/b -> 410: boom")

    def test_is_runtime_error_subclass(self):
        # 既有代码里还有 `except RuntimeError` 的兜底，不能破坏它。
        self.assertTrue(issubclass(common.GitHubApiError, RuntimeError))


if __name__ == "__main__":
    unittest.main()
