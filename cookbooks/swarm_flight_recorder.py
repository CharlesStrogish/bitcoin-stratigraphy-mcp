#!/usr/bin/env python3
"""Privacy-preserving rolling flight recorder; Merkle disclosure is not a ZK proof.

Safe demo: uv run --no-sync python cookbooks/swarm_flight_recorder.py
Explicit synthetic paid demo: add --production and supply a prepaid, scoped
L402_AUTHORIZATION via a secret manager. No automatic invoice purchases/retries.
"""
from __future__ import annotations

import argparse
import secrets
import sys
import threading
import os
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation

from cookbooks.article_12_journal import canonical_json
from cookbooks.audit_verifier import strict_json
from cookbooks.b2b_settlement import PrepaidMacroNotarizer, read_json
from cookbooks.swarm_merkle import MerkleAccumulator, MerkleProofError
from cookbooks.swarm_flight_evidence import (
    PROOF_SCHEMA, RECEIPT_SCHEMA, DisclosureError, leaf_preimage, ots_receipt, trace_bytes,
    verify_inclusion_proof,
)
from sdk.python.client import DEFAULT_MCP_SERVER_URL


class SwarmFlightRecorder:
    """Thread-safe O(log n) append; only finalized root digests leave the process.

    append_trace/add_trace are generic LangChain/CrewAI callback hooks, not
    framework-specific callback subclasses. Caller must sanitize payloads.
    Retention and byte caps fail explicitly; release batches only after exports.
    Keys, evidence and replay reservations require durable production custody.
    """
    def __init__(self, notarizer=None, *, max_leaves=10_000, max_retained_batches=8,
                 max_buffer_bytes=16 * 1024 * 1024, signing_key=None):
        if type(max_retained_batches) is not int or not 1 <= max_retained_batches <= 100:
            raise ValueError("Invalid retained batch capacity")
        if type(max_buffer_bytes) is not int or not 1024 <= max_buffer_bytes <= 1024**3:
            raise ValueError("Invalid buffer byte capacity")
        self._tree = MerkleAccumulator(max_leaves)
        self._key = signing_key if signing_key is not None else Ed25519PrivateKey.generate()
        if not isinstance(self._key, Ed25519PrivateKey):
            raise ValueError("Expected an Ed25519 recorder key")
        self.notarizer = notarizer
        self._max_leaves, self._max_batches, self._max_bytes = max_leaves, max_retained_batches, max_buffer_bytes
        self._lock, self._flush_lock = threading.Lock(), threading.Lock()
        self._envelopes, self._bytes = [], 0
        self._batches = OrderedDict()
        self._latest = None

    @property
    def public_key(self):
        return self._key.public_key().public_bytes_raw().hex()

    @property
    def pending_count(self):
        with self._lock:
            return self._tree.size

    def record_trace(self, trace_payload):
        # Snapshot before the lock: caller mutations never change an accepted leaf.
        payload = strict_json(trace_bytes(trace_payload))
        envelope = leaf_preimage(payload, secrets.token_hex(32))
        with self._lock:
            if self._bytes + len(envelope) > self._max_bytes:
                raise BufferError("Flight-recorder byte budget full; export and release older batches")
            index = self._tree.append(envelope)
            self._envelopes.append(envelope)
            self._bytes += len(envelope)
            return index

    append_trace = record_trace
    add_trace = record_trace

    def flush_root(self):
        """Freeze a batch once, swap immediately, and anchor only its RFC-style root.

        Empty flushes return the last receipt without paying again. Appends continue
        during slow notary I/O. Uncertain results are sealed without automatic retries.
        """
        with self._flush_lock:
            with self._lock:
                if not self._tree.size:
                    if self._latest is None:
                        raise MerkleProofError("Cannot anchor an empty first batch")
                    batch = self._batches.get(self._latest)
                    if batch is None or batch["receipt"] is None:
                        raise ValueError("Latest batch released or seal incomplete; resolve before reuse")
                    return strict_json(canonical_json(batch["receipt"]))
                if len(self._batches) >= self._max_batches:
                    raise BufferError("Batch retention full; export and release evidence first")
                batch_id = str(uuid4())
                tree, envelopes = self._tree, self._envelopes
                # Reserve this batch before any paid call, including seal failures.
                batch = {"tree": tree, "envelopes": envelopes, "body": None, "receipt": None}
                self._batches[batch_id] = batch
                self._tree, self._envelopes = MerkleAccumulator(self._max_leaves), []
                self._latest = batch_id
            root = tree.root.hex()
            anchor = {"status": "deferred", "otsProofHex": None, "settlement_unknown": False}
            if self.notarizer is not None:
                try:
                    response = self.notarizer.notarize(root)
                    if (type(response) is not dict or response.get("hash") != root
                            or response.get("otsStatus") != "pending_calendar"):
                        raise DisclosureError("Notary returned a mismatched root")
                    ots = ots_receipt(response.get("otsProofHex"), root)
                    if not any(isinstance(att, (PendingAttestation, BitcoinBlockHeaderAttestation))
                               for _, att in ots.timestamp.all_attestations()):
                        raise DisclosureError("Notary returned no usable attestation")
                    anchor.update(status="pending_calendar", otsProofHex=response["otsProofHex"])
                except Exception:
                    anchor.update(status="unavailable", settlement_unknown=True)
            body = {"schema_version": RECEIPT_SCHEMA, "batch_id": batch_id, "tree_size": tree.size,
                    "root_hash": root, "recorder_public_key": self.public_key, "anchoring": anchor}
            with self._lock:
                # Preserve a genuine result even if a key custodian cannot seal it.
                batch["body"] = strict_json(canonical_json(body))
            receipt = {"body": body, "signature": self._key.sign(canonical_json(body)).hex()}
            with self._lock:
                batch["receipt"] = strict_json(canonical_json(receipt))
            return strict_json(canonical_json(receipt))

    def _batch(self, batch_id):
        if batch_id is not None and (type(batch_id) is not str or not batch_id):
            raise ValueError("Invalid batch identifier")
        batch = self._batches.get(self._latest if batch_id is None else batch_id)
        if batch is None or batch["receipt"] is None:
            raise ValueError("No finalized retained batch; flush first")
        return batch

    def generate_inclusion_proof(self, leaf_index, *, batch_id=None):
        """Audit path only; use export_disclosure to retrieve its matching single trace."""
        with self._lock:
            batch = self._batch(batch_id)
            tree = batch["tree"]
            path = tree.inclusion_path(leaf_index)
            envelope = strict_json(batch["envelopes"][leaf_index])
            return {"schema_version": PROOF_SCHEMA, "batch_id": batch["receipt"]["body"]["batch_id"],
                    "leaf_index": leaf_index, "tree_size": tree.size, "leaf_salt": envelope["salt"],
                    "path": [digest.hex() for digest in path]}

    def export_disclosure(self, leaf_index, *, batch_id=None):
        # Generate and export under one outer serialization lock to prevent release
        # between lookups; RLock is unnecessary because helpers do not reacquire here.
        with self._flush_lock:
            proof = self.generate_inclusion_proof(leaf_index, batch_id=batch_id)
            with self._lock:
                batch = self._batch(proof["batch_id"])
                payload = strict_json(batch["envelopes"][leaf_index])["trace"]
                receipt = strict_json(canonical_json(batch["receipt"]))
            return {"trace": payload, "merkle_proof": proof, "root_receipt": receipt}

    def release_batch(self, batch_id):
        """Explicit privacy/retention deletion; caller must persist its exports first."""
        with self._flush_lock, self._lock:
            batch = self._batch(batch_id)
            self._bytes -= sum(map(len, batch["envelopes"]))
            del self._batches[batch_id]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--url", default=DEFAULT_MCP_SERVER_URL)
    parser.add_argument("--verify", type=Path, help="Verify a selective-disclosure JSON bundle offline")
    parser.add_argument("--trusted-headers", type=Path)
    parser.add_argument("--upgraded-ots", type=Path)
    parser.add_argument("--recorder-key", help="Independently enrolled public key, not a secret")
    args = parser.parse_args(argv)
    if args.production and args.verify:
        parser.error("Offline verification cannot select production mode")
    if not args.verify and any((args.trusted_headers, args.upgraded_ots, args.recorder_key)):
        parser.error("Auditor evidence requires --verify")
    try:
        if args.verify:
            bundle = read_json(args.verify)
            proof = None
            if args.upgraded_ots:
                with args.upgraded_ots.open("rb") as stream:
                    proof = stream.read(512 * 1024 + 1).hex()
            report = verify_inclusion_proof(
                bundle["trace"], bundle["merkle_proof"], bundle["root_receipt"],
                trusted_headers=read_json(args.trusted_headers) if args.trusted_headers else None,
                upgraded_ots_proof_hex=proof, expected_recorder_key=args.recorder_key)
            print(canonical_json(report).decode())
            return 0 if report["bitcoin_inclusion_verified"] else 2
        authorization = os.environ.get("L402_AUTHORIZATION") if args.production else None
        notary = PrepaidMacroNotarizer(authorization, args.url) if authorization else None
        if notary is not None:
            print("Synthetic demo: one REAL prepaid root-notarization call will be consumed.")
        recorder = SwarmFlightRecorder(notary)

        def agent_run(agent):
            selected = None
            for step in range(20):
                controversial = agent == 13 and step == 7
                index = recorder.record_trace({
                    "agent_id": f"synthetic-agent-{agent}", "step": step,
                    "decision_summary": "Denied PII export pending privacy review" if controversial else "Validate telemetry",
                    "tool_call": {"name": "export_customer_records" if controversial else "check_policy",
                                  "outcome": "blocked" if controversial else "allowed"},
                    "context": {"tenant": "SYNTHETIC-CORPORATION", "policy": "no-unapproved-PII-export"},
                })
                if controversial:
                    selected = index
            return selected

        with ThreadPoolExecutor(max_workers=50) as pool:
            # Consume every future so a worker failure cannot be silently ignored.
            results = list(pool.map(agent_run, range(50)))
            selected = next(value for value in results if value is not None)
        receipt = recorder.flush_root()
        disclosure = recorder.export_disclosure(selected)
        report = verify_inclusion_proof(**{
            "trace_payload": disclosure["trace"], "merkle_proof": disclosure["merkle_proof"],
            "anchored_root_receipt": receipt})
        print(f"50 synthetic agents; {receipt['body']['tree_size']} traces; one root; one selectively disclosed decision.")
        print("Selective disclosure:", canonical_json(disclosure).decode())
        print("Verification:", canonical_json(report).decode())
        print(report["detail"])
        return 2 if report["status"] == "unavailable" else 0
    except Exception as error:
        print(f"Flight recorder failed: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
