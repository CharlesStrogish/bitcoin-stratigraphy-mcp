# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Offline compliance-cookbook tests; real OTS serialization, no payments/models."""
import hashlib
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from cookbooks.article_12_compliance import (
    Article12NotaryCallback, MacroNotarizer, MissingBatchCredential,
    canonical_json, sha256, validated_receipt,
)
from cookbooks.article_12_journal import AuditJournal
from opentimestamps.core.notary import PendingAttestation
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.serialize import BytesSerializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp
from sdk.python.client import BitcoinStratigraphyClient


def pending_receipt(digest):
    # Genuine OTS format; SYNTHETIC pending attestation, not a real calendar proof.
    receipt = DetachedTimestampFile(OpSHA256(), Timestamp(bytes.fromhex(digest)))
    receipt.timestamp.attestations.add(PendingAttestation("https://calendar.example.com"))
    context = BytesSerializationContext()
    receipt.serialize(context)
    return {"hash": digest, "otsProofHex": context.getbytes().hex(), "otsStatus": "pending_calendar"}


class FakeNotarizer:
    def __init__(self, error=None, gate=None):
        self.calls, self.error, self.gate = [], error, gate
        self.entered = threading.Event()

    def notarize(self, digest):
        self.calls.append(digest)
        self.entered.set()
        if self.gate and not self.gate.wait(5):
            raise TimeoutError("test gate timeout")
        if self.error:
            raise self.error
        return pending_receipt(digest)


