import json
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import responses_bridge as bridge  # noqa: E402


def collect_events(frames: list[str]) -> list[tuple[str, dict]]:
    events = []
    for frame in frames:
        for block in frame.split("\n\n"):
            if not block.strip():
                continue
            lines = block.splitlines()
            name = next((line[7:] for line in lines if line.startswith("event: ")), "")
            data = next((line[6:] for line in lines if line.startswith("data: ")), "")
            events.append((name, json.loads(data) if data else {}))
    return events


class Collector:
    def __init__(self):
        self.frames: list[str] = []

    def write(self, data: bytes) -> None:
        self.frames.append(data.decode("utf-8"))

    def flush(self) -> None:
        pass


class FakeUpstream:
    def __init__(self, lines: list[str], content_type: str = "text/event-stream"):
        self.lines = [line.encode("utf-8") + b"\n" for line in lines]
        self.headers = {"Content-Type": content_type}

    def __iter__(self):
        return iter(self.lines)

    def read(self) -> bytes:
        return b"".join(self.lines)

    def close(self) -> None:
        pass


class ConvertInputTest(unittest.TestCase):
    def test_string_input(self):
        self.assertEqual(
            bridge.convert_input({"input": "hi"}),
            [{"role": "user", "content": "hi"}],
        )

    def test_message_roles_and_text_parts(self):
        messages = bridge.convert_input(
            {
                "input": [
                    {
                        "type": "message",
                        "role": "developer",
                        "content": [{"type": "input_text", "text": "rules"}],
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "hi"}],
                    },
                ]
            }
        )
        self.assertEqual(messages[0], {"role": "system", "content": "rules"})
        self.assertEqual(messages[1], {"role": "user", "content": "hi"})

    def test_developer_role_maps_to_system(self):
        messages = bridge.convert_input(
            {
                "input": [
                    {
                        "type": "message",
                        "role": "developer",
                        "content": [{"type": "input_text", "text": "rules"}],
                    }
                ]
            }
        )
        self.assertEqual(messages, [{"role": "system", "content": "rules"}])

    def test_function_call_and_output_round_trip(self):
        messages = bridge.convert_input(
            {
                "input": [
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "run"}]},
                    {
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "exec_command",
                        "arguments": '{"cmd":"ls"}',
                    },
                    {"type": "function_call_output", "call_id": "call-1", "output": "file.txt"},
                ]
            }
        )
        self.assertEqual(messages[1]["role"], "assistant")
        self.assertIsNone(messages[1]["content"])
        self.assertEqual(messages[1]["tool_calls"][0]["id"], "call-1")
        self.assertEqual(messages[1]["tool_calls"][0]["function"]["name"], "exec_command")
        self.assertEqual(
            messages[2],
            {"role": "tool", "tool_call_id": "call-1", "content": "file.txt"},
        )

    def test_reasoning_items_are_dropped(self):
        messages = bridge.convert_input(
            {
                "input": [
                    {"type": "reasoning", "summary": []},
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                ]
            }
        )
        self.assertEqual(messages, [{"role": "user", "content": "hi"}])

    def test_instructions_become_system_message(self):
        messages = bridge.convert_input({"instructions": "be terse", "input": "hi"})
        self.assertEqual(messages[0], {"role": "system", "content": "be terse"})


class ConvertToolsTest(unittest.TestCase):
    TOOLS = [
        {
            "type": "function",
            "name": "exec_command",
            "description": "run a command",
            "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
        },
        {
            "type": "namespace",
            "name": "multi_agent_v1",
            "tools": [
                {"type": "function", "name": "spawn_agent", "description": "spawn"},
            ],
        },
        {"type": "web_search"},
    ]

    def test_namespace_is_dropped(self):
        tools = bridge.convert_tools(self.TOOLS)
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0]["function"]["name"], "exec_command")

    def test_tool_choice_mapping(self):
        self.assertEqual(bridge.convert_tool_choice("auto"), "auto")
        self.assertEqual(
            bridge.convert_tool_choice({"type": "function", "name": "exec_command"}),
            {"type": "function", "function": {"name": "exec_command"}},
        )
        self.assertIsNone(bridge.convert_tool_choice({"type": "namespace"}))


class ConvertRequestTest(unittest.TestCase):
    def test_drops_responses_only_fields(self):
        chat = bridge.convert_request(
            {
                "model": "m",
                "stream": True,
                "input": "hi",
                "store": False,
                "include": ["reasoning.encrypted_content"],
                "prompt_cache_key": "cache",
                "client_metadata": {"a": 1},
                "reasoning": {"effort": "high", "summary": "auto"},
                "max_output_tokens": 123,
            }
        )
        for key in ("store", "include", "prompt_cache_key", "client_metadata"):
            self.assertNotIn(key, chat)
        self.assertEqual(chat["reasoning_effort"], "high")
        self.assertEqual(chat["max_tokens"], 123)
        self.assertEqual(chat["stream_options"], {"include_usage": True})

    def test_json_schema_maps_to_response_format(self):
        chat = bridge.convert_request(
            {
                "input": "hi",
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": "answer",
                        "schema": {"type": "object"},
                        "strict": True,
                    }
                },
            }
        )
        self.assertEqual(chat["response_format"]["type"], "json_schema")
        self.assertEqual(chat["response_format"]["json_schema"]["name"], "answer")


