"""Transient, bounded public HTTP adapter for the independent audit verifier."""
from __future__ import annotations

import json
import resource
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cookbooks.article_12_journal import canonical_json, sha256
from cookbooks.audit_verifier import read_journal_data, strict_json, verify_audit
from cookbooks.audit_verifier_ots import OtsVerifier, PublicBitcoin, PublicNetwork

MAX_BODY = 1024 * 1024
LIMITATIONS = (
    "Verification binds the supplied bytes to Bitcoin commitments using two corroborated public "
    "mainnet header sources, not a fully validated local chain. Client timestamps and agent IDs "
    "are producer claims. It does not prove log completeness, agent honesty, retention, or legal "
    "compliance. Whole-journal rewriting/truncation requires external checkpoints. Submitted logs "
    "are processed transiently; no server copy is retained."
)


class DeadlineNetwork(PublicNetwork):
    def __init__(self):
        super().__init__(timeout=2)
        self.deadline = time.monotonic() + 24

    def get(self, url, limit):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Public verification request budget exhausted")
        self.timeout = min(2, remaining)
        return super().get(url, limit)


def verify_submission(mode, content, *, offline=False):
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_BODY:
        raise ValueError("Submission exceeds 1 MiB")
    if mode not in ("journal", "trace") or not content.strip():
        raise ValueError("Expected a nonempty journal or JSON trace")
    def evaluate():
        if mode == "journal":
            if len(content.splitlines()) > 128:
                raise ValueError("Journal exceeds 128 records")
            data = content.encode("utf-8")
        else:
            value = strict_json(content)
            if (not isinstance(value, dict) or not isinstance(value.get("trace"), dict)
                    or set(value) - {"trace", "receipt", "otsProofHex", "hash"}):
                raise ValueError("Expected {trace, receipt} or {trace, otsProofHex, hash}")
            if "receipt" in value and not isinstance(value["receipt"], dict):
                raise ValueError("Receipt must be an object")
            if "receipt" in value and ({"hash", "otsProofHex"} & set(value)):
                raise ValueError("Supply only one receipt envelope")
            receipt = value.get("receipt", value)
            if receipt is not value and set(receipt) - {"otsProofHex", "hash", "otsStatus"}:
                raise ValueError("Unsupported receipt fields")
            digest = sha256(value["trace"])
            records = [{"kind": "trace", "trace_id": "submitted-trace",
                        "trace_hash": digest, "trace": value["trace"]}]
            if "otsProofHex" in receipt:
                records.append({"kind": "status", "trace_id": "submitted-trace",
                                "trace_hash": digest, "hash": receipt.get("hash", digest),
                                "otsProofHex": receipt["otsProofHex"]})
            previous = "0" * 64
            for index, record in enumerate(records, 1):
                record.update(sequence=index, previous_record_hash=previous)
                previous = record["record_hash"] = sha256(record)
            data = b"".join(canonical_json(record) + b"\n" for record in records)
        preview = read_journal_data(data)
        if len(preview.traces) > 32 or sum(len(t.receipts) for t in preview.traces) > 64:
            raise ValueError("Journal exceeds 32 traces or 64 receipts")
        if not preview.traces and not preview.issues:
            raise ValueError("Journal contains no execution traces")
        engine = OtsVerifier(offline=offline, timeout=2, max_calendars=4)
        engine.network = DeadlineNetwork()
        engine.bitcoin = PublicBitcoin(engine.network)
        audit = verify_audit(preview, engine)
        traces = []
        for trace in audit.traces:
            verdict = trace.verdict
            label = {"verified": f"VERIFIED (Block #{verdict.height})",
                     "pending": "Pending Calendar", "tamper": "TAMPER EVIDENT FAILURE",
                     "missing": "No Verifiable OTS Receipt",
                     "unavailable": "Verification Unavailable"}[verdict.status]
            row = {"traceId": trace.identifier[:256], "timestampUtc": trace.timestamp,
                   "agentId": trace.agent[:256], "sha256": trace.digest, "status": verdict.status,
                   "label": label, "detail": verdict.detail}
            if verdict.height is not None:
                row["blockHeight"] = verdict.height
            traces.append(row)
        return {"generatedUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "method": audit.method, "scope": mode,
                "journalIntegrity": ("not_applicable" if mode == "trace" else
                                     "tamper" if audit.issues else "consistent"),
                "exitCode": audit.exit_code, "issues": audit.issues,
                "traces": traces, "limitations": LIMITATIONS}
    return evaluate()


def main():
    # Process isolation protects the public API from adversarial OTS graphs.
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    try:
        request = json.loads(sys.stdin.buffer.read(7 * MAX_BODY + 1))
        result = verify_submission(request["mode"], request["content"])
        print(json.dumps(result, ensure_ascii=True))
    except (ValueError, TypeError, KeyError, RecursionError, UnicodeError):
        print(json.dumps({"error": "Malformed submission or audit limits exceeded"}))
        return 2
    except Exception:
        print(json.dumps({"error": "Verification worker unavailable"}))
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
