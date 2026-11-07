import json
import os
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("REPO", "GregTech6CE/GregTech6")
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


class LogFormatTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = Path(self.tmp.name) / "supervisor.log"
        self.saved = supervisor.SUPERVISOR_LOG
        supervisor.SUPERVISOR_LOG = self.log

    def tearDown(self):
        supervisor.SUPERVISOR_LOG = self.saved
        self.tmp.cleanup()

    def test_exec_log_uses_bash_tag_and_cwd(self):
        supervisor.log_event("exec", cwd="/workspace/code/current", command="ls -la")
        line = self.log.read_text(encoding="utf-8").strip()
        self.assertIn("[BASH] /workspace/code/current $ ls -la", line)
        self.assertNotIn("[TOOL]", line)

    def test_heartbeat_log_uses_heartbeat_tag(self):
        supervisor.log_event(
            "heartbeat",
            attempt=1,
            elapsed_sec=30,
            turns=2,
            exec_count=1,
            answer_md_bytes=10,
            answer_json=False,
            repeats=0,
        )
        line = self.log.read_text(encoding="utf-8").strip()
        self.assertIn("[HEARTBEAT] attempt=1", line)
        self.assertNotIn("[SYSTEM]", line)
        self.assertNotIn("heartbeat：", line)

    def test_last_exec_command_parses_cwd(self):
        text = "codex\nreading\n\nexec\nls -la in /workspace/code/current\n"
        self.assertEqual(
            supervisor.last_exec_command(text),
            ("ls -la", "/workspace/code/current"),
        )

    def test_last_exec_command_without_cwd(self):
        self.assertEqual(supervisor.last_exec_command("exec\nls\n"), ("ls", ""))


