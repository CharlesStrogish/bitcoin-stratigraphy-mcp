#!/usr/bin/env python3
"""Independently audit Article 12 JSONL evidence; never contact MCP or pay L402.

Run: uv run --no-sync python cookbooks/audit_verifier.py audit_trail.jsonl
Optional: --markdown audit_report.md --receipt-dir verified_receipts
Use --bitcoin-core to verify via the official ots CLI and your own Bitcoin node.
Exit codes: 0 = verified/pending; 1 = tamper evidence; 2 = incomplete/unavailable.
This proves byte commitments, not producer honesty or legal compliance.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cookbooks.article_12_journal import sha256
from cookbooks.audit_verifier_ots import EvidenceMismatch, OtsVerifier, Verdict, MAX_PROOF, deserialize

MAX_JOURNAL = 64 * 1024 * 1024
MAX_LINE = 4 * 1024 * 1024


@dataclass
class Trace:
    identifier: str
    timestamp: str
    agent: str
    digest: str
    receipts: list[bytes] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    verdict: Verdict = field(default_factory=lambda: Verdict("missing", "No OTS receipt; not notarized"))


@dataclass
class Audit:
    traces: list[Trace]
    issues: list[str]
    source: str
    method: str = ""

    @property
    def exit_code(self):
        if self.issues or any(t.verdict.status == "tamper" for t in self.traces):
            return 1
        if not self.traces or any(t.verdict.status in ("missing", "unavailable") for t in self.traces):
            return 2
        return 0


def no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON key")
        value[key] = item
    return value


def strict_json(line):
    def reject_constant(_):
        raise ValueError("Non-finite JSON number")
    return json.loads(line, object_pairs_hook=no_duplicates, parse_constant=reject_constant)


def utc_timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Missing timezone")
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (AttributeError, TypeError, ValueError):
        return "Unknown UTC timestamp"


def read_journal(path: Path) -> Audit:
    """Read-only snapshot; continue past bad records to identify affected traces."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Audit input must be a regular file")
        data = stream.read(MAX_JOURNAL + 1)
    return read_journal_data(data, str(path))


def read_journal_data(data: bytes, source: str = "submitted journal") -> Audit:
    """Apply identical journal checks to a bounded in-memory HTTP upload."""
    if len(data) > MAX_JOURNAL:
        raise ValueError("Journal exceeds 64 MiB; use the callback's bounded archival shards")
    records, issues, previous = [], [], "0" * 64
    for sequence, line in enumerate(data.splitlines(keepends=True), 1):
        failures = []
        try:
            if len(line) > MAX_LINE:
                raise ValueError("Oversized record")
            record = strict_json(line)
            if not isinstance(record, dict):
                raise ValueError("Record is not an object")
            if not line.endswith(b"\n"):
                failures.append("incomplete final record")
            claimed = record.get("record_hash")
            body = {key: value for key, value in record.items() if key != "record_hash"}
            if not isinstance(claimed, str) or sha256(body) != claimed:
                failures.append("record hash mismatch")
            if type(body.get("sequence")) is not int or body["sequence"] != sequence:
                failures.append("record sequence mismatch")
            if body.get("previous_record_hash") != previous:
                failures.append("journal chain link mismatch")
            previous = claimed
            if body.get("kind") not in ("trace", "status") or not isinstance(body.get("trace_id"), str):
                failures.append("invalid record identity/kind")
            records.append((record, failures))
        except (ValueError, TypeError, UnicodeError, RecursionError):
            failures.append("malformed JSON record")
            previous = None
        issues.extend(f"Line {sequence}: {failure}" for failure in failures)

    traces = {}
    for record, failures in records:
        key = record.get("trace_id")
        if record.get("kind") != "trace" or not isinstance(key, str):
            continue
        if key in traces:
            traces[key].errors.append("duplicate trace ID")
            issues.append("Duplicate trace ID")
            continue
        payload = record.get("trace")
        if not isinstance(payload, dict):
            payload = {}
            failures = [*failures, "missing execution trace object"]
        try:
            digest = sha256(payload)
        except (ValueError, TypeError, RecursionError):
            digest = "Invalid trace digest"
            failures = [*failures, "execution trace cannot be canonicalized"]
        trace = Trace(key, utc_timestamp(payload.get("timestamp_utc", payload.get("started_at_utc"))),
                      str(payload.get("agent_id", "Unknown agent")), digest, errors=list(failures))
        if digest != record.get("trace_hash"):
            trace.errors.append("execution trace SHA-256 does not match stored trace hash")
        traces[key] = trace

    for record, failures in records:
        key = record.get("trace_id")
        if not isinstance(key, str) or key not in traces:
            if record.get("kind") == "status":
                issues.append("Status record has no corresponding trace")
            continue
        trace = traces[key]
        trace.errors.extend(failures)
        if record.get("trace_hash") != trace.digest:
            trace.errors.append("status/trace hash does not match execution trace")
        proof_hex = record.get("otsProofHex")
        if proof_hex is None:
            continue
        try:
            if (not isinstance(proof_hex, str) or len(proof_hex) > MAX_PROOF * 2
                    or not re.fullmatch(r"(?:[a-fA-F0-9]{2})+", proof_hex)):
                raise ValueError("Invalid proof encoding")
            if record.get("hash", trace.digest) != trace.digest:
                raise ValueError("Receipt metadata digest mismatch")
            proof = bytes.fromhex(proof_hex)
            if proof not in trace.receipts:
                trace.receipts.append(proof)
        except ValueError:
            trace.errors.append("invalid OTS receipt encoding or metadata digest")
    return Audit(list(traces.values()), issues, source)


