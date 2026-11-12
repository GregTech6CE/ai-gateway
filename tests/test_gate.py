"""`gate` 的配额口径与 `running` 移除：P0-4。

真正的行为覆盖要等 gate 拆出可注入的依赖（`now`/`gh`/`git`）之后才能写——现在 `main()`
是单块流程，只能靠起进程 + 假 API 才测得动。这里先钉住两件容易在重构里被悄悄改回来的事。
"""

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

BUDGETS = json.loads((ROOT / "config/budgets.json").read_text(encoding="utf-8"))["defaults"]


class BudgetKeyTest(unittest.TestCase):
    def test_requested_stale_window_exists(self):
        self.assertEqual(BUDGETS["requested_stale_minutes"], 70)

    def test_running_key_is_gone(self):
        self.assertNotIn("running_stale_minutes", BUDGETS)


class RunningMarkerTest(unittest.TestCase):
    def test_gate_does_not_reference_running_kind(self):
        # `running` 从来没有生产者，是纯死概念。删掉它的收益是让「在途」只有一个含义
        # （`requested` + 过期窗口）。有人若要重新引入，必须同时改这里和文档。
        source = (ROOT / "scripts/gate.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r'"running"', source))


if __name__ == "__main__":
    unittest.main()