class SecretScanTest(unittest.TestCase):
    PATCHED = (
        "OUTPUTS",
        "RESULT_PATH",
        "HEALTH_PATH",
        "SUPERVISOR_LOG",
        "ANSWER_JSON",
        "ANSWER_MD",
        "LOG_PATH",
    )

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.outputs = Path(self.tmp.name)
        self.saved = {name: getattr(supervisor, name) for name in self.PATCHED}
        supervisor.OUTPUTS = self.outputs
        supervisor.RESULT_PATH = self.outputs / "result.json"
        supervisor.HEALTH_PATH = self.outputs / "model_health.json"
        supervisor.SUPERVISOR_LOG = self.outputs / "supervisor.log"
        supervisor.ANSWER_JSON = self.outputs / "answer.json"
        supervisor.ANSWER_MD = self.outputs / "answer.md"
        supervisor.LOG_PATH = self.outputs / "agent_output.log"
        self.env = {name: os.environ.get(name) for name in supervisor.SECRET_ENVS}
        os.environ[supervisor.SECRET_ENVS[0]] = "mistral-secret-value-0001"
        os.environ[supervisor.SECRET_ENVS[1]] = "clinepass-secret-value-0002"

    def tearDown(self):
        for name, value in self.env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        for name, value in self.saved.items():
            setattr(supervisor, name, value)
        self.tmp.cleanup()

    def write(self, relative: str, text: str) -> Path:
        path = self.outputs / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        return path

    def test_scan_covers_archived_attempts_and_both_keys(self):
        archived = self.write("attempt-2/answer.md", "leak: clinepass-secret-value-0002\n")
        result = supervisor.scan_outputs()
        self.assertFalse(result["ok"])
        self.assertIn("attempt-2/answer.md", result["hits"])
        text = archived.read_text(encoding="utf-8")
        self.assertNotIn("clinepass-secret-value-0002", text)
        self.assertIn("[REDACTED]", text)

    def test_scan_redacts_pattern_in_place(self):
        path = self.write("prompt.txt", "token: Bearer " + "a" * 24 + " end\n")
        result = supervisor.scan_outputs()
        self.assertFalse(result["ok"])
        self.assertIn("prompt.txt", result["hits"])
        self.assertEqual(path.read_text(encoding="utf-8"), "token: [REDACTED] end\n")

    def test_scan_redacts_whole_pem_block(self):
        pem = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEowIBAAKCAQEA1234567890abcdefghij\n"
            "-----END RSA PRIVATE KEY-----\n"
        )
        path = self.write("leak.log", "before\n" + pem + "after\n")
        result = supervisor.scan_outputs()
        self.assertFalse(result["ok"])
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("MIIEowIBAAKCAQEA", text)
        self.assertNotIn("BEGIN RSA PRIVATE KEY", text)
        self.assertIn("before", text)
        self.assertIn("after", text)

    def test_scan_removes_truncated_pem(self):
        path = self.write(
            "cut.log", "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\n"
        )
        result = supervisor.scan_outputs()
        self.assertFalse(result["ok"])
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("MIIEowIBAAKCAQEAxyz", text)
        self.assertIn("before", text)

    def test_scan_drops_unreadable_tail_of_oversized_file(self):
        head = "x" * 30
        with mock.patch.object(supervisor, "MAX_SCAN_BYTES", 64):
            path = self.write(
                "huge.log", head + "\nmistral-secret-value-0001\n" + "y" * 200 + "\n"
            )
            result = supervisor.scan_outputs()
        self.assertFalse(result["ok"])
        self.assertIn("huge.log", result["hits"])
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("mistral-secret-value-0001", text)
        self.assertNotIn("y" * 20, text)
        self.assertIn("内容超过扫描上限", text)

    def test_scan_truncates_clean_oversized_file_without_hit(self):
        with mock.patch.object(supervisor, "MAX_SCAN_BYTES", 64):
            path = self.write("big.log", "clean line\n" * 20)
            result = supervisor.scan_outputs()
        self.assertTrue(result["ok"])
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("clean line\n" * 20, text)
        self.assertIn("内容超过扫描上限", text)

    def test_scan_leaves_clean_file_untouched(self):
        original = "clean line\n" * 40
        path = self.write("clean.log", original)
        self.assertTrue(supervisor.scan_outputs()["ok"])
        self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_scan_failure_blocks_and_discards_file(self):
        path = self.write("answer.md", "unscanned secret\n")
        with mock.patch.object(supervisor, "scan_file", side_effect=OSError("denied")):
            result = supervisor.scan_outputs()
        self.assertFalse(result["ok"])
        self.assertIn("answer.md（扫描失败）", result["hits"])
        self.assertEqual(result["failed"], ["answer.md"])
        self.assertNotIn("unscanned secret", path.read_text(encoding="utf-8"))

    def test_write_result_opens_upload_gate_only_when_scan_clean(self):
        gate = self.outputs / "gh_output"
        with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(gate)}):
            supervisor.write_result(
                {"status": "complete", "reason": "completed", "secret_scan": {"ok": True, "hits": [], "failed": []}},
                {"endpoints": {}},
                1,
            )
            self.assertIn("scan_upload=true", gate.read_text(encoding="utf-8"))
            supervisor.write_result(
                {"status": "complete", "reason": "completed", "secret_scan": {"ok": False, "hits": ["x"], "failed": ["x"]}},
                {"endpoints": {}},
                1,
            )
            self.assertIn("scan_upload=false", gate.read_text(encoding="utf-8"))

    def test_upload_gate_stays_open_when_only_hits(self):
        gate = self.outputs / "gh_output"
        with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(gate)}):
            supervisor.write_result(
                {"status": "failed", "reason": "x", "secret_scan": {"ok": False, "hits": ["answer.md"], "failed": []}},
                {"endpoints": {}},
                1,
            )
        self.assertIn("scan_upload=true", gate.read_text(encoding="utf-8"))

    def test_early_exit_path_scans_before_opening_gate(self):
        gate = self.outputs / "gh_output"
        self.write("log_digest.md", "clean\n")
        with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(gate)}):
            with mock.patch.object(supervisor, "scan_file", side_effect=OSError("denied")):
                supervisor.write_result({"status": "failed", "reason": "BOT_ENABLED=false"}, {"endpoints": {}}, 0)
        self.assertIn("scan_upload=false", gate.read_text(encoding="utf-8"))
        payload = json.loads(supervisor.RESULT_PATH.read_text(encoding="utf-8"))
        self.assertEqual(payload["secret_scan"]["failed"], ["log_digest.md"])

    def test_scan_skips_result_json(self):
        self.write("result.json", "mistral-secret-value-0001")
        self.assertTrue(supervisor.scan_outputs()["ok"])

    def test_merge_secret_scan_is_sticky_and_deduped(self):
        merged = supervisor.merge_secret_scan(
            {"ok": False, "hits": ["a.md"]}, {"ok": True, "hits": ["a.md", "b.md"]}
        )
        self.assertFalse(merged["ok"])
        self.assertEqual(merged["hits"], ["a.md", "b.md"])
        self.assertFalse(supervisor.merge_secret_scan(None, {"ok": False, "hits": ["x"]})["ok"])

    def test_write_result_scans_payload_and_excludes_itself(self):
        supervisor.write_result(
            {"status": "failed", "reason": "auth 401 mistral-secret-value-0001", "turns": 0},
            {"endpoints": {}},
            1,
        )
        text = supervisor.RESULT_PATH.read_text(encoding="utf-8")
        self.assertNotIn("mistral-secret-value-0001", text)
        payload = json.loads(text)
        self.assertFalse(payload["secret_scan"]["ok"])
        self.assertIn("result.json", payload["secret_scan"]["hits"])

    def test_write_result_keeps_clean_payload_ok(self):
        supervisor.write_result({"status": "complete", "reason": "completed"}, {"endpoints": {}}, 1)
        payload = json.loads(supervisor.RESULT_PATH.read_text(encoding="utf-8"))
        self.assertTrue(payload["secret_scan"]["ok"])
        self.assertEqual(payload["secret_scan"]["hits"], [])

    def test_write_result_log_hides_pattern_reason(self):
        supervisor.write_result(
            {"status": "failed", "reason": "upstream said Bearer " + "b" * 24, "turns": 0},
            {"endpoints": {}},
            1,
        )
        log = supervisor.SUPERVISOR_LOG.read_text(encoding="utf-8")
        self.assertNotIn("b" * 24, log)
        self.assertIn("REDACTED", log)

    def test_log_event_scrubs_suspected_lines(self):
        supervisor.log_event("exec", message="echo mistral-secret-value-0001")
        supervisor.log_event("exec", message="curl -H 'Authorization: Bearer " + "c" * 24 + "'")
        log = supervisor.SUPERVISOR_LOG.read_text(encoding="utf-8")
        self.assertNotIn("mistral-secret-value-0001", log)
        self.assertNotIn("c" * 24, log)
        self.assertIn("[REDACTED]", log)