class UsageTest(unittest.TestCase):
    def test_maps_reasoning_tokens(self):
        usage = bridge.map_usage(
            {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "completion_tokens_details": {"reasoning_tokens": 3},
            }
        )
        self.assertEqual(usage["input_tokens"], 10)
        self.assertEqual(usage["output_tokens"], 5)
        self.assertEqual(usage["output_tokens_details"]["reasoning_tokens"], 3)


class StreamTranslateTest(unittest.TestCase):
    def run_lines(self, lines: list[str]) -> list[tuple[str, dict]]:
        collector = Collector()
        emitter = bridge.Emitter(collector.write, collector.flush)
        bridge.translate_stream(FakeUpstream(lines), emitter, "m")
        return collect_events(collector.frames)

    def test_text_stream_emits_done_then_completed(self):
        events = self.run_lines(
            [
                'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
                'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
                'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
                'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
                "data: [DONE]",
            ]
        )
        names = [name for name, _ in events]
        self.assertEqual(names[0], "response.created")
        self.assertIn("response.output_item.done", names)
        self.assertIn("response.completed", names)
        self.assertLess(names.index("response.output_item.done"), names.index("response.completed"))
        done = next(data for name, data in events if name == "response.output_item.done")
        self.assertEqual(done["item"]["content"][0]["text"], "Hello world")
        completed = next(data for name, data in events if name == "response.completed")
        self.assertEqual(completed["response"]["usage"]["input_tokens"], 10)
        self.assertEqual(completed["response"]["usage"]["output_tokens"], 5)

    def test_tool_call_stream_is_reassembled(self):
        events = self.run_lines(
            [
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"exec_command","arguments":""}}]},"finish_reason":null}]}',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
                "data: [DONE]",
            ]
        )
        done = next(data for name, data in events if name == "response.output_item.done")
        self.assertEqual(done["item"]["type"], "function_call")
        self.assertEqual(done["item"]["call_id"], "call-1")
        self.assertEqual(done["item"]["name"], "exec_command")
        self.assertEqual(done["item"]["arguments"], '{"cmd":"ls"}')
        completed = next(data for name, data in events if name == "response.completed")
        self.assertEqual(completed["response"]["output"][0]["type"], "function_call")

    def test_upstream_error_emits_failed(self):
        events = self.run_lines(['data: {"error":{"message":"boom"}}'])
        self.assertEqual([name for name, _ in events], ["response.created", "response.failed"])

    def test_tool_call_before_text_keeps_indices_unique(self):
        events = self.run_lines(
            [
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"exec_command","arguments":"{}"}}]},"finish_reason":null}]}',
                'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
                "data: [DONE]",
            ]
        )
        done = [data for name, data in events if name == "response.output_item.done"]
        self.assertEqual(sorted(item["output_index"] for item in done), [0, 1])


class NonStreamTest(unittest.TestCase):
    def test_message_and_tool_calls(self):
        response = bridge.translate_nonstream(
            {
                "choices": [
                    {
                        "message": {
                            "content": "ok",
                            "tool_calls": [
                                {
                                    "id": "call-1",
                                    "function": {"name": "exec_command", "arguments": '{"cmd":"ls"}'},
                                }
                            ],
                        }
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
            },
            "m",
        )
        self.assertEqual(response["status"], "completed")
        self.assertEqual(response["output"][0]["content"][0]["text"], "ok")
        self.assertEqual(response["output"][1]["type"], "function_call")
        self.assertEqual(response["usage"]["total_tokens"], 3)


class FakeChatHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for chunk in (
            {"choices": [{"delta": {"content": "Hello"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": " world"}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}},
        ):
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


class HttpRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeChatHandler)
        self.upstream.daemon_threads = True
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        upstream_url = f"http://127.0.0.1:{self.upstream.server_address[1]}/v1"
        self.bridge = bridge.build_server(
            port=0,
            upstream=upstream_url,
            api_key="dummy",
            model="m",
            headers={"X-Response-Format": "openai"},
        )
        threading.Thread(target=self.bridge.serve_forever, daemon=True).start()

    def tearDown(self):
        self.bridge.shutdown()
        self.bridge.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()

    def test_streaming_response_contains_completed_event(self):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.bridge.server_address[1]}/v1/responses",
            data=json.dumps({"model": "m", "stream": True, "input": "hi"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer dummy"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
        self.assertIn("event: response.output_item.done", body)
        self.assertIn("event: response.completed", body)
        self.assertIn("Hello world", body)


class FakeJsonChatHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        body = json.dumps(
            {
                "choices": [{"message": {"content": "Hello world"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True


class JsonFallbackTest(unittest.TestCase):
    def setUp(self):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeJsonChatHandler)
        self.upstream.daemon_threads = True
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.bridge = bridge.build_server(
            port=0,
            upstream=f"http://127.0.0.1:{self.upstream.server_address[1]}/v1",
            api_key="dummy",
            model="m",
            headers={},
        )
        threading.Thread(target=self.bridge.serve_forever, daemon=True).start()

    def tearDown(self):
        self.bridge.shutdown()
        self.bridge.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()

    def test_non_sse_upstream_still_emits_item_done(self):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.bridge.server_address[1]}/v1/responses",
            data=json.dumps({"model": "m", "stream": True, "input": "hi"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer dummy"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
        self.assertIn("event: response.output_item.done", body)
        self.assertIn("event: response.completed", body)
        self.assertIn("Hello world", body)


if __name__ == "__main__":
    unittest.main()
