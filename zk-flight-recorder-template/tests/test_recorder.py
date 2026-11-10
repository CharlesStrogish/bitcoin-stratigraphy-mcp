import copy
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from uuid import uuid4

from flight_recorder import (
    DurableRecorder, ScannerClient, RecorderError, canonical, sha256,
    redact, langchain_callback,
)


def report(prompt):
    result = {
        "schema": "article12-heuristic/v1",
        "overall_risk_level": "Low",
        "flagged_categories": [],
        "prompt_sha256": sha256(prompt),
        "receipt_type": "simulated_zk_receipt",
        "limitations": "Synthetic evidence; not a proof.",
    }
    result["compliance_hash"] = sha256("bitcoinstratigraphy/scanner/v1\n" + canonical(result))
    return result


class Scanner:
    def __init__(self):
        self.prompts = []
        self.fail = False

    def scan(self, prompt):
        self.prompts.append(prompt)
        if self.fail:
            raise RecorderError("synthetic network failure")
        return report(prompt)


class Tests(unittest.TestCase):
    def test_hash_binding_and_tamper(self):
        prompt = canonical({"event": "synthetic", "unicode": "Café"})
        good = report(prompt)
        ScannerClient.verify(prompt, good)
        for key, value in (
            ("prompt_sha256", "0" * 64), ("compliance_hash", "0" * 64),
            ("receipt_type", "groth16"), ("overall_risk_level", "High"),
        ):
            changed = copy.deepcopy(good)
            changed[key] = value
            with self.assertRaises(ValueError):
                ScannerClient.verify(prompt, changed)

    def test_rejects_redirect_credential_urls_and_missing_token(self):
        for url in ("http://example.org/api/scanner", "https://user:pass@example.org/api/scanner",
                    "https://example.org/api/scanner?token=x", "https://example.org/other"):
            with self.assertRaises(ValueError):
                ScannerClient("synthetic-token", url)
        with self.assertRaises(ValueError):
            ScannerClient("", "https://example.org/api/scanner")

    def test_groth16_requirement_fails_without_network(self):
        client = ScannerClient("synthetic-token", "https://example.org/api/scanner", True)
        with self.assertRaisesRegex(RecorderError, "cannot supply"):
            client.scan("a synthetic event of sufficient length")

    def test_redaction(self):
        clean = redact({"authorization": "synthetic-secret", "nested": ["Macaroon synthetic-token", "user@example.org"]})
        self.assertNotIn("synthetic-secret", json.dumps(clean))
        self.assertNotIn("synthetic-token", json.dumps(clean))
        self.assertNotIn("user@example.org", json.dumps(clean))

    def test_durable_records_unknown_and_no_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "recorder.sqlite3")
            scanner = Scanner()
            with DurableRecorder(path, scanner) as recorder:
                first = recorder.record("chain.start", uuid4(), content={"secret": "not captured"})
                scanner.fail = True
                with self.assertRaises(RecorderError):
                    recorder.record("chain.end", uuid4())
            db = sqlite3.connect(path)
            rows = db.execute("SELECT id,prompt,state FROM events ORDER BY rowid").fetchall()
            db.close()
            self.assertEqual(rows[0][0], first)
            self.assertEqual([r[2] for r in rows], ["recorded", "unknown"])
            self.assertNotIn("not captured", rows[0][1])
            self.assertEqual(len(scanner.prompts), 2)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_oversize_is_not_truncated(self):
        with tempfile.TemporaryDirectory() as directory:
            scanner = Scanner()
            with DurableRecorder(str(Path(directory) / "r.sqlite3"), scanner, True) as recorder:
                with self.assertRaises(RecorderError):
                    recorder.record("chain.start", uuid4(), content="x" * 20_000)
            self.assertEqual(scanner.prompts, [])

    def test_real_langchain_sync_and_async_callbacks(self):
        import asyncio
        from langchain_core.runnables import RunnableLambda
        with tempfile.TemporaryDirectory() as directory:
            scanner = Scanner()
            with DurableRecorder(str(Path(directory) / "r.sqlite3"), scanner) as recorder:
                callback = langchain_callback(recorder)
                chain = RunnableLambda(lambda value: {"value": value})
                self.assertEqual(chain.invoke("sync", config={"callbacks": [callback]}), {"value": "sync"})
                result = asyncio.run(chain.ainvoke("async", config={"callbacks": [callback]}))
                self.assertEqual(result, {"value": "async"})
            self.assertEqual(len(scanner.prompts), 4)
            self.assertEqual([json.loads(p)["event"] for p in scanner.prompts],
                             ["chain.start", "chain.end", "chain.start", "chain.end"])

    def test_callback_failure_stops_chain(self):
        from langchain_core.runnables import RunnableLambda
        with tempfile.TemporaryDirectory() as directory:
            scanner = Scanner()
            scanner.fail = True
            ran = []
            with DurableRecorder(str(Path(directory) / "r.sqlite3"), scanner) as recorder:
                with self.assertRaises(RecorderError):
                    RunnableLambda(lambda value: ran.append(value)).invoke(
                        "synthetic", config={"callbacks": [langchain_callback(recorder)]})
            self.assertEqual(ran, [])


if __name__ == "__main__":
    unittest.main()