class Article12Tests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "audit_trail.jsonl"
        self.addCleanup(self.directory.cleanup)

    def callback(self, notarizer=None, **kwargs):
        return Article12NotaryCallback(journal_path=self.path,
                                      notarizer=notarizer or FakeNotarizer(), **kwargs)

    def test_complete_footprint_canonical_hash_receipt_and_duplicate_finish(self):
        notary = FakeNotarizer()
        with self.callback(notary, session_id="session-1", agent_id="assessor") as cb:
            run_id, tool_id = uuid4(), uuid4()
            cb.on_chain_start({}, {"query": "Assess synthetic borrower", "region": "EU"}, run_id=run_id)
            cb.on_agent_action(SimpleNamespace(tool="ratio", tool_input={"income": 100},
                                               log="Exposed scratchpad explanation"), run_id=run_id)
            cb.on_tool_start({"name": "ratio"}, '{"income":100}', run_id=tool_id, parent_run_id=run_id)
            cb.on_tool_end({"ratio": 0.1}, run_id=tool_id, parent_run_id=run_id)
            response = {"output": "Refer to a human", "metadata": {"provider": "mock"}}
            cb.on_agent_finish(SimpleNamespace(return_values=response), run_id=run_id)
            cb.on_chain_end(response, run_id=run_id)
            cb.flush()
            metadata = response["metadata"]["article_12_notarization"]
            records = cb.journal.records()
        traces = [r for r in records if r["kind"] == "trace"]
        self.assertEqual(len(traces), 1)
        trace = traces[0]["trace"]
        self.assertEqual(metadata["hash"], hashlib.sha256(canonical_json(trace)).hexdigest())
        self.assertEqual(trace["input_query"], "Assess synthetic borrower")
        self.assertEqual(trace["inputs"]["region"], "EU")
        self.assertEqual(trace["session_id"], "session-1")
        self.assertEqual(trace["agent_id"], "assessor")
        self.assertTrue(trace["timestamp_utc"].endswith("Z"))
        self.assertEqual([e["event"] for e in trace["events"]], ["agent_action", "tool_start", "tool_end"])
        self.assertEqual(trace["events"][0]["data"]["scratchpad_log"], "Exposed scratchpad explanation")
        self.assertEqual(trace["final_response"]["output"], "Refer to a human")
        self.assertNotIn("article_12_notarization", trace["final_response"]["metadata"])
        self.assertEqual(notary.calls, [metadata["hash"]])
        self.assertEqual(metadata["status"], "notarized")
        self.assertFalse(metadata["bitcoin_confirmed"])
        self.assertTrue(metadata["otsProofHex"])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_network_failure_persists_and_explicit_uncertain_replay_preserves_hash(self):
        with self.callback(FakeNotarizer(error=TimeoutError("DO NOT LOG THIS SECRET"))) as cb:
            run = cb.start_run("query")
            metadata = cb.finish_run(run, {"output": "done"})
            cb.flush()
            self.assertEqual(metadata["status"], "deferred")
            self.assertTrue(metadata["settlement_unknown"])
            self.assertEqual(cb.replay_pending(), [])
        self.assertNotIn("DO NOT LOG THIS SECRET", self.path.read_text())
        replacement = FakeNotarizer()
        with self.callback(replacement) as cb:
            replayed = cb.replay_pending(retry_uncertain=True)
            cb.flush()
            self.assertEqual(len(replayed), 1)
            self.assertEqual(replayed[0]["hash"], metadata["hash"])
            self.assertEqual(replayed[0]["status"], "notarized")
            self.assertEqual(cb.replay_pending(retry_uncertain=True), [])
        self.assertEqual(replacement.calls, [metadata["hash"]])

    def test_missing_credential_is_replayable_without_unknown_settlement(self):
        with self.callback(MacroNotarizer()) as cb:
            meta = cb.finish_run(cb.start_run("query"), {"output": "done"})
            cb.flush()
            self.assertEqual(meta["error_type"], "MissingBatchCredential")
            self.assertFalse(meta["settlement_unknown"])
        with self.callback() as cb:
            replayed = cb.replay_pending()
            cb.flush()
            self.assertEqual(replayed[0]["status"], "notarized")

    def test_network_is_off_thread_and_queue_overflow_is_durable(self):
        gate, notary = threading.Event(), FakeNotarizer()
        notary.gate = gate
        cb = self.callback(notary, max_pending=1)
        try:
            first = cb.finish_run(cb.start_run("one"), {"output": "one"})
            self.assertTrue(notary.entered.wait(2))
            self.assertEqual(first["status"], "pending")  # Callback already returned.
            second = cb.finish_run(cb.start_run("two"), {"output": "two"})
            self.assertEqual(second["status"], "deferred")
            self.assertEqual(second["error_type"], "QueueFull")
            with self.assertRaises(TimeoutError):
                cb.flush(timeout=0.001)
            gate.set()
            cb.flush()
            replay = cb.replay_pending()
            cb.flush()
            self.assertEqual(len(replay), 1)
            self.assertEqual(replay[0]["hash"], second["hash"])
            self.assertEqual(replay[0]["status"], "notarized")
        finally:
            gate.set()
            cb.close()

    def test_nested_chain_finishes_do_not_notarize_before_root(self):
        notary = FakeNotarizer()
        with self.callback(notary) as cb:
            root, child = uuid4(), uuid4()
            cb.on_chain_start({}, {"input": "root"}, run_id=root)
            cb.on_chain_start({}, {"input": "child"}, run_id=child, parent_run_id=root)
            cb.on_chain_end({"output": "child"}, run_id=child, parent_run_id=root)
            self.assertEqual(notary.calls, [])
            cb.on_chain_end({"output": "root"}, run_id=root)
            cb.flush()
            self.assertEqual(len(notary.calls), 1)

    def test_real_langchain_runnable_attaches_response_metadata(self):
        from langchain_core.callbacks import BaseCallbackHandler
        from langchain_core.runnables import RunnableLambda
        with self.callback() as cb:
            self.assertIsInstance(cb, BaseCallbackHandler)
            agent = RunnableLambda(lambda value: {"output": value["input"].upper()})
            result = agent.invoke({"input": "demo"}, config={"callbacks": [cb]})
            cb.flush()
            self.assertEqual(result["metadata"]["article_12_notarization"]["status"], "notarized")

    def test_chain_errors_are_audited_without_exception_text(self):
        with self.callback() as cb:
            run = uuid4()
            cb.on_chain_start({}, {"input": "failure"}, run_id=run)
            cb.on_chain_error(RuntimeError("sensitive diagnostic"), run_id=run)
            cb.flush()
            trace = next(r["trace"] for r in cb.journal.records() if r["kind"] == "trace")
            self.assertEqual(trace["final_response"]["error_type"], "RuntimeError")
        self.assertNotIn("sensitive diagnostic", self.path.read_text())

    def test_credentials_redacted_and_nan_rejected(self):
        with self.callback() as cb:
            run = cb.start_run({"api_key": "private-value", "query": "ordinary query"})
            cb.finish_run(run, {"output": "done"})
            cb.flush()
        self.assertNotIn("private-value", self.path.read_text())
        with self.callback() as cb:
            with self.assertRaises(ValueError):
                cb.finish_run(cb.start_run(float("nan")), {"output": "done"})

    def test_wrong_digest_inside_ots_receipt_is_rejected(self):
        digest = "11" * 32
        result = pending_receipt("22" * 32)
        result["hash"] = digest
        with self.assertRaises(ValueError):
            validated_receipt(result, digest)

    def test_corrupt_journal_cannot_be_replayed(self):
        with self.callback(FakeNotarizer(error=MissingBatchCredential())) as cb:
            cb.finish_run(cb.start_run("ORIGINAL"), {"output": "done"})
            cb.flush()
        self.path.write_text(self.path.read_text().replace("ORIGINAL", "MODIFIED"))
        with self.callback() as cb:
            with self.assertRaises(ValueError):
                cb.replay_pending()

    def test_local_write_failure_is_not_silently_swallowed(self):
        with self.callback() as cb:
            run = cb.start_run("query")
            with patch.object(cb.journal, "append", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    cb.finish_run(run, {"output": "done"})

    def test_received_receipt_is_preserved_when_status_persistence_fails(self):
        gate = threading.Event()
        notary = FakeNotarizer(gate=gate)
        cb = self.callback(notary)
        try:
            metadata = cb.finish_run(cb.start_run("query"), {"output": "done"})
            self.assertTrue(notary.entered.wait(2))
            with patch.object(cb.journal, "append", side_effect=OSError("disk full")):
                gate.set()
                with self.assertRaises(RuntimeError):
                    cb.flush()
            self.assertEqual(metadata["status"], "persistence_error")
            self.assertTrue(metadata["otsProofHex"])
            with self.assertRaises(RuntimeError):
                cb.close()
        finally:
            gate.set()
            cb._executor.shutdown(wait=True)

    def test_journal_rejects_symlinks_and_incomplete_records(self):
        other = Path(self.directory.name) / "other"
        other.write_text("do not change")
        self.path.symlink_to(other)
        with self.assertRaises(OSError):
            AuditJournal(self.path).records()
        self.path.unlink()
        self.path.touch(mode=0o600)
        self.path.write_text('{"unfinished":true}')
        with self.assertRaises(ValueError):
            AuditJournal(self.path).records()

    def test_atomic_claim_does_not_duplicate_active_attempt(self):
        journal = AuditJournal(self.path)
        trace = {"input": "query"}
        journal.append({"kind": "trace", "trace_id": "trace", "trace_hash": sha256(trace), "trace": trace})
        self.assertTrue(journal.claim("trace", sha256(trace)))
        self.assertFalse(journal.claim("trace", sha256(trace)))
        self.assertFalse(journal.claim("trace", sha256(trace), retry_uncertain=True))

    def test_macro_transport_sends_batch_header_and_prepaid_auth_using_sdk(self):
        seen = []
        authorization = "L402 synthetic-macaroon:" + "11" * 32

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.headers.get("X-L402-Batch-Size"),
                             self.headers.get("Authorization"), request["params"]))
                data = json.dumps({"jsonrpc": "2.0", "id": request["id"],
                                   "result": {"structuredContent": pending_receipt(request["params"]["arguments"]["hash"])}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            notary = MacroNotarizer(f"http://127.0.0.1:{server.server_port}/mcp", authorization)
            result = notary.notarize("ab" * 32)
            self.assertEqual(result["hash"], "ab" * 32)
            self.assertEqual(seen, [("100", authorization,
                                    {"name": "proof.notarize", "arguments": {"hash": "ab" * 32}})])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_transport_rejects_header_injection_and_credentials_in_urls(self):
        with self.assertRaises(ValueError):
            BitcoinStratigraphyClient(headers={"Authorization": "bad\r\nX-Test: injected"})
        with self.assertRaises(ValueError):
            BitcoinStratigraphyClient(headers={"Host": "attacker.example"})
        with self.assertRaises(ValueError):
            MacroNotarizer("https://user:password@example.com/mcp")


if __name__ == "__main__":
    unittest.main()
