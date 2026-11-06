import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import common  # noqa: E402


class RepoConfigTest(unittest.TestCase):
    def test_lookup_is_case_insensitive(self):
        for name in ("GregTech6CE/GregTech6", "gregtech6ce/gregtech6", " GREGTECH6CE/GREGTECH6 "):
            cfg = common.load_repo(name)
            self.assertEqual(cfg["_repo"], name)
            self.assertEqual(cfg["_key"], "gregtech6ce/gregtech6")
            self.assertTrue(cfg["enabled"])

    def test_entry_carries_its_own_bot_identity(self):
        cfg = common.load_repo("GregTech6CE/GregTech6")
        self.assertEqual(cfg["bot_login"], "gt6ce-bot[bot]")
        self.assertEqual(cfg["bot_mention"], "@gt6ce-bot")

    def test_unknown_repo_fails_closed(self):
        with self.assertRaises(SystemExit):
            common.load_repo("attacker/unknown")

    def test_empty_repo_fails_closed(self):
        with self.assertRaises(SystemExit):
            common.load_repo("")


if __name__ == "__main__":
    unittest.main()
