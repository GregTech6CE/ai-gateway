import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import common  # noqa: E402
import labels  # noqa: E402


class LabelGateTest(unittest.TestCase):
    def setUp(self):
        self.cfg = common.load_repo("GregTech6CE/GregTech6")

    def test_keeps_allowed_labels(self):
        kept, dropped, issue_type = labels.sanitize(
            ["crash", "scope: machine", "priority: high", "1.21.1"], "bug", self.cfg
        )
        self.assertEqual(issue_type, "bug")
        self.assertEqual(kept, ["crash", "scope: machine", "priority: high", "1.21.1"])
        self.assertEqual(dropped, [])

    def test_type_label_is_not_repeated_in_labels(self):
        kept, dropped, issue_type = labels.sanitize(["bug", "crash"], "bug", self.cfg)
        self.assertEqual(issue_type, "bug")
        self.assertEqual(kept, ["crash"])
        self.assertEqual(dropped, [{"label": "bug", "reason": "type_in_labels"}])

    def test_conflicting_type_label_is_dropped(self):
        kept, dropped, issue_type = labels.sanitize(["enhancement", "crash"], "bug", self.cfg)
        self.assertEqual(issue_type, "bug")
        self.assertEqual(kept, ["crash"])
        self.assertEqual(dropped[0]["reason"], "type_in_labels")

    def test_unknown_and_resolution_labels_are_dropped(self):
        kept, dropped, _ = labels.sanitize(
            ["wontfix", "needs triage", "bot:stop", "crash"], "bug", self.cfg
        )
        self.assertEqual(kept, ["crash"])
        self.assertEqual(
            [item["reason"] for item in dropped],
            ["not_allowed", "not_allowed", "not_allowed"],
        )

    def test_kind_must_match_type(self):
        kept, dropped, _ = labels.sanitize(["crash", "qol"], "enhancement", self.cfg)
        self.assertEqual(kept, ["qol"])
        self.assertEqual(dropped[0]["reason"], "kind_not_for_enhancement")

        kept, dropped, _ = labels.sanitize(["crash", "qol"], "bug", self.cfg)
        self.assertEqual(kept, ["crash"])
        self.assertEqual(dropped[0]["reason"], "kind_not_for_bug")

    def test_parity_is_valid_for_all_types(self):
        for issue_type in ("bug", "enhancement", "rfc"):
            kept, dropped, _ = labels.sanitize(["parity"], issue_type, self.cfg)
            self.assertEqual(kept, ["parity"])
            self.assertEqual(dropped, [])

    def test_translation_is_not_valid_for_rfc(self):
        kept, dropped, _ = labels.sanitize(["translation"], "rfc", self.cfg)
        self.assertEqual(kept, [])
        self.assertEqual(dropped[0]["reason"], "kind_not_for_rfc")

    def test_kind_limit(self):
        kept, dropped, _ = labels.sanitize(
            ["crash", "regression", "perf"], "bug", self.cfg
        )
        self.assertEqual(kept, ["crash", "regression"])
        self.assertEqual(dropped[0]["reason"], "limit_kind")

    def test_scope_limit(self):
        kept, dropped, _ = labels.sanitize(
            ["scope: machine", "scope: recipe", "scope: ui"], "bug", self.cfg
        )
        self.assertEqual(kept, ["scope: machine", "scope: recipe"])
        self.assertEqual(dropped[0]["reason"], "limit_scope")

    def test_priority_and_version_limits(self):
        kept, dropped, _ = labels.sanitize(
            ["priority: low", "priority: high", "1.20.1", "1.21.1"], "bug", self.cfg
        )
        self.assertEqual(kept, ["priority: low", "1.20.1"])
        self.assertEqual(
            [item["reason"] for item in dropped],
            ["limit_priority", "limit_version"],
        )

    def test_status_limit(self):
        kept, dropped, _ = labels.sanitize(
            ["needs info", "needs help"], "bug", self.cfg
        )
        self.assertEqual(kept, ["needs info"])
        self.assertEqual(dropped[0]["reason"], "limit_status")

    def test_case_and_whitespace_are_normalized(self):
        kept, dropped, issue_type = labels.sanitize(
            ["  Crash ", "SCOPE:   MACHINE", "Priority:  High"], " BUG ", self.cfg
        )
        self.assertEqual(issue_type, "bug")
        self.assertEqual(kept, ["crash", "scope: machine", "priority: high"])
        self.assertEqual(dropped, [])

    def test_missing_space_after_colon_is_normalized(self):
        kept, dropped, _ = labels.sanitize(
            ["scope:machine", "priority:low"], "bug", self.cfg
        )
        self.assertEqual(kept, ["scope: machine", "priority: low"])
        self.assertEqual(dropped, [])

    def test_invalid_type_drops_kind_labels(self):
        kept, dropped, issue_type = labels.sanitize(["crash", "1.21.1"], "nonsense", self.cfg)
        self.assertEqual(issue_type, "unknown")
        self.assertEqual(kept, ["1.21.1"])
        self.assertEqual(dropped[0]["reason"], "kind_without_type")

    def test_unknown_type_is_allowed(self):
        kept, dropped, issue_type = labels.sanitize(["needs info"], "unknown", self.cfg)
        self.assertEqual(issue_type, "unknown")
        self.assertEqual(kept, ["needs info"])
        self.assertEqual(dropped, [])

    def test_fallback_uses_write_only_without_axes(self):
        cfg = {"triage": {"write_only": ["crash"]}}
        kept, dropped, _ = labels.sanitize(["crash", "wontfix"], "bug", cfg)
        self.assertEqual(kept, ["crash"])
        self.assertEqual(dropped, [{"label": "wontfix", "reason": "not_allowed"}])

    def test_full_gate_drops_duplicates_and_over_limit(self):
        kept, dropped, issue_type = labels.sanitize(
            [
                "bug",
                "enhancement",
                "crash",
                "qol",
                "scope: machine",
                "scope: recipe",
                "scope: ui",
                "priority: low",
                "priority: high",
                "1.20.1",
                "1.21.1",
                "needs triage",
                "wontfix",
            ],
            "bug",
            self.cfg,
        )
        self.assertEqual(issue_type, "bug")
        self.assertEqual(
            kept,
            ["crash", "scope: machine", "scope: recipe", "priority: low", "1.20.1"],
        )
        self.assertEqual(
            [item["reason"] for item in dropped],
            [
                "type_in_labels",
                "type_in_labels",
                "kind_not_for_bug",
                "limit_scope",
                "limit_priority",
                "limit_version",
                "not_allowed",
                "not_allowed",
            ],
        )


if __name__ == "__main__":
    unittest.main()