def archived_receipt(path: Path, digest: str) -> bytes | None:
    """Load only a private regular .ots file, never a symlink or the journal."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_nlink != 1):
            raise ValueError("Saved OTS receipt is not an owner-only regular file")
        proof = stream.read(MAX_PROOF + 1)
    deserialize(proof, digest)
    return proof


def audit_journal(path: Path, verifier: OtsVerifier, receipt_dir: Path | None = None) -> Audit:
    return verify_audit(read_journal(path), verifier, receipt_dir)


def verify_audit(audit: Audit, verifier: OtsVerifier, receipt_dir: Path | None = None) -> Audit:
    audit.method = ("Offline integrity check; Bitcoin not verified" if verifier.offline else
                    "Auditor's Bitcoin Core via official OTS CLI" if
                    verifier.bitcoin.__class__.__name__ == "BitcoinCore" else
                    "Two corroborated public mainnet header sources; not a full node")
    for trace in audit.traces:
        if trace.errors:
            trace.verdict = Verdict("tamper", "; ".join(sorted(set(trace.errors))))
            continue
        # Never contact destinations from a corrupted journal.
        if audit.issues:
            trace.verdict = Verdict("unavailable", "Journal integrity failed; network verification skipped")
            continue
        if trace.receipts and receipt_dir:
            try:
                proof = archived_receipt(receipt_dir / f"{trace.digest}.ots", trace.digest)
                if proof and proof not in trace.receipts:
                    trace.receipts.append(proof)
            except (OSError, ValueError, EvidenceMismatch):
                trace.verdict = Verdict("tamper", "Saved OTS receipt was altered or cannot be read safely")
                continue
        verdicts = []
        for proof in trace.receipts:
            try:
                verdicts.append(verifier.verify(proof, trace.digest))
            except EvidenceMismatch as error:
                verdicts.append(Verdict("tamper", str(error)))
            except Exception:
                verdicts.append(Verdict("unavailable", "Receipt verification unavailable"))
        for status in ("tamper", "verified", "unavailable", "pending"):
            selected = next((v for v in verdicts if v.status == status), None)
            if selected:
                trace.verdict = selected
                break
    return audit


def clean(value):
    """Do not render terminal control sequences or untrusted Markdown formatting."""
    return ("".join(c if c.isprintable() else " " for c in str(value))
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("|", "/").replace("`", "'"))


def render_report(audit: Audit) -> str:
    lines = ["# Article 12 — Independent Audit Evidence Report", "",
             f"Generated UTC: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}",
             f"Source: {clean(audit.source)}", f"Bitcoin verification: {audit.method}",
             f"Journal integrity: {'TAMPER EVIDENT FAILURE' if audit.issues else 'Hash chain consistent'}", ""]
    counts = {s: sum(t.verdict.status == s for t in audit.traces)
              for s in ("verified", "pending", "tamper", "missing", "unavailable")}
    lines += ["Summary: " + ", ".join(f"{name}={count}" for name, count in counts.items()), "",
              "| UTC Timestamp | Agent ID | SHA-256 digest | Verification Status |",
              "| --- | --- | --- | --- |"]
    for trace in audit.traces:
        verdict = trace.verdict
        label = {"verified": f"VERIFIED: Bitcoin Block #{verdict.height}",
                 "pending": "Pending Calendar Confirmation",
                 "tamper": "TAMPER EVIDENT FAILURE",
                 "missing": "No Verifiable OTS Receipt",
                 "unavailable": "Verification Unavailable"}[verdict.status]
        if verdict.detail:
            label += f" — {verdict.detail}"
        lines.append(f"| {clean(trace.timestamp)} | {clean(trace.agent)[:120]} | {trace.digest} | {clean(label)} |")
    if audit.issues:
        lines += ["", "## Journal integrity findings", *[f"- {clean(issue)}" for issue in audit.issues]]
    lines += ["", "Pending receipts are not failures, regardless of age. No MCP or L402 requests are made.",
              "Bitcoin commitments bind these exact bytes; they do not prove log completeness, agent identity,",
              "producer honesty, or legal compliance. A rewritten/truncated journal needs externally retained",
              "checkpoints to detect omitted records. Public-source mode trusts agreement on chain membership;",
              "use --bitcoin-core with your own fully validating mainnet node for stronger independence.",
              "Bitcoin confirmations can reorganize. Local UTC timestamps are not trusted timestamps.",
              "Original journal records are never modified.", ""]
    return "\n".join(lines)


def write_private(path: Path, data: bytes, source: Path):
    if path.resolve() == source.resolve():
        raise ValueError("Output must not overwrite the input audit journal")
    if path.exists() and os.path.samefile(path, source):
        raise ValueError("Output must not alias the input audit journal")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".audit-verifier-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("journal", nargs="?", type=Path, default=Path("audit_trail.jsonl"))
    parser.add_argument("--markdown", type=Path, help="Write a private Markdown report")
    parser.add_argument("--receipt-dir", type=Path, help="Save upgraded receipts without changing the journal")
    parser.add_argument("--offline", action="store_true", help="Check local evidence without any network requests")
    parser.add_argument("--bitcoin-core", action="store_true", help="Use official ots CLI and configured mainnet Bitcoin Core")
    parser.add_argument("--timeout", type=float, default=10, help="Bound each public request (seconds)")
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 60:
        parser.error("--timeout must be greater than zero and at most 60")
    try:
        if args.markdown and args.markdown.resolve() == args.journal.resolve():
            raise ValueError("Report must not overwrite the input journal")
        verifier = OtsVerifier(offline=args.offline, bitcoin_core=args.bitcoin_core, timeout=args.timeout)
        audit = audit_journal(args.journal, verifier, args.receipt_dir)
        report = render_report(audit)
        if args.markdown:
            write_private(args.markdown, report.encode("utf-8"), args.journal)
        if args.receipt_dir:
            for trace in audit.traces:
                if trace.verdict.proof and trace.verdict.status in ("pending", "verified"):
                    write_private(args.receipt_dir / f"{trace.digest}.ots", trace.verdict.proof, args.journal)
        print(report)
        return audit.exit_code
    except (OSError, ValueError) as error:
        print(f"Audit input/output error: {clean(type(error).__name__)}. Check file paths and permissions.",
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
