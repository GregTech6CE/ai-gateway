#!/usr/bin/env python3
"""把 Codex 的 Responses 请求翻译成 Chat Completions。仅使用标准库。

Codex CLI 自 0.95.0 起只接受 `wire_api = "responses"`；只提供
`POST /chat/completions` 的上游需要一层协议翻译。本模块只覆盖 analysis job 实际用到的
子集：文本、function tools、流式、usage 与错误映射。

设计取舍：

- `store`、`include`、`prompt_cache_key`、`client_metadata`、`reasoning.summary` 直接丢弃。
  Codex 固定发 `store: false`，不依赖服务端会话状态；这些字段在 chat 协议里没有等价物。
- `type: "namespace"` 工具直接丢弃。analysis 的提示词不使用 multi-agent，保留它反而会
  让模型调用一个 chat 上游无法表达的工具。
- 只监听 `127.0.0.1`；key 从环境变量读取，不写日志、不回显。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable

DEFAULT_MODEL = ""
DEFAULT_TIMEOUT = 600


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def _now() -> int:
    return int(time.time())


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False)


def _content_to_chat(content: Any) -> Any:
    """Responses 的 content 数组转 chat 的字符串或 content part 数组。

    纯文本消息合并成一个字符串：多数 chat 上游对字符串最宽容，也避免把多个
    `input_text` 块拆成上游不认识的数组。带图片时才保留数组。
    """
    if content is None:
        return None
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return _stringify(content)
    texts: list[str] = []
    parts: list[dict] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        if kind in ("input_text", "output_text", "text"):
            text = part.get("text")
            if isinstance(text, str):
                texts.append(text)
        elif kind == "input_image":
            url = part.get("image_url")
            if isinstance(url, dict):
                url = url.get("url")
            if url:
                parts.append({"type": "image_url", "image_url": {"url": url}})
    if parts:
        if texts:
            parts.insert(0, {"type": "text", "text": "".join(texts)})
        return parts
    if not texts:
        return None
    return texts[0] if len(texts) == 1 else "\n".join(texts)


def convert_input(payload: dict) -> list[dict]:
    """把 Responses 的 `input` 转成 chat 的 `messages`。"""
    messages: list[dict] = []
    instructions = payload.get("instructions")
    if isinstance(instructions, str) and instructions.strip():
        messages.append({"role": "system", "content": instructions})

    raw = payload.get("input")
    if isinstance(raw, str):
        messages.append({"role": "user", "content": raw})
        return messages
    if not isinstance(raw, list):
        return messages

    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "message":
            content = _content_to_chat(item.get("content"))
            if content is None:
                continue
            role = item.get("role") or "user"
            if role == "developer":
                role = "system"
            messages.append({"role": role, "content": content})
        elif kind == "function_call":
            arguments = item.get("arguments")
            if not isinstance(arguments, str):
                arguments = _stringify(arguments or {})
            call = {
                "id": item.get("call_id") or item.get("id") or _id("call"),
                "type": "function",
                "function": {"name": item.get("name") or "", "arguments": arguments},
            }
            if messages and messages[-1].get("role") == "assistant" and messages[-1].get("tool_calls"):
                messages[-1]["tool_calls"].append(call)
            else:
                messages.append({"role": "assistant", "content": None, "tool_calls": [call]})
        elif kind == "function_call_output":
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": item.get("call_id") or "",
                    "content": _stringify(item.get("output")),
                }
            )
        # reasoning / item_reference / 未知类型：chat 协议没有等价物，丢弃。
    return messages


def convert_tools(tools: Any) -> list[dict]:
    out: list[dict] = []
    for tool in tools or []:
        if not isinstance(tool, dict) or tool.get("type") != "function":
            # namespace / web_search / custom：chat 协议没有等价物，丢弃。
            continue
        function = {
            "name": tool.get("name") or "",
            "description": tool.get("description") or "",
            "parameters": tool.get("parameters") or {"type": "object", "properties": {}},
        }
        if "strict" in tool:
            function["strict"] = bool(tool["strict"])
        out.append({"type": "function", "function": function})
    return out


def convert_tool_choice(choice: Any) -> Any:
    if isinstance(choice, str):
        return choice
    if isinstance(choice, dict) and choice.get("type") == "function" and choice.get("name"):
        return {"type": "function", "function": {"name": choice["name"]}}
    return None


def convert_request(
    payload: dict,
    default_model: str = DEFAULT_MODEL,
    include_usage: bool = True,
) -> dict:
    """Responses 请求体转 chat 请求体。"""
    chat: dict[str, Any] = {
        "model": payload.get("model") or default_model,
        "messages": convert_input(payload),
        "stream": bool(payload.get("stream", False)),
    }
    tools = convert_tools(payload.get("tools"))
    if tools:
        chat["tools"] = tools
    choice = convert_tool_choice(payload.get("tool_choice"))
    if choice is not None:
        chat["tool_choice"] = choice
    if "parallel_tool_calls" in payload:
        chat["parallel_tool_calls"] = bool(payload["parallel_tool_calls"])
    if payload.get("max_output_tokens") is not None:
        chat["max_tokens"] = int(payload["max_output_tokens"])
    for key in ("temperature", "top_p", "user"):
        if payload.get(key) is not None:
            chat[key] = payload[key]

    reasoning = payload.get("reasoning")
    if isinstance(reasoning, dict) and reasoning.get("effort"):
        chat["reasoning_effort"] = reasoning["effort"]

    text = payload.get("text")
    if isinstance(text, dict) and isinstance(text.get("format"), dict):
        fmt = text["format"]
        if fmt.get("type") == "json_schema":
            chat["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": fmt.get("name") or "answer",
                    "schema": fmt.get("schema") or {},
                    "strict": bool(fmt.get("strict", True)),
                },
            }
        elif fmt.get("type") == "json_object":
            chat["response_format"] = {"type": "json_object"}

    if chat["stream"] and include_usage:
        chat["stream_options"] = {"include_usage": True}
    return chat


def map_usage(usage: Any) -> dict | None:
    if not isinstance(usage, dict):
        return None
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    total = int(usage.get("total_tokens") or prompt + completion)
    out: dict[str, Any] = {
        "input_tokens": prompt,
        "output_tokens": completion,
        "total_tokens": total,
    }
    details = usage.get("completion_tokens_details")
    if isinstance(details, dict) and details.get("reasoning_tokens") is not None:
        out["output_tokens_details"] = {"reasoning_tokens": int(details["reasoning_tokens"])}
    prompt_details = usage.get("prompt_tokens_details")
    if isinstance(prompt_details, dict) and prompt_details.get("cached_tokens") is not None:
        out["input_tokens_details"] = {"cached_tokens": int(prompt_details["cached_tokens"])}
    return out


class Emitter:
    """按 Responses 的 SSE 形状写出事件。"""

    def __init__(self, write, flush):
        self._write = write
        self._flush = flush
        self.sequence = 0

    def send(self, event_type: str, data: dict) -> None:
        payload = {"type": event_type, **data, "sequence_number": self.sequence}
        self.sequence += 1
        frame = f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        self._write(frame.encode("utf-8"))
        self._flush()

    def fail(self, message: str, response_id: str = "", model: str = "") -> None:
        self.send(
            "response.failed",
            {
                "response": {
                    "id": response_id or _id("resp"),
                    "object": "response",
                    "created_at": _now(),
                    "status": "failed",
                    "model": model,
                    "output": [],
                    "error": {"code": "upstream_error", "message": message[:500]},
                }
            },
        )


def _response_base(response_id: str, model: str, status: str, output: list, usage) -> dict:
    return {
        "id": response_id,
        "object": "response",
        "created_at": _now(),
        "status": status,
        "model": model,
        "output": output,
        "usage": usage,
    }


def translate_stream(upstream, emitter: Emitter, model: str) -> None:
    """读取 chat SSE，按 Responses 事件序列转发。

    Codex 0.166/0.167 的最小可用序列是 `response.output_item.done` +
    `response.completed`；这里额外发 `created` / `added` / `delta` 等事件，供 TUI 与
    日志使用，不改变最小契约。
    """
    response_id = _id("resp")
    emitter.send(
        "response.created",
        {"response": _response_base(response_id, model, "in_progress", [], None)},
    )

    text_parts: list[str] = []
    text_item_id: str | None = None
    text_output_index = 0
    tool_items: dict[int, dict] = {}
    usage = None
    output_count = 0

    def next_output_index() -> int:
        nonlocal output_count
        index = output_count
        output_count += 1
        return index

    for raw in upstream:
        line = raw.decode("utf-8", "replace").strip()
        if not line or line.startswith(":") or line.startswith("event:"):
            continue
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(chunk, dict) and chunk.get("error"):
            emitter.fail(_stringify(chunk["error"]), response_id, model)
            return
        if isinstance(chunk, dict) and chunk.get("usage"):
            usage = chunk["usage"]

        for choice in (chunk.get("choices") or []) if isinstance(chunk, dict) else []:
            delta = choice.get("delta") or {}
            content = delta.get("content")
            if content:
                if text_item_id is None:
                    text_item_id = _id("msg")
                    text_output_index = next_output_index()
                    emitter.send(
                        "response.output_item.added",
                        {
                            "output_index": text_output_index,
                            "item": {
                                "id": text_item_id,
                                "type": "message",
                                "status": "in_progress",
                                "role": "assistant",
                                "content": [],
                            },
                        },
                    )
                    emitter.send(
                        "response.content_part.added",
                        {
                            "item_id": text_item_id,
                            "output_index": text_output_index,
                            "content_index": 0,
                            "part": {"type": "output_text", "text": "", "annotations": []},
                        },
                    )
                text_parts.append(content)
                emitter.send(
                    "response.output_text.delta",
                    {
                        "item_id": text_item_id,
                        "output_index": text_output_index,
                        "content_index": 0,
                        "delta": content,
                    },
                )

            for call in delta.get("tool_calls") or []:
                index = int(call.get("index", 0))
                item = tool_items.get(index)
                function = call.get("function") or {}
                if item is None:
                    item = {
                        "id": _id("fc"),
                        "call_id": call.get("id") or _id("call"),
                        "name": function.get("name") or "",
                        "arguments": "",
                        "output_index": next_output_index(),
                    }
                    tool_items[index] = item
                    emitter.send(
                        "response.output_item.added",
                        {
                            "output_index": item["output_index"],
                            "item": {
                                "id": item["id"],
                                "type": "function_call",
                                "status": "in_progress",
                                "call_id": item["call_id"],
                                "name": item["name"],
                                "arguments": "",
                            },
                        },
                    )
                if call.get("id") and not item["call_id"]:
                    item["call_id"] = call["id"]
                if function.get("name") and not item["name"]:
                    item["name"] = function["name"]
                arguments = function.get("arguments")
                if arguments:
                    item["arguments"] += arguments
                    emitter.send(
                        "response.function_call_arguments.delta",
                        {
                            "item_id": item["id"],
                            "output_index": item["output_index"],
                            "delta": arguments,
                        },
                    )

    output: list[tuple[int, dict]] = []
    if text_item_id is not None:
        text = "".join(text_parts)
        emitter.send(
            "response.output_text.done",
            {
                "item_id": text_item_id,
                "output_index": text_output_index,
                "content_index": 0,
                "text": text,
            },
        )
        emitter.send(
            "response.content_part.done",
            {
                "item_id": text_item_id,
                "output_index": text_output_index,
                "content_index": 0,
                "part": {"type": "output_text", "text": text, "annotations": []},
            },
        )
        text_item = {
            "id": text_item_id,
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text, "annotations": []}],
        }
        emitter.send(
            "response.output_item.done",
            {"output_index": text_output_index, "item": text_item},
        )
        output.append((text_output_index, text_item))

    for index in sorted(tool_items):
        item = tool_items[index]
        emitter.send(
            "response.function_call_arguments.done",
            {
                "item_id": item["id"],
                "output_index": item["output_index"],
                "arguments": item["arguments"],
            },
        )
        call_item = {
            "id": item["id"],
            "type": "function_call",
            "status": "completed",
            "call_id": item["call_id"],
            "name": item["name"],
            "arguments": item["arguments"],
        }
        emitter.send(
            "response.output_item.done",
            {"output_index": item["output_index"], "item": call_item},
        )
        output.append((item["output_index"], call_item))

    output.sort(key=lambda pair: pair[0])
    emitter.send(
        "response.completed",
        {
            "response": _response_base(
                response_id,
                model,
                "completed",
                [item for _, item in output],
                map_usage(usage),
            )
        },
    )


def translate_nonstream(data: dict, model: str) -> dict:
    message = ((data.get("choices") or [{}])[0].get("message") or {})
    output: list[dict] = []
    content = message.get("content")
    if content:
        output.append(
            {
                "id": _id("msg"),
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": content, "annotations": []}],
            }
        )
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        output.append(
            {
                "id": _id("fc"),
                "type": "function_call",
                "status": "completed",
                "call_id": call.get("id") or _id("call"),
                "name": function.get("name") or "",
                "arguments": function.get("arguments") or "",
            }
        )
    return _response_base(_id("resp"), model, "completed", output, map_usage(data.get("usage")))


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address,
        handler,
        *,
        upstream: str,
        api_key: str,
        model: str,
        headers: dict[str, str],
        timeout: int,
        include_usage: bool,
    ):
        super().__init__(address, handler)
        self.upstream = upstream.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.headers = headers
        self.timeout = timeout
        self.include_usage = include_usage


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "responses-bridge/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {fmt % args}\n")
        sys.stderr.flush()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(200, {"ok": True})
        elif path == "/v1/models":
            self._json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": self.server.model,
                            "object": "model",
                            "created": 0,
                            "owned_by": "responses-bridge",
                        }
                    ],
                },
            )
        else:
            self._error(404, "not found")

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path != "/v1/responses":
            self._error(404, "not found")
            return
        try:
            payload = json.loads(self._read_body() or b"{}")
        except Exception:
            self._error(400, "invalid json")
            return
        if not isinstance(payload, dict):
            self._error(400, "request body must be an object")
            return
        try:
            chat = convert_request(
                payload,
                default_model=self.server.model,
                include_usage=self.server.include_usage,
            )
        except Exception as exc:
            self._error(400, f"invalid request: {exc}")
            return
        try:
            upstream = self._open_upstream(chat)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            self._error(exc.code, detail, retry_after)
            return
        except Exception as exc:
            self._error(502, f"upstream error: {exc}")
            return
        try:
            if chat["stream"]:
                self._stream(upstream, chat["model"])
            else:
                self._nonstream(upstream, chat["model"])
        finally:
            upstream.close()

    def _read_body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks: list[bytes] = []
            while True:
                line = self.rfile.readline().strip()
                if not line:
                    break
                size = int(line.split(b";", 1)[0], 16)
                if size == 0:
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            return b"".join(chunks)
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _open_upstream(self, chat: dict):
        url = self.server.upstream + "/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.server.api_key}",
            "Content-Type": "application/json",
        }
        headers.update(self.server.headers)
        request = urllib.request.Request(
            url,
            data=json.dumps(chat, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        return urllib.request.urlopen(request, timeout=self.server.timeout)

    def _stream(self, upstream, model: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        emitter = Emitter(self.wfile.write, self.wfile.flush)
        content_type = upstream.headers.get("Content-Type", "")
        try:
            if "text/event-stream" not in content_type:
                data = json.loads(upstream.read().decode("utf-8", "replace"))
                if isinstance(data, dict) and data.get("error"):
                    emitter.fail(_stringify(data["error"]), "", model)
                else:
                    response = translate_nonstream(data, model)
                    for index, item in enumerate(response.get("output") or []):
                        emitter.send(
                            "response.output_item.done",
                            {"output_index": index, "item": item},
                        )
                    emitter.send("response.completed", {"response": response})
                return
            translate_stream(upstream, emitter, model)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            try:
                emitter.fail(f"{type(exc).__name__}: {exc}", "", model)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _nonstream(self, upstream, model: str) -> None:
        try:
            data = json.loads(upstream.read().decode("utf-8", "replace"))
        except Exception as exc:
            self._error(502, f"invalid upstream response: {exc}")
            return
        if isinstance(data, dict) and data.get("error"):
            self._error(502, _stringify(data["error"]))
            return
        try:
            response = translate_nonstream(data, model)
        except Exception as exc:
            self._error(502, f"invalid upstream response: {exc}")
            return
        self._json(200, response)

    def _json(self, status: int, payload: dict, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def _error(self, status: int, message: str, retry_after: str | None = None) -> None:
        self._json(
            status,
            {"error": {"message": message, "type": "bridge_error", "code": status}},
            {"Retry-After": retry_after} if retry_after else None,
        )


def build_server(
    *,
    port: int,
    upstream: str,
    api_key: str,
    model: str,
    headers: dict[str, str],
    timeout: int = DEFAULT_TIMEOUT,
    include_usage: bool = True,
) -> BridgeServer:
    return BridgeServer(
        ("127.0.0.1", port),
        Handler,
        upstream=upstream,
        api_key=api_key,
        model=model,
        headers=headers,
        timeout=timeout,
        include_usage=include_usage,
    )


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Translate OpenAI Responses requests to Chat Completions."
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--upstream", required=True, help="chat/completions base URL")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--api-key-env", default="MODEL_KEY_CLINEPASS")
    parser.add_argument(
        "--header",
        action="append",
        default=[],
        help="extra upstream header, e.g. 'X-Response-Format: openai'",
    )
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--no-include-usage", action="store_true")
    args = parser.parse_args(list(argv) if argv is not None else None)

    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        print(f"missing environment variable: {args.api_key_env}", file=sys.stderr)
        return 2

    headers: dict[str, str] = {}
    for raw in args.header:
        name, sep, value = raw.partition(":")
        if not sep:
            print(f"invalid header: {raw}", file=sys.stderr)
            return 2
        headers[name.strip()] = value.strip()

    server = build_server(
        port=args.port,
        upstream=args.upstream,
        api_key=api_key,
        model=args.model,
        headers=headers,
        timeout=args.timeout,
        include_usage=not args.no_include_usage,
    )
    host, port = server.server_address
    print(f"BRIDGE_PORT={port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
