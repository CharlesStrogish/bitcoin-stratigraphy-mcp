"""Durable LangChain callback recorder. The scanner provides hashes, not ZK proofs."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import UUID, uuid4

MAX_RESPONSE_BYTES = 256 * 1024
MAX_PROMPT_CHARS = 20_000


class RecorderError(RuntimeError):
    """No sensitive HTTP body, prompt or authorization is included in errors."""


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def redact(value: Any) -> Any:
    """Defense in depth only. Review application-specific data before enabling content."""
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if re.search(
                r"secret|password|token|authorization|cookie|api.?key|macaroon|preimage",
                str(key), re.I
            ) else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"(?i)\b(?:L402|Macaroon|Bearer)\s+\S+", "[REDACTED CREDENTIAL]", value)
        value = re.sub(r"\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]+", "[REDACTED KEY]", value)
        value = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[REDACTED EMAIL]", value, flags=re.I)
        return value
    if value is None or isinstance(value, (int, float, bool)):
        return value
    # Do not call repr/str on arbitrary tools, exceptions or model objects.
    return {"python_type": type(value).__name__}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RecorderError("Scanner redirects are refused to protect credentials")


class ScannerClient:
    def __init__(self, macaroon: str, url: str, require_groth16: bool = False):
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
                parsed.password or parsed.query or parsed.fragment or parsed.path != "/api/scanner"):
            raise ValueError("SCANNER_URL must be an HTTPS /api/scanner URL without credentials or query")
        if not macaroon or any(c.isspace() for c in macaroon):
            raise ValueError("L402_MACAROON must be a funded scanner token, without its header prefix")
        self._macaroon = macaroon
        self.url = url
        self.require_groth16 = require_groth16
        self._opener = build_opener(_NoRedirect())

    def scan(self, prompt: str) -> dict[str, Any]:
        if self.require_groth16:
            raise RecorderError("Current /api/scanner cannot supply a Groth16 receipt")
        if not 20 <= len(prompt) <= MAX_PROMPT_CHARS:
            raise RecorderError("Event exceeds scanner bounds; split events explicitly, never truncate")
        request = Request(self.url, canonical({"prompt": prompt}).encode("utf-8"), {
            "Content-Type": "application/json",
            "Authorization": f"Macaroon {self._macaroon}",
            "Accept": "application/json",
        }, method="POST")
        try:
            with self._opener.open(request, timeout=30) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise RecorderError("Scanner response exceeded the size limit")
                if response.status != 200:
                    raise RecorderError("Unexpected scanner response")
        except HTTPError as exc:
            # Never create or pay a new invoice on 402; every replay may consume a credit.
            raise RecorderError(f"Scanner HTTP {exc.code}; no automatic retry or payment") from None
        except (URLError, TimeoutError, OSError):
            raise RecorderError("Scanner outcome unknown; no automatic retry or payment") from None
        try:
            report = json.loads(raw)
            self.verify(prompt, report)
            return report
        except (ValueError, TypeError, KeyError):
            raise RecorderError("Scanner returned an invalid commitment") from None

    @staticmethod
    def verify(prompt: str, report: dict[str, Any]) -> None:
        if not isinstance(report, dict):
            raise ValueError("Invalid report")
        if report["schema"] != "article12-heuristic/v1" or report["receipt_type"] != "simulated_zk_receipt":
            raise ValueError("Unexpected evidence contract")
        if not hmac.compare_digest(report["prompt_sha256"], sha256(prompt)):
            raise ValueError("Prompt commitment mismatch")
        # Match the server's explicit field order and exact JSON.stringify bytes.
        unsigned = {key: report[key] for key in (
            "schema", "overall_risk_level", "flagged_categories", "prompt_sha256",
            "receipt_type", "limitations",
        )}
        expected = sha256("bitcoinstratigraphy/scanner/v1\n" + canonical(unsigned))
        if not hmac.compare_digest(report["compliance_hash"], expected):
            raise ValueError("Report commitment mismatch")


class DurableRecorder:
    """Commit locally before submission. Ambiguous attempts require operator action."""
    def __init__(self, path: str, scanner: ScannerClient,
                 capture_content: bool = False,
                 redactor: Callable[[Any], Any] = redact):
        file = Path(path).absolute()
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if file.is_symlink():
            raise ValueError("Recorder DB must not be a symlink")
        descriptor = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        os.chmod(file, 0o600)
        self._db = sqlite3.connect(file, check_same_thread=False, timeout=10)
        self._db.execute("PRAGMA busy_timeout=10000")
        self._db.execute("""CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, prompt TEXT NOT NULL, state TEXT NOT NULL,
            receipt TEXT, created_at TEXT NOT NULL
        )""")
        self._db.commit()
        self._lock = threading.RLock()
        self.scanner = scanner
        self.capture_content = capture_content
        self.redactor = redactor

    @classmethod
    def from_env(cls) -> "DurableRecorder":
        token = os.environ.get("L402_MACAROON", "")
        scanner = ScannerClient(
            token,
            os.environ.get("SCANNER_URL", "https://bitcoinstratigraphy.com/api/scanner"),
            os.environ.get("FLIGHT_RECORDER_REQUIRE_GROTH16", "false").lower() == "true",
        )
        return cls(os.environ.get("FLIGHT_RECORDER_DB", "./private/flight-recorder.sqlite3"),
                   scanner, os.environ.get("FLIGHT_RECORDER_CAPTURE_CONTENT", "false").lower() == "true")

    def record(self, event: str, run_id: UUID, parent_run_id: UUID | None = None,
               content: Any = None) -> str:
        entry = {
            "schema": "flight-recorder-event/v1", "id": str(uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event, "run_id": str(run_id),
            "parent_run_id": str(parent_run_id) if parent_run_id else None,
            "content": self.redactor(content) if self.capture_content else {"captured": False},
        }
        prompt = canonical(entry)
        if len(prompt) > MAX_PROMPT_CHARS:
            raise RecorderError("Event too large; no silent truncation")
        with self._lock:
            self._db.execute("INSERT INTO events VALUES (?, ?, 'pending', NULL, ?)",
                             (entry["id"], prompt, entry["timestamp"]))
            self._db.commit()
        # No local lock is held during network I/O.
        try:
            report = self.scanner.scan(prompt)
        except Exception:
            with self._lock:
                self._db.execute("UPDATE events SET state='unknown' WHERE id=?", (entry["id"],))
                self._db.commit()
            raise RecorderError("Receipt unavailable; event preserved locally for operator reconciliation") from None
        with self._lock:
            self._db.execute("UPDATE events SET state='recorded',receipt=? WHERE id=?",
                             (canonical(report), entry["id"]))
            self._db.commit()
        return entry["id"]

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def langchain_callback(recorder: DurableRecorder):
    """Load LangChain only when needed; sync callbacks also work with LangChain ainvoke."""
    from langchain_core.callbacks import BaseCallbackHandler

    class FlightRecorderCallback(BaseCallbackHandler):
        raise_error = True
        run_inline = True

        def on_chain_start(self, serialized, inputs, *, run_id, parent_run_id=None, **kwargs):
            recorder.record("chain.start", run_id, parent_run_id, inputs)

        def on_chain_end(self, outputs, *, run_id, parent_run_id=None, **kwargs):
            recorder.record("chain.end", run_id, parent_run_id, outputs)

        def on_tool_start(self, serialized, input_str, *, run_id, parent_run_id=None, **kwargs):
            recorder.record("tool.start", run_id, parent_run_id, {"tool": serialized.get("name"), "input": input_str})

        def on_tool_end(self, output, *, run_id, parent_run_id=None, **kwargs):
            recorder.record("tool.end", run_id, parent_run_id, output)

        def on_llm_start(self, serialized, prompts, *, run_id, parent_run_id=None, **kwargs):
            recorder.record("llm.start", run_id, parent_run_id, prompts)

        def on_chat_model_start(self, serialized, messages, *, run_id, parent_run_id=None, **kwargs):
            # Never serialize arbitrary BaseMessage objects implicitly.
            recorder.record("chat.start", run_id, parent_run_id,
                            [[{"type": m.type, "content": m.content} for m in row] for row in messages])

        def on_llm_end(self, response, *, run_id, parent_run_id=None, **kwargs):
            recorder.record("llm.end", run_id, parent_run_id,
                            [[g.text for g in row] for row in response.generations])

        def _error(self, error, *, run_id, parent_run_id=None, **kwargs):
            recorder.record("execution.error", run_id, parent_run_id, {"error_type": type(error).__name__})

        on_chain_error = _error
        on_tool_error = _error
        on_llm_error = _error

    return FlightRecorderCallback()
