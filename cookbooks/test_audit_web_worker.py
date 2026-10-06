import json
import tempfile
import unittest
from pathlib import Path

from cookbooks.article_12_journal import AuditJournal, sha256
from cookbooks.audit_verifier_ots import serialize
from cookbooks.audit_web_worker import verify_submission
from cookbooks.test_audit_verifier import receipt


class WebWorkerTests(unittest.TestCase):
    def setUp(self):
        self.trace = {"agent_id": "synthetic-web-agent", "timestamp_utc": "2026-10-06T00:00:00Z",
                      "events": [], "final_response": {"output": "Human review"}}
        self.digest = sha256(self.trace)
        self.proof = serialize(receipt(self.digest)[0]).hex()

    def test_raw_trace_pending_is_not_failure_and_no_internal_file_paths_leak(self):
        content = json.dumps({"trace": self.trace, "receipt": {"hash": self.digest, "otsProofHex": self.proof}})
        result = verify_submission("trace", content, offline=True)
        self.assertEqual(result["traces"][0]["status"], "pending")
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["journalIntegrity"], "not_applicable")
        self.assertNotIn("saai-audit-", json.dumps(result))

    def test_receipt_hash_mismatch_is_tamper(self):
        content = json.dumps({"trace": self.trace, "hash": "00" * 32, "otsProofHex": self.proof})
        result = verify_submission("trace", content, offline=True)
        self.assertEqual(result["traces"][0]["label"], "TAMPER EVIDENT FAILURE")
        self.assertEqual(result["exitCode"], 1)

    def test_actual_journal_and_altered_trace_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audit_trail.jsonl"
            journal = AuditJournal(path)
            journal.append({"kind": "trace", "trace_id": "test", "trace_hash": self.digest, "trace": self.trace})
            journal.append({"kind": "status", "trace_id": "test", "trace_hash": self.digest,
                            "hash": self.digest, "otsProofHex": self.proof})
            content = path.read_text()
        self.assertEqual(verify_submission("journal", content, offline=True)["traces"][0]["status"], "pending")
        bad = verify_submission("journal", content.replace("Human review", "Auto approve"), offline=True)
        self.assertEqual(bad["journalIntegrity"], "tamper")
        self.assertEqual(bad["traces"][0]["status"], "tamper")

    def test_missing_evidence_is_not_a_successful_verification(self):
        result = verify_submission("trace", json.dumps({"trace": self.trace}), offline=True)
        self.assertEqual(result["traces"][0]["status"], "missing")
        self.assertEqual(result["exitCode"], 2)

    def test_limits_and_duplicate_or_ambiguous_json_are_rejected(self):
        for mode, content in [
            ("trace", '{"trace":{},"trace":{}}'),
            ("trace", json.dumps({"trace": self.trace, "receipt": {}, "otsProofHex": self.proof})),
            ("journal", "{}\n" * 129), ("journal", "x" * (1024 * 1024 + 1)),
        ]:
            with self.assertRaises(ValueError):
                verify_submission(mode, content, offline=True)


if __name__ == "__main__":
    unittest.main()
