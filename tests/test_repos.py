import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import common  # noqa: E402


class RepoConfigTest(unittest.TestCase):
    def test_lookup_is_case_insensitive_and_merges_bot(self):
        cfg = common.load_repo("Tanimodori/GregTech6")
        self.assertEqual(cfg["_repo"], "Tanimodori/GregTech6")
        self.assertEqual(cfg["_key"], "tanimodori/gregtech6")
        self.assertEqual(cfg["bot_login"], "lily-chan-bot[bot]")
        self.assertEqual(cfg["bot_mention"], "@lily-chan-bot")
        self.assertTrue(cfg["enabled"])
        self.assertNotIn("issue_repo", cfg)
        self.assertNotIn("app_key_env", cfg)

    def test_disabled_repo_is_still_known(self):
        cfg = common.load_repo("GregTech6CE/GregTech6")
        self.assertFalse(cfg["enabled"])

    def test_unknown_repo_fails_closed(self):
        with self.assertRaises(SystemExit):
            common.load_repo("attacker/unknown")


if __name__ == "__main__":
    unittest.main()
