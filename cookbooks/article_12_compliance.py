#!/usr/bin/env python3
"""Article 12 audit-evidence callback, not a legal-compliance certification.

Automatically records observable agent inputs, tool events, exposed scratchpad
logs, and outputs. It cannot recover hidden model reasoning. Only the SHA-256
digest leaves the process; the plaintext trace stays in a private JSONL journal.
Use organizational controls for lawful logging, encryption, retention and access.

Run here: uv run --no-sync python cookbooks/article_12_compliance.py
Prepay a tool-scoped proof.notarize Macro-Macaroon and set L402_AUTHORIZATION to
"L402 <macaroon>:<preimage>" to receive a real pending-calendar OTS receipt.
Without a credential the runnable synthetic assessment safely defers locally.
Replay: uv run --no-sync python cookbooks/article_12_compliance.py --replay
No invoices are paid automatically. --retry-uncertain may consume another call.
"""
from __future__ import annotations

import argparse
import dataclasses
import os
import re
import sys
import threading
from collections import OrderedDict
from collections.abc import Mapping, MutableMapping
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit
from uuid import UUID, uuid4

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cookbooks.article_12_journal import AuditJournal, canonical_json, sha256, utc_now
from sdk.python.client import BitcoinStratigraphyClient, DEFAULT_MCP_SERVER_URL

try:
    from langchain_core.callbacks import BaseCallbackHandler
except ModuleNotFoundError as error:
    if error.name != "langchain_core":
        raise

    class BaseCallbackHandler:
        """Duck-typed fallback for the SDK-only demo; real LangChain is optional."""


class Notarizer(Protocol):
    def notarize(self, digest: str) -> dict[str, Any]: ...


class MissingBatchCredential(RuntimeError):
    pass


class MacroNotarizer:
    """Use the existing SDK, a prepaid pass, and no per-run wallet purchases."""

    def __init__(self, url: str = DEFAULT_MCP_SERVER_URL,
                 authorization: str | None = None, timeout: float = 10):
        parsed = urlsplit(url)
        if (not parsed.hostname or parsed.username or parsed.password or parsed.query
                or parsed.fragment or (parsed.scheme != "https" and not
                (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}))):
            raise ValueError("Use credential-free HTTPS, or loopback HTTP for local testing")
        if authorization and not re.fullmatch(r"L402 [A-Za-z0-9_+/=-]+:[0-9a-fA-F]{64}", authorization):
            raise ValueError("Invalid prepaid L402 authorization format")
        self._authorized = bool(authorization)
        headers = {"X-L402-Batch-Size": "100"}
        if authorization:
            headers["Authorization"] = authorization
        self.client = BitcoinStratigraphyClient(url, timeout=timeout, headers=headers)

    def notarize(self, digest: str) -> dict[str, Any]:
        if not self._authorized:
            raise MissingBatchCredential("Configure a prepaid proof.notarize batch pass")
        return self.client.call_tool("proof.notarize", {"hash": digest})


