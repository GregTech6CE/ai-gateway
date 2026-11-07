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


class DebounceTest(unittest.TestCase):
    def test_fingerprint_uses_updated_at_comments_and_body(self):
        issue = {
            "updated_at": "2026-11-07T00:00:00Z",
            "comments": 3,
            "title": "title",
            "body": "body",
        }
        with mock.patch.object(control, "api", return_value=issue):
            fingerprint = control.issue_fingerprint("o/r", "7", "token")
        self.assertEqual(fingerprint[0], "2026-11-07T00:00:00Z")
        self.assertEqual(fingerprint[1], 3)
        self.assertEqual(fingerprint[2], control.c.sha256_text("title\nbody"))

    def test_wait_returns_after_one_stable_window(self):
        env = {
            "GITHUB_EVENT_NAME": "issues",
            "DEBOUNCE_SECONDS": "60",
            "DEBOUNCE_MAX_SECONDS": "300",
        }
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "issue_fingerprint", return_value=("t", 1, "h")
        ), mock.patch.object(control.time, "sleep") as sleep:
            control.wait_for_stable("o/r", "7", "token")
        sleep.assert_called_once_with(60)

    def test_wait_restarts_when_issue_changes(self):
        env = {
            "GITHUB_EVENT_NAME": "issues",
            "DEBOUNCE_SECONDS": "60",
            "DEBOUNCE_MAX_SECONDS": "300",
        }
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control,
            "issue_fingerprint",
            side_effect=[("a", 1, "h"), ("b", 2, "h"), ("b", 2, "h")],
        ), mock.patch.object(control.time, "sleep") as sleep, redirect_stderr(io.StringIO()):
            control.wait_for_stable("o/r", "7", "token")
        self.assertEqual(sleep.call_count, 2)

    def test_wait_stops_at_cap(self):
        env = {
            "GITHUB_EVENT_NAME": "issues",
            "DEBOUNCE_SECONDS": "60",
            "DEBOUNCE_MAX_SECONDS": "120",
        }
        clock = [0.0]

        def fake_sleep(seconds):
            clock[0] += seconds

        def fake_monotonic():
            return clock[0]

        stderr = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control,
            "issue_fingerprint",
            side_effect=[("a", 1, "h"), ("b", 2, "h"), ("c", 3, "h")],
        ), mock.patch.object(
            control.time, "sleep", side_effect=fake_sleep
        ), mock.patch.object(
            control.time, "monotonic", side_effect=fake_monotonic
        ), redirect_stderr(stderr):
            control.wait_for_stable("o/r", "7", "token")
        self.assertIn("debounce cap", stderr.getvalue())

    def test_wait_skips_manual_dispatch(self):
        env = {"GITHUB_EVENT_NAME": "workflow_dispatch"}
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "issue_fingerprint"
        ) as fingerprint, mock.patch.object(control.time, "sleep") as sleep:
            control.wait_for_stable("o/r", "7", "token")
        fingerprint.assert_not_called()
        sleep.assert_not_called()

    def test_wait_disabled_by_zero_interval(self):
        env = {
            "GITHUB_EVENT_NAME": "issues",
            "DEBOUNCE_SECONDS": "0",
            "DEBOUNCE_MAX_SECONDS": "300",
        }
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "issue_fingerprint"
        ) as fingerprint:
            control.wait_for_stable("o/r", "7", "token")
        fingerprint.assert_not_called()


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
            control, "wait_for_stable"
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

    def test_start_waits_before_placeholder(self):
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
        calls = []

        def fake_precheck(repo, issue, token):
            calls.append("precheck")
            return "", "title"

        def fake_wait(repo, issue, token):
            calls.append("wait")

        def fake_post():
            calls.append("post")
            return {"id": 99}

        def fake_api(method, path, token, data=None):
            if method == "POST" and path.endswith("/dispatches"):
                calls.append("dispatch")
                return {"workflow_run_id": 123}
            raise AssertionError((method, path))

        def fake_update(comment_id, run_url):
            calls.append("update")

        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            control, "precheck", side_effect=fake_precheck
        ), mock.patch.object(
            control, "wait_for_stable", side_effect=fake_wait
        ), mock.patch.object(
            control, "post_placeholder", side_effect=fake_post
        ), mock.patch.object(
            control, "api", side_effect=fake_api
        ), mock.patch.object(
            control, "update_placeholder", side_effect=fake_update
        ), mock.patch.object(
            control.c, "set_output"
        ), redirect_stdout(io.StringIO()):
            control.start()

        self.assertEqual(
            calls,
            ["precheck", "wait", "precheck", "post", "dispatch", "update"],
        )

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
            control, "wait_for_stable"
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
