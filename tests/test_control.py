import io
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import control  # noqa: E402


class ControlFallbackTest(unittest.TestCase):
    def test_failure_run_produces_failed_result(self):
        result = control.fallback_result("123", {"status": "completed", "conclusion": "failure"})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "B run 123 failure")
        self.assertEqual(result["run_conclusion"], "failure")

    def test_timeout_produces_failed_result(self):
        result = control.fallback_result("123", {"status": "timeout", "conclusion": "timed_out"})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "B run 123 timed_out")


class PlaceholderTest(unittest.TestCase):
    def test_body_contains_run_url_and_request_marker(self):
        env = {
            "REPO": "GregTech6CE/GregTech6",
            "ISSUE": "42",
            "REQUEST_ID": "123456",
            "BOT_NAME": "gt6ce-bot",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            body = control.placeholder_body(
                "https://github.com/GregTech6CE/ai-gateway/actions/runs/99"
            )
        self.assertIn(
            "[GitHub Action 运行记录](https://github.com/GregTech6CE/ai-gateway/actions/runs/99)",
            body,
        )
        self.assertIn(
            "<!-- lily:requested repo=GregTech6CE/GregTech6 issue=42 request=123456 -->",
            body,
        )
        self.assertIn("预计耗时约 10 分钟", body)

    def test_update_patches_placeholder_with_run_url(self):
        calls = []

        def fake_api(method, path, token, data=None):
            calls.append((method, path, data))
            if method == "GET":
                return {"body": "<!-- lily:requested repo=o/r issue=7 request=42 -->"}
            return {}

        env = {
            "REPO": "o/r",
            "ISSUE": "7",
            "REQUEST_ID": "42",
            "GH_RW_TOKEN": "token",
            "BOT_NAME": "bot",
        }
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "api", side_effect=fake_api
        ):
            control.update_placeholder("99", "https://example.test/runs/1")

        self.assertEqual([call[0] for call in calls], ["GET", "PATCH"])
        self.assertEqual(calls[1][1], "/repos/o/r/issues/comments/99")
        self.assertIn("https://example.test/runs/1", calls[1][2]["body"])
        self.assertIn("request=42", calls[1][2]["body"])

    def test_update_skips_when_comment_is_no_longer_placeholder(self):
        calls = []

        def fake_api(method, path, token, data=None):
            calls.append(method)
            return {"body": "<!-- lily:done repo=o/r issue=7 snapshot=abc -->"}

        env = {
            "REPO": "o/r",
            "ISSUE": "7",
            "REQUEST_ID": "42",
            "GH_RW_TOKEN": "token",
        }
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "api", side_effect=fake_api
        ):
            control.update_placeholder("99", "https://example.test/runs/1")

        self.assertEqual(calls, ["GET"])

    def test_update_without_comment_id_does_nothing(self):
        with mock.patch.object(control, "api") as api:
            control.update_placeholder("", "https://example.test/runs/1")
        api.assert_not_called()

    def test_update_swallows_api_errors(self):
        env = {
            "REPO": "o/r",
            "ISSUE": "7",
            "REQUEST_ID": "42",
            "GH_RW_TOKEN": "token",
        }
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "api", side_effect=RuntimeError("boom")
        ), redirect_stderr(io.StringIO()):
            control.update_placeholder("99", "https://example.test/runs/1")


class StartTest(unittest.TestCase):
    def test_start_updates_placeholder_after_dispatch(self):
        env = {
            "REPO": "o/r",
            "ISSUE": "7",
            "EVENT": "issues",
            "REQUEST_ID": "42",
            "DRY_RUN": "false",
            "B_REPO": "GregTech6CE/ai-gateway",
            "B_PAT": "pat",
            "GH_RW_TOKEN": "token",
        }
        dispatched = {}
        updated = []

        def fake_api(method, path, token, data=None):
            if method == "POST" and path.endswith("/dispatches"):
                dispatched["data"] = data
                return {"workflow_run_id": 123}
            raise AssertionError((method, path))

        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "precheck", return_value=("", "title")
        ), mock.patch.object(
            control, "post_placeholder", return_value={"id": 99}
        ), mock.patch.object(
            control, "api", side_effect=fake_api
        ), mock.patch.object(
            control,
            "update_placeholder",
            side_effect=lambda comment_id, run_url: updated.append((comment_id, run_url)),
        ), mock.patch.object(
            control.c, "set_output"
        ), redirect_stdout(io.StringIO()):
            control.start()

        self.assertEqual(
            updated,
            [("99", "https://github.com/GregTech6CE/ai-gateway/actions/runs/123")],
        )
        self.assertEqual(dispatched["data"]["inputs"]["placeholder_comment_id"], "99")

    def test_start_dry_run_does_not_post_placeholder(self):
        env = {
            "REPO": "o/r",
            "ISSUE": "7",
            "EVENT": "issues",
            "REQUEST_ID": "42",
            "DRY_RUN": "true",
            "B_REPO": "GregTech6CE/ai-gateway",
            "B_PAT": "pat",
        }
        dispatched = {}

        def fake_api(method, path, token, data=None):
            if method == "POST" and path.endswith("/dispatches"):
                dispatched["data"] = data
                return {"workflow_run_id": 123}
            raise AssertionError((method, path))

        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "precheck", return_value=("", "title")
        ), mock.patch.object(
            control, "post_placeholder"
        ) as post, mock.patch.object(
            control, "api", side_effect=fake_api
        ), mock.patch.object(
            control, "update_placeholder"
        ) as update, mock.patch.object(
            control.c, "set_output"
        ), redirect_stdout(io.StringIO()):
            control.start()

        post.assert_not_called()
        update.assert_called_once_with(
            "", "https://github.com/GregTech6CE/ai-gateway/actions/runs/123"
        )
        self.assertEqual(dispatched["data"]["inputs"]["placeholder_comment_id"], "")


if __name__ == "__main__":
    unittest.main()