class RunCodexTest(unittest.TestCase):
    """运行期只保证两件事：正常跑完能计数，停滞时按上限终止。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        outputs = root / "outputs"
        outputs.mkdir()
        self.root = root

        for name, value in {
            "OUTPUTS": outputs,
            "LOG_PATH": outputs / "agent_output.log",
            "ANSWER_MD": outputs / "answer.md",
            "ANSWER_JSON": outputs / "answer.json",
            "SUPERVISOR_LOG": outputs / "supervisor.log",
        }.items():
            patcher = mock.patch.object(supervisor, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        # 只验证运行期看门狗，不写仓库内的 .codex/config.toml。
        config = mock.patch.object(
            supervisor,
            "write_codex_config",
            lambda entry, key, bridge_base_url=None: {
                "CODEX_HOME": str(root),
                "LLM_API_KEY": key,
                "GH_TOKEN": "",
            },
        )
        config.start()
        self.addCleanup(config.stop)

        budget = mock.patch.dict(
            supervisor.budget["l2"], {"stall_seconds": 1, "timeout_minutes": 1}
        )
        budget.start()
        self.addCleanup(budget.stop)

    def fake_codex(self, body: str) -> None:
        script = self.root / "fake_codex.py"
        script.write_text(body, encoding="utf-8")
        patcher = mock.patch.object(supervisor, "CODEX_BIN", (sys.executable, str(script)))
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_once(self) -> dict:
        entry = {"id": "fake", "model": "fake-model"}
        return supervisor.run_codex(entry, "key", time.monotonic() + 60, 1)

    def test_stalled_process_is_terminated(self):
        self.fake_codex("import time\ntime.sleep(30)\n")
        result = self.run_once()
        self.assertIn("no output for", result["reason"])
        self.assertEqual(result["status"], "failed")

    def test_output_is_counted(self):
        self.fake_codex('print("codex")\nprint("reading the log")\nprint("exec")\nprint("ls")\n')
        result = self.run_once()
        self.assertEqual(result["turns"], 1)

    def test_exec_log_uses_bash_format(self):
        self.fake_codex(
            'import time\n'
            'print("codex", flush=True)\n'
            'print("reading the log", flush=True)\n'
            'print("exec", flush=True)\n'
            'print("echo hi in /workspace/code/current", flush=True)\n'
            'time.sleep(3)\n'
        )
        with mock.patch.dict(
            supervisor.budget["l2"], {"stall_seconds": 5, "timeout_minutes": 1}
        ):
            self.run_once()
        log = supervisor.SUPERVISOR_LOG.read_text(encoding="utf-8")
        self.assertIn("[BASH] /workspace/code/current $ echo hi", log)
        self.assertNotIn("[TOOL]", log)


class PreflightTest(unittest.TestCase):
    """入口可用性由 preflight 轮判定，而不是正常对话的第一轮。"""

    def setUp(self):
        for name, value in {
            "prompt_text": lambda kind: "分类提示词",
            "relevance_text": lambda: "标题：某 issue",
        }.items():
            patcher = mock.patch.object(supervisor, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def chat_returning(self, content):
        return mock.patch.object(supervisor.model_pool, "chat", return_value=content)

    def test_transport_failure_is_raised(self):
        error = supervisor.model_pool.ModelError("rate", 429, 0, "too many")
        with mock.patch.object(supervisor.model_pool, "chat", side_effect=error):
            with self.assertRaises(supervisor.model_pool.ModelError):
                supervisor.classify_relevance({"id": "e"}, "key")

    def test_unparsable_answer_still_counts_as_reachable(self):
        with self.chat_returning("not json at all"):
            self.assertIsNone(supervisor.classify_relevance({"id": "e"}, "key"))

    def test_category_is_parsed(self):
        payload = '{"relevance": "spam", "confidence": 0.97, "reason": "广告"}'
        with self.chat_returning(payload):
            result = supervisor.classify_relevance({"id": "e"}, "key")
        self.assertEqual(result["relevance"], "spam")
        self.assertAlmostEqual(result["confidence"], 0.97)


class ConfigErrorTest(unittest.TestCase):
    def test_unsupported_wire_api_is_config_error(self):
        log = (
            'Error loading config.toml: `wire_api = "chat"` is no longer supported.\n'
            'in `model_providers.clinepass.wire_api`\n'
        )
        error = supervisor.classify_log(log)
        self.assertIsNotNone(error)
        self.assertEqual(error.kind, "config")


class BridgeStartTest(unittest.TestCase):
    def test_bridge_starts_serves_health_and_stops(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(supervisor, "BRIDGE_LOG", Path(directory) / "bridge.log"):
                with mock.patch.dict(os.environ, {"MODEL_KEY_CLINEPASS": "dummy"}):
                    bridge = supervisor.start_bridge(
                        {
                            "id": "clinepass",
                            "base_url": "http://127.0.0.1:9/v1",
                            "model": "m",
                            "api_key_env": "MODEL_KEY_CLINEPASS",
                            "headers": {"X-Response-Format": "openai"},
                        }
                    )
                    try:
                        with urllib.request.urlopen(
                            f"http://127.0.0.1:{bridge.port}/health", timeout=5
                        ) as response:
                            self.assertEqual(response.status, 200)
                    finally:
                        bridge.stop()
                    self.assertIsNotNone(bridge.process.poll())


if __name__ == "__main__":
    unittest.main()
