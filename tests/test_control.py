import sys
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
