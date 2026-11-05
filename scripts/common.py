"""GT6 分析 bot 的共享工具。仅使用 Python 标准库。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = "https://api.github.com"


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise SystemExit(f"missing environment variable: {name}")
    return value


def load_json(path: str | Path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def dump_json(path: str | Path, obj) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def request(method: str, path: str, token: str, data=None, timeout: int = 30):
    url = path if path.startswith("http") else API + path
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "lily-chan-bot",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"GitHub API {method} {path} -> {exc.code}: {detail}") from None


def paginate(path: str, token: str, max_pages: int = 10):
    sep = "&" if "?" in path else "?"
    items: list = []
    for page in range(1, max_pages + 1):
        chunk = request("GET", f"{path}{sep}per_page=100&page={page}", token)
        if not isinstance(chunk, list) or not chunk:
            break
        items.extend(chunk)
        if len(chunk) < 100:
            break
    return items


def load_repo(repo: str):
    real = ROOT / "config/repos.json"
    if not real.exists():
        raise SystemExit("config/repos.json missing; copy config/repos.example.json")
    data = load_json(real)
    key = str(repo or "").strip().lower()
    entry = (data.get("repos") or {}).get(key)
    if entry is None:
        raise SystemExit(f"unknown repo: {repo}")
    entry = dict(entry)
    entry["_repo"] = repo
    entry["_key"] = key
    bot = data.get("bot") or {}
    entry["bot_login"] = entry.get("bot_login", bot.get("login", ""))
    entry["bot_mention"] = entry.get("bot_mention", bot.get("mention", ""))
    return entry


def budgets():
    return load_json(ROOT / "config/budgets.json")["defaults"]


MARKER_RE = re.compile(r"<!--\s*lily:([a-z]+)\s+([^>]*?)-->", re.S)
FIELD_RE = re.compile(r"([a-z_]+)=([^\s]+)")


def parse_markers(body: str) -> list[dict]:
    out = []
    for match in MARKER_RE.finditer(body or ""):
        out.append({"kind": match.group(1), **dict(FIELD_RE.findall(match.group(2)))})
    return out


def marker(kind: str, **fields) -> str:
    kv = " ".join(f"{key}={value}" for key, value in fields.items())
    return f"<!-- lily:{kind} {kv} -->"


def form_field(body: str, *names: str) -> str:
    for name in names:
        match = re.search(rf"^###\s*{re.escape(name)}\s*\n+\s*(.+?)\s*$", body or "", re.M)
        if match:
            value = match.group(1).strip()
            if value and value != "_No response_":
                return value
    return ""


ATTACH_RE = re.compile(
    r"https://github\.com/(?:user-attachments/files/\d+|[\w.-]+/[\w.-]+/files/\d+)/[^\s)\]>\"']+",
    re.I,
)


def attachments(text: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for match in ATTACH_RE.finditer(text or ""):
        url = match.group(0)
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out


def redact(text: str) -> str:
    text = re.sub(r"[A-Za-z]:\\[^\s\"'<>]+", "<path>", text)
    text = re.sub(r"/(?:home|Users)/[^\s\"'<>]+", "<path>", text)
    text = re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "<ip>", text)
    text = re.sub(
        r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
        "<uuid>",
        text,
    )
    return text


def set_output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{name}={value}\n")


def bot_login_matches(user: dict, repo_cfg: dict) -> bool:
    login = (user or {}).get("login", "")
    expected = repo_cfg.get("bot_login", "")
    return login == expected or (
        user.get("type") == "Bot" and login.startswith(expected.split("[")[0])
    )