def json_value(value: Any) -> Any:
    """Normalize supported framework objects without opaque repr() fallbacks."""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("Audit datetimes must be timezone-aware")
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return json_value(dataclasses.asdict(value))
    if hasattr(value, "model_dump"):
        return json_value(value.model_dump(mode="json"))
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("Audit object keys must be strings")
        return {key: json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [json_value(item) for item in value]
    raise TypeError(f"Unsupported audit value type: {type(value).__name__}")


def redact_credentials(value: Any) -> Any:
    """Conservative baseline; supply your own redactor for domain PII policies."""
    if isinstance(value, dict):
        return {key: "[REDACTED]" if re.search(
            r"authorization|password|secret|private_key|api_key|preimage", key, re.I)
            else redact_credentials(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_credentials(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"\bL402 [A-Za-z0-9_+/=-]+:[0-9a-fA-F]{64}\b", "[REDACTED L402]", value)
        value = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", "[REDACTED BEARER]", value, flags=re.I)
        return re.sub(r"nostr\+walletconnect://[^\s\"']+", "[REDACTED NWC]", value)
    return value


def validated_receipt(result: dict, digest: str) -> dict:
    """Validate OTS structure and digest, NOT calendar trust or Bitcoin inclusion."""
    from opentimestamps.core.notary import PendingAttestation
    from opentimestamps.core.op import OpSHA256
    from opentimestamps.core.serialize import StreamDeserializationContext
    from opentimestamps.core.timestamp import DetachedTimestampFile

    proof = result.get("otsProofHex")
    if (result.get("hash") != digest or result.get("otsStatus") != "pending_calendar"
            or not isinstance(proof, str) or len(proof) > 1024 * 1024
            or not re.fullmatch(r"(?:[0-9a-fA-F]{2})+", proof)):
        raise ValueError("Mismatched or malformed notarization receipt")
    context = StreamDeserializationContext(BytesIO(bytes.fromhex(proof)))
    receipt = DetachedTimestampFile.deserialize(context)
    context.assert_eof()
    if (not isinstance(receipt.file_hash_op, OpSHA256) or receipt.file_digest != bytes.fromhex(digest)
            or not any(isinstance(attestation, PendingAttestation)
                       for _, attestation in receipt.timestamp.all_attestations())):
        raise ValueError("OTS receipt does not bind the trace digest and a pending calendar")
    return {"hash": digest, "otsProofHex": proof.lower(), "otsStatus": "pending_calendar",
            "bitcoin_confirmed": False, "receipt_digest_validated": True}


class Article12NotaryCallback(BaseCallbackHandler):
    """Durable root-run evidence; bounded background notarization; CrewAI adapter.

    LangChain: agent.invoke(inputs, config={"callbacks": [callback]})
    CrewAI: start_run(...); record_event(...); finish_run(run_id, response_dict).
    Response metadata is initially pending and updated in place by the worker.
    Call flush()/close() at an audit boundary, not inside a ReAct tool loop.
    """
    raise_error = True          # Local logging failure must not silently pass.
    run_inline = True           # Persist evidence before returning; network is off-thread.

    def __init__(self, *, agent_id: str = "enterprise-agent", session_id: str | None = None,
                 journal_path: str | Path = "audit_trail.jsonl", notarizer: Notarizer | None = None,
                 max_pending: int = 100, redactor: Callable[[Any], Any] = redact_credentials):
        super().__init__()
        if max_pending < 1:
            raise ValueError("max_pending must be positive")
        self.agent_id, self.session_id = agent_id, session_id or str(uuid4())
        self.journal = AuditJournal(journal_path)
        self.notarizer = notarizer or MacroNotarizer()
        self.redactor = redactor
        self._lock = threading.RLock()
        self._states, self._roots = {}, {}
        self._completed = OrderedDict()
        self._slots = threading.BoundedSemaphore(max_pending)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="article12-notary")
        self._futures = set()
        self._worker_errors = []
        self._closed = False

    def start_run(self, input_query: Any, *, run_id: Any = None,
                  session_id: str | None = None, agent_id: str | None = None) -> str:
        key = str(run_id or uuid4())
        with self._lock:
            if self._closed or key in self._states or key in self._completed:
                raise ValueError("Callback closed or run ID already used")
            self._states[key] = {
                "schema": "article12-execution-trace/v1", "run_id": key,
                "session_id": session_id or self.session_id, "agent_id": agent_id or self.agent_id,
                "started_at_utc": utc_now(), "input_query": json_value(input_query), "events": [],
            }
            self._roots[key] = key
        return key

    def _root(self, run_id: Any, parent_run_id: Any = None) -> str | None:
        return self._roots.get(str(run_id)) or self._roots.get(str(parent_run_id))

    def record_event(self, run_id: Any, event: str, data: Any, *, parent_run_id: Any = None):
        with self._lock:
            root = self._root(run_id, parent_run_id)
            if root in self._states:
                self._states[root]["events"].append({
                    "timestamp_utc": utc_now(), "run_id": str(run_id), "event": event,
                    "data": json_value(data),
                })

    def on_chain_start(self, serialized, inputs, *, run_id, parent_run_id=None, metadata=None, **kwargs):
        with self._lock:
            if parent_run_id is None:
                context = metadata or {}
                query = inputs.get("input", inputs.get("query", inputs)) if isinstance(inputs, Mapping) else inputs
                self.start_run(query, run_id=run_id, session_id=context.get("session_id"),
                               agent_id=context.get("agent_id"))
                self._states[str(run_id)]["inputs"] = json_value(inputs)
            else:
                root = self._root(parent_run_id)
                if root in self._states:
                    self._roots[str(run_id)] = root
                    self.record_event(run_id, "chain_start", inputs)

    def on_tool_start(self, serialized, input_str, *, run_id, parent_run_id=None, inputs=None, **kwargs):
        self.record_event(run_id, "tool_start",
                          {"tool": (serialized or {}).get("name"), "input": inputs if inputs is not None else input_str},
                          parent_run_id=parent_run_id)
        with self._lock:
            root = self._root(run_id, parent_run_id)
            if root in self._states:
                self._roots[str(run_id)] = root

    def on_tool_end(self, output, *, run_id, parent_run_id=None, **kwargs):
        self.record_event(run_id, "tool_end", output, parent_run_id=parent_run_id)

    def on_agent_action(self, action, *, run_id, parent_run_id=None, **kwargs):
        self.record_event(run_id, "agent_action", {
            "tool": action.tool, "tool_input": action.tool_input, "scratchpad_log": action.log,
        }, parent_run_id=parent_run_id)

    def on_text(self, text, *, run_id, parent_run_id=None, **kwargs):
        self.record_event(run_id, "exposed_text", text, parent_run_id=parent_run_id)

    def on_llm_end(self, response, *, run_id, parent_run_id=None, **kwargs):
        self.record_event(run_id, "llm_end", {
            "generations": response.generations, "usage": response.llm_output,
        }, parent_run_id=parent_run_id)

    def on_tool_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self.record_event(run_id, "tool_error", {"error_type": type(error).__name__}, parent_run_id=parent_run_id)

    @staticmethod
    def _attach(response, metadata):
        if not isinstance(response, MutableMapping):
            raise TypeError("Wrap string/framework responses in a mutable {'output': ...} mapping")
        target = response.setdefault("metadata", {})
        if not isinstance(target, MutableMapping):
            raise TypeError("Response metadata must be a mutable mapping")
        target["article_12_notarization"] = metadata

    def finish_run(self, run_id: Any, response: MutableMapping) -> dict:
        key = str(run_id)
        with self._lock:
            if not isinstance(response, MutableMapping) or (
                    "metadata" in response and not isinstance(response["metadata"], MutableMapping)):
                raise TypeError("Response and its metadata must be mutable mappings")
            if key in self._completed:
                result = self._completed[key]
                self._attach(response, result)
                return result
            if key not in self._states:
                raise ValueError("Call start_run or on_chain_start before finishing")
            # Exclude our own metadata from the signed execution footprint.
            final = json_value(response)
            if isinstance(final.get("metadata"), dict):
                final["metadata"].pop("article_12_notarization", None)
            trace = self.redactor(json_value({**self._states[key], "timestamp_utc": utc_now(),
                                             "final_response": final}))
            digest, trace_id = sha256(trace), str(uuid4())
            result = {"trace_id": trace_id, "hash": digest, "status": "pending",
                      "otsProofHex": None, "bitcoin_confirmed": False,
                      "journal_path": str(self.journal.path)}
            self.journal.append({"kind": "trace", "trace_id": trace_id, "trace_hash": digest,
                                 "timestamp_utc": utc_now(), "trace": trace})
            self._attach(response, result)
            self._completed[key] = result
            self._states.pop(key)
            self._roots = {child: root for child, root in self._roots.items()
                           if root != key or child == key}
            while len(self._completed) > 1024:
                old, _ = self._completed.popitem(last=False)
                self._roots.pop(old, None)
            self._submit(trace_id, digest, result)
            return result

    def on_agent_finish(self, finish, *, run_id, parent_run_id=None, **kwargs):
        if parent_run_id is None:
            self.finish_run(run_id, finish.return_values)
        else:
            self.record_event(run_id, "agent_finish", finish.return_values, parent_run_id=parent_run_id)

    def on_chain_end(self, outputs, *, run_id, parent_run_id=None, **kwargs):
        if parent_run_id is None:
            self.finish_run(run_id, outputs)
        else:
            self.record_event(run_id, "chain_end", outputs, parent_run_id=parent_run_id)

    def on_chain_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self.record_event(run_id, "chain_error", {"error_type": type(error).__name__}, parent_run_id=parent_run_id)
        if parent_run_id is None:
            self.finish_run(run_id, {"error_type": type(error).__name__})

    def _submit(self, trace_id, digest, metadata, *, retry_uncertain=False):
        if not self._slots.acquire(blocking=False):
            metadata.update(status="deferred", error_type="QueueFull")
            return
        try:
            future = self._executor.submit(self._notarize, trace_id, digest, metadata, retry_uncertain)
        except BaseException:
            self._slots.release()
            raise
        self._futures.add(future)

        def done(completed):
            with self._lock:
                self._futures.discard(completed)
                if completed.exception() is not None:
                    self._worker_errors.append(completed.exception())
            self._slots.release()
        future.add_done_callback(done)

    def _notarize(self, trace_id, digest, metadata, retry_uncertain):
        if not self.journal.claim(trace_id, digest, retry_uncertain=retry_uncertain):
            metadata.update(status="deferred", error_type="AlreadyClaimedOrUncertain")
            return
        try:
            receipt = validated_receipt(self.notarizer.notarize(digest), digest)
        except Exception as error:
            # Never persist exception messages: SDK errors may include credentials.
            status = {"status": "deferred", "error_type": type(error).__name__,
                      "settlement_unknown": not isinstance(error, MissingBatchCredential)}
        else:
            status = {"status": "notarized", **receipt, "settlement_unknown": False}
        try:
            self.journal.append({"kind": "status", "trace_id": trace_id, "trace_hash": digest,
                                 "timestamp_utc": utc_now(), **status})
        except Exception:
            # Preserve any received proof in response metadata for reconciliation.
            # Do not claim durable success if its status could not be journaled.
            with self._lock:
                metadata.update({**status, "status": "persistence_error"})
            raise
        with self._lock:
            metadata.update(status)

    def replay_pending(self, *, retry_uncertain: bool = False) -> list[dict]:
        """Explicit bounded replay; no trace modification and no silent payment."""
        self.flush()
        results = []
        with self._lock:
            if self._closed:
                raise RuntimeError("Callback is closed")
            for trace in self.journal.pending(retry_uncertain=retry_uncertain):
                metadata = {"trace_id": trace["trace_id"], "hash": trace["trace_hash"],
                            "status": "pending", "bitcoin_confirmed": False}
                results.append(metadata)
                self._submit(trace["trace_id"], trace["trace_hash"], metadata,
                             retry_uncertain=retry_uncertain)
        return results

    def flush(self, timeout: float | None = None):
        with self._lock:
            futures = list(self._futures)
        _, unfinished = wait(futures, timeout=timeout)
        if unfinished:
            raise TimeoutError("Notarization still pending; durable traces are safe for recovery")
        with self._lock:
            errors = self._worker_errors or [f.exception() for f in futures if f.exception() is not None]
            if errors:
                raise RuntimeError("Audit worker persistence failed; inspect journal and reconcile before replay") from errors[0]

    def close(self):
        try:
            self.flush()
        finally:
            self._executor.shutdown(wait=True)
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journal", default="audit_trail.jsonl")
    parser.add_argument("--url", default=DEFAULT_MCP_SERVER_URL)
    parser.add_argument("--replay", action="store_true")
    parser.add_argument("--retry-uncertain", action="store_true",
                        help="Explicitly permit retry of ambiguous prior requests; may consume another paid call")
    args = parser.parse_args()
    notarizer = MacroNotarizer(args.url, os.getenv("L402_AUTHORIZATION"))
    with Article12NotaryCallback(agent_id="synthetic-financial-assessment",
                                journal_path=args.journal, notarizer=notarizer) as callback:
        if args.replay:
            metadata = callback.replay_pending(retry_uncertain=args.retry_uncertain)
        else:
            run_id = uuid4()
            profile = {"income": 8000, "monthly_payment": 1200}
            threshold = 0.30
            callback.on_chain_start({}, {"query": "Assess affordability for synthetic profile DEMO-001",
                                        "profile": profile},
                                    run_id=run_id)
            callback.on_agent_action(SimpleNamespace(
                tool="affordability_check", tool_input=profile,
                log="Observable explanation: apply the configured affordability threshold."),
                run_id=run_id)
            tool_id = uuid4()
            callback.on_tool_start({"name": "affordability_check"}, canonical_json(profile).decode(),
                                   run_id=tool_id, parent_run_id=run_id)
            ratio = profile["monthly_payment"] / profile["income"]
            callback.on_tool_end({"ratio": ratio, "threshold": threshold},
                                 run_id=tool_id, parent_run_id=run_id)
            outcome = "passed" if ratio <= threshold else "failed"
            response = {"output": f"Synthetic affordability check {outcome}; human review required.",
                        "metadata": {"synthetic_demo": True}}
            callback.on_agent_finish(SimpleNamespace(return_values=response), run_id=run_id)
            callback.on_chain_end(response, run_id=run_id)  # Deduplicated, not billed twice.
            metadata = response["metadata"]["article_12_notarization"]
        callback.flush()
        print(canonical_json({"audit": metadata,
                              "notice": "Pending calendar is not Bitcoin confirmation or legal compliance."}).decode())


if __name__ == "__main__":
    main()
