import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("REPO", "Tanimodori/GregTech6")
os.environ.setdefault("ISSUE", "1")

import agent_supervisor as supervisor  # noqa: E402


class SupervisorRetryTest(unittest.TestCase):
    def test_parse_retry_after(self):
        self.assertEqual(supervisor.parse_retry_after("HTTP 429 Retry-After: 42"), 42)
        self.assertEqual(supervisor.parse_retry_after("rate limited, try again in 15 seconds"), 15)
        self.assertEqual(supervisor.parse_retry_after("no header"), 0)

    def test_rate_wait(self):
        error = supervisor.model_pool.ModelError("rate", 429, 0, "")
        self.assertEqual(supervisor.rate_wait_seconds(error, {"rate_limit_wait_seconds": 60}), 60)
        far = supervisor.model_pool.ModelError("rate", 429, 999, "")
        self.assertEqual(
            supervisor.rate_wait_seconds(far, {"rate_limit_max_wait_seconds": 300}), 300
        )

    def test_classify_429(self):
        error = supervisor.classify_log("ERROR: HTTP 429 Too Many Requests\nRetry-After: 42")
        self.assertIsNotNone(error)
        self.assertEqual(error.kind, "rate")
        self.assertEqual(error.retry_after, 42)

    def test_classify_upstream(self):
        error = supervisor.classify_log("ERROR: upstream HTTP 503 unavailable")
        self.assertIsNotNone(error)
        self.assertEqual(error.kind, "upstream")

    def test_success_resets_health_failures(self):
        state = {"endpoints": {}}
        entry = {"id": "mistral-deepseek"}
        error = supervisor.model_pool.ModelError("rate", 429, 0, "")
        supervisor.model_pool.mark_failure(state, entry, error, {})
        self.assertGreaterEqual(state["endpoints"]["mistral-deepseek"]["failures"], 1)
        supervisor.model_pool.mark_success(state, entry)
        item = state["endpoints"]["mistral-deepseek"]
        self.assertEqual(item["failures"], 0)
        self.assertEqual(item["status"], "ok")
        self.assertNotIn("until", item)

    def test_failure_reason_mentions_rate_and_retries(self):
        error = supervisor.model_pool.ModelError("rate", 429, 0, "")
        self.assertEqual(supervisor.failure_reason(error, 5), "rate 429 after 5 retries")
        self.assertEqual(supervisor.failure_reason(error, 0), "rate 429")


if __name__ == "__main__":
    unittest.main()
