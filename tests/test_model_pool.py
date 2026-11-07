import os
import sys
import tempfile
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("REPO", "GregTech6CE/GregTech6")
os.environ.setdefault("ISSUE", "1")

import agent_supervisor as supervisor  # noqa: E402
import model_pool  # noqa: E402

POOL = {
    "endpoints": [{"id": "heavy"}, {"id": "light"}],
    "roles": {
        "analysis": [
            {"endpoint": "heavy", "weight": 120},
            {"endpoint": "light", "weight": 40},
        ]
    },
}


class SchedulingTest(unittest.TestCase):
    def setUp(self):
        self.state = {}

    def order(self):
        return [item["id"] for item in model_pool.candidates(POOL, "analysis", self.state, False)]

    def test_cold_start_prefers_heavier_weight(self):
        self.assertEqual(self.order(), ["heavy", "light"])

    def test_never_used_sorts_before_used(self):
        model_pool.mark_used(self.state, {"id": "heavy"})
        self.assertEqual(self.order(), ["light", "heavy"])

    def test_idle_time_is_capped_at_one_month(self):
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        pool = {
            "endpoints": [{"id": "a"}, {"id": "b"}],
            "roles": {
                "analysis": [
                    {"endpoint": "a", "weight": 1},
                    {"endpoint": "b", "weight": 1},
                ]
            },
        }
        self.state = {
            "endpoints": {
                "a": {"last_used_at": (now - timedelta(days=30)).isoformat()},
                "b": {"last_used_at": (now - timedelta(days=365)).isoformat()},
            }
        }
        with mock.patch.object(model_pool, "_now", side_effect=lambda: now):
            order = [item["id"] for item in model_pool.candidates(pool, "analysis", self.state, False)]
        # 两者都取上限值，得分相同，退回 id 序；没有上限时 b 会凭 365 天排前。
        self.assertEqual(order, ["a", "b"])

    def test_selection_ratio_follows_weight(self):
        clock = [datetime(2026, 1, 1, tzinfo=timezone.utc)]
        picks = Counter()
        with mock.patch.object(model_pool, "_now", side_effect=lambda: clock[0]):
            for _ in range(400):
                entry = model_pool.candidates(POOL, "analysis", self.state, False)[0]
                picks[entry["id"]] += 1
                model_pool.mark_used(self.state, entry)
                clock[0] += timedelta(minutes=1)
        self.assertEqual(picks["heavy"], 300)
        self.assertEqual(picks["light"], 100)

    def test_longer_gap_can_outweigh_heavier_endpoint(self):
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.state = {
            "endpoints": {
                "heavy": {"last_used_at": (now - timedelta(minutes=1)).isoformat()},
                "light": {"last_used_at": (now - timedelta(minutes=10)).isoformat()},
            }
        }
        with mock.patch.object(model_pool, "_now", side_effect=lambda: now):
            self.assertEqual(self.order()[0], "light")

    def test_zero_weight_is_last_among_untouched(self):
        pool = {
            "endpoints": [{"id": "off"}, {"id": "on"}],
            "roles": {
                "analysis": [
                    {"endpoint": "off", "weight": 0},
                    {"endpoint": "on", "weight": 10},
                ]
            },
        }
        order = [item["id"] for item in model_pool.candidates(pool, "analysis", {}, False)]
        self.assertEqual(order, ["on", "off"])


class ContextWindowTest(unittest.TestCase):
    def config_for(self, entry: dict) -> str:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(supervisor.c, "ROOT", Path(directory)):
                supervisor.write_codex_config(entry, "key")
                return (Path(directory) / ".codex" / "config.toml").read_text(encoding="utf-8")

    def test_missing_context_falls_back_to_one_million(self):
        text = self.config_for({"id": "x", "model": "m", "base_url": "u"})
        self.assertIn("model_context_window = 1048576", text)

    def test_declared_context_wins_over_default(self):
        text = self.config_for({"id": "x", "model": "m", "base_url": "u", "context": 131072})
        self.assertIn("model_context_window = 131072", text)

    def test_bridge_url_forces_responses(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(supervisor.c, "ROOT", Path(directory)):
                supervisor.write_codex_config(
                    {
                        "id": "x",
                        "model": "m",
                        "base_url": "https://upstream.example/v1",
                        "wire_api": "chat",
                    },
                    "key",
                    "http://127.0.0.1:1234/v1",
                )
                text = (Path(directory) / ".codex" / "config.toml").read_text(encoding="utf-8")
        self.assertIn('base_url = "http://127.0.0.1:1234/v1"', text)
        self.assertIn('wire_api = "responses"', text)


if __name__ == "__main__":
    unittest.main()
