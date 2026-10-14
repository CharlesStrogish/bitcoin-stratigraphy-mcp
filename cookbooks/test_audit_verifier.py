# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Offline verifier tests: genuine OTS operations, synthetic attestations, no fees."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpAppend, OpSHA256
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

from cookbooks.article_12_journal import AuditJournal, canonical_json, sha256
from cookbooks.audit_verifier import (
    audit_journal,
    main,
    read_journal,
    render_report,
    write_private,
)
from cookbooks.audit_verifier_ots import (
    BitcoinCore,
    EvidenceMismatch,
    OtsVerifier,
    PublicBitcoin,
    PublicNetwork,
    VerificationUnavailable,
    checked_header,
    deserialize,
    serialize,
)

GENESIS_HEADER = (
    "01000000"
    + "00" * 32
    + "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a"
    + "29ab5f49ffff001d1dac2b7c"
)
GENESIS_HASH = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"


def receipt(digest, confirmed=False):
    detached = DetachedTimestampFile(OpSHA256(), Timestamp(bytes.fromhex(digest)))
    leaf = detached.timestamp.ops.add(OpAppend(b"synthetic calendar nonce"))
    leaf = leaf.ops.add(OpSHA256())
    leaf.attestations.add(
        BitcoinBlockHeaderAttestation(812345)
        if confirmed
        else PendingAttestation("https://alice.btc.calendar.opentimestamps.org")
    )
    return detached, leaf


class Calendar:
    calendar_root = staticmethod(PublicNetwork.calendar_root)

    def __init__(self, upgrade=False, error=None):
        self.calls, self.upgrade, self.error = [], upgrade, error

    def timestamp(self, root, commitment):
        self.calls.append((root, commitment))
        if self.error:
            raise self.error
        stamp = Timestamp(commitment)
        stamp.attestations.add(
            BitcoinBlockHeaderAttestation(812345)
            if self.upgrade
            else PendingAttestation(root)
        )
        return stamp


class FixtureBitcoin:
    def __init__(self, merkle_root):
        self.root, self.calls = merkle_root, []

    def verify(self, message, attestation):
        self.calls.append((message, attestation.height))
        try:
            attestation.verify_against_blockheader(
                message, SimpleNamespace(hashMerkleRoot=self.root, nTime=1234567890)
            )
        except Exception as error:
            raise EvidenceMismatch(
                "Bitcoin Merkle commitment does not match"
            ) from error
        return attestation.height


class AuditVerifierTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "audit_trail.jsonl"
        self.payload = {
            "timestamp_utc": "2026-10-06T12:00:00Z",
            "agent_id": "financial-agent",
            "session_id": "synthetic-session",
            "input_query": "synthetic assessment",
            "events": [],
            "final_response": {"output": "Human review"},
        }
        self.digest = sha256(self.payload)

    def journal(self, proof=True, confirmed=False, payload=None, identifier="trace-1"):
        payload = payload or self.payload
        digest = sha256(payload)
        journal = AuditJournal(self.path)
        journal.append(
            {
                "kind": "trace",
                "trace_id": identifier,
                "trace_hash": digest,
                "trace": payload,
            }
        )
        detached, leaf = receipt(digest, confirmed)
        if proof:
            journal.append(
                {
                    "kind": "status",
                    "trace_id": identifier,
                    "trace_hash": digest,
                    "hash": digest,
                    "status": "notarized",
                    "otsStatus": "pending_calendar",
                    "otsProofHex": serialize(detached).hex(),
                }
            )
        return detached, leaf

    def engine(self, upgrade=False, offline=False, merkle=None, error=None):
        engine = OtsVerifier(offline=offline)
        engine.network = Calendar(upgrade, error)
        engine.bitcoin = FixtureBitcoin(merkle or receipt(self.digest)[1].msg)
        return engine

    def rewrite_chain(self, records):
        previous = "0" * 64
        for index, record in enumerate(records, 1):
            record.pop("record_hash", None)
            record["sequence"], record["previous_record_hash"] = index, previous
            record["record_hash"] = sha256(record)
            previous = record["record_hash"]
        self.path.write_bytes(b"".join(canonical_json(r) + b"\n" for r in records))

    def test_pending_receipt_is_joined_to_trace_and_is_not_failure(self):
        self.journal()
        engine = self.engine()
        original = self.path.read_bytes()
        result = audit_journal(self.path, engine)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.traces[0].verdict.status, "pending")
        self.assertEqual(len(engine.network.calls), 1)
        self.assertEqual(engine.bitcoin.calls, [])
        self.assertIn("Pending Calendar Confirmation", render_report(result))
        self.assertIn(self.digest, render_report(result))
        self.assertIn("financial-agent", render_report(result))
        self.assertEqual(self.path.read_bytes(), original)

    def test_upgrade_then_verify_actual_ots_merkle_operations(self):
        self.journal()
        engine = self.engine(upgrade=True)
        result = audit_journal(self.path, engine)
        verdict = result.traces[0].verdict
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(verdict.status, "verified")
        self.assertEqual(verdict.height, 812345)
        self.assertTrue(engine.bitcoin.calls)
        self.assertIn("VERIFIED: Bitcoin Block #812345", render_report(result))
        self.assertTrue(
            any(
                isinstance(a, BitcoinBlockHeaderAttestation)
                for _, a in deserialize(
                    verdict.proof, self.digest
                ).timestamp.all_attestations()
            )
        )

    def test_confirmed_receipt_skips_calendar_but_checks_bitcoin(self):
        self.journal(confirmed=True)
        engine = self.engine()
        result = audit_journal(self.path, engine)
        self.assertEqual(result.traces[0].verdict.status, "verified")
        self.assertEqual(engine.network.calls, [])
        self.assertTrue(engine.bitcoin.calls)

    def test_archived_upgrade_can_be_reverified_without_the_calendar(self):
        self.journal()
        first = audit_journal(self.path, self.engine(upgrade=True))
        archive = Path(self.directory.name) / "receipts"
        saved = archive / f"{self.digest}.ots"
        write_private(saved, first.traces[0].verdict.proof, self.path)
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        second = audit_journal(self.path, self.engine(), archive)
        self.assertEqual(second.traces[0].verdict.status, "verified")
        self.assertEqual(second.traces[0].verdict.proof, first.traces[0].verdict.proof)
        saved.write_bytes(b"altered")
        self.assertEqual(
            audit_journal(self.path, self.engine(), archive).traces[0].verdict.status,
            "tamper",
        )

    def test_modified_trace_is_explicit_tamper_and_makes_no_network_calls(self):
        self.journal()
        self.path.write_bytes(
            self.path.read_bytes().replace(b"Human review", b"Auto approved")
        )
        engine = self.engine(upgrade=True)
        result = audit_journal(self.path, engine)
        self.assertEqual(result.exit_code, 1)
        self.assertIn("TAMPER EVIDENT FAILURE", render_report(result))
        self.assertEqual(engine.network.calls, [])

    def test_rehashed_modified_journal_still_cannot_fake_receipt_binding(self):
        self.journal()
        records = [json.loads(line) for line in self.path.read_text().splitlines()]
        records[0]["trace"]["final_response"]["output"] = "Altered"
        altered_digest = sha256(records[0]["trace"])
        for record in records:
            record["trace_hash"] = altered_digest
            if "hash" in record:
                record["hash"] = altered_digest
        self.rewrite_chain(records)
        engine = self.engine(upgrade=True)
        result = audit_journal(self.path, engine)
        self.assertEqual(result.issues, [])
        self.assertEqual(result.traces[0].verdict.status, "tamper")
        self.assertEqual(engine.network.calls, [])

    def test_valid_receipt_digest_but_wrong_bitcoin_commitment_is_tamper(self):
        self.journal(confirmed=True)
        result = audit_journal(self.path, self.engine(merkle=b"\xff" * 32))
        self.assertEqual(result.traces[0].verdict.status, "tamper")
        self.assertEqual(result.exit_code, 1)

    def test_calendar_outage_remains_pending(self):
        self.journal()
        result = audit_journal(self.path, self.engine(error=TimeoutError()))
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.traces[0].verdict.status, "pending")
        self.assertIn("calendar unavailable", result.traces[0].verdict.detail)

    def test_bitcoin_outage_is_unavailable_not_verified_or_tamper(self):
        self.journal(confirmed=True)
        engine = self.engine()
        engine.bitcoin.verify = lambda *_: (_ for _ in ()).throw(ConnectionError())
        result = audit_journal(self.path, engine)
        self.assertEqual(result.exit_code, 2)
        self.assertEqual(result.traces[0].verdict.status, "unavailable")

    def test_offline_has_zero_network_requests_and_checks_digest(self):
        self.journal()
        engine = self.engine(offline=True)
        result = audit_journal(self.path, engine)
        self.assertEqual(result.traces[0].verdict.status, "pending")
        self.assertEqual(engine.network.calls, [])
        self.assertEqual(engine.bitcoin.calls, [])

    def test_offline_bitcoin_attestation_is_not_reported_verified(self):
        self.journal(confirmed=True)
        result = audit_journal(self.path, self.engine(offline=True))
        self.assertEqual(result.exit_code, 2)
        self.assertEqual(result.traces[0].verdict.status, "unavailable")

    def test_report_escapes_untrusted_agent_text_in_markdown(self):
        self.payload["agent_id"] = "<script>alert(1)</script>"
        self.journal(proof=False)
        report = render_report(audit_journal(self.path, self.engine(offline=True)))
        self.assertIn("&lt;script&gt;", report)
        self.assertNotIn("<script>", report)

    def test_missing_receipt_is_visible_as_evidence_gap(self):
        self.journal(proof=False)
        result = audit_journal(self.path, self.engine())
        self.assertEqual(result.exit_code, 2)
        self.assertIn("No Verifiable OTS Receipt", render_report(result))

    def test_malformed_journal_and_invalid_identity_are_reported(self):
        self.journal()
        with self.path.open("ab") as stream:
            stream.write(b'{"kind":"status","trace_id":[]}\n{"incomplete":')
        result = audit_journal(self.path, self.engine())
        self.assertEqual(result.exit_code, 1)
        self.assertTrue(result.issues)

    def test_duplicate_json_keys_and_truncated_final_record_are_detected(self):
        self.journal()
        with self.path.open("ab") as stream:
            stream.write(b'{"kind":"status","kind":"trace"}\n')
        self.assertTrue(read_journal(self.path).issues)
        self.path.write_bytes(self.path.read_bytes().rstrip(b"\n"))
        self.assertTrue(read_journal(self.path).issues)

    def test_duplicate_trace_ids_fail_integrity(self):
        self.journal(proof=False)
        self.journal(proof=False)
        result = audit_journal(self.path, self.engine())
        self.assertEqual(result.exit_code, 1)

    def test_malformed_and_wrong_digest_receipts_are_rejected(self):
        with self.assertRaises(EvidenceMismatch):
            deserialize(b"malformed receipt", self.digest)
        with self.assertRaises(EvidenceMismatch):
            deserialize(serialize(receipt("11" * 32)[0]), self.digest)
        with self.assertRaises(EvidenceMismatch):
            deserialize(serialize(receipt(self.digest)[0]) + b"trailing", self.digest)

    def test_network_guard_blocks_mcp_and_untrusted_calendar_urls(self):
        network = PublicNetwork()
        for url in (
            "https://bitcoinstratigraphy.com/mcp",
            "http://127.0.0.1:5000/mcp",
            "https://attacker.example/timestamp/11",
        ):
            with self.assertRaises(VerificationUnavailable):
                network.get(url, 100)
        for uri in (
            "https://bitcoinstratigraphy.com",
            "https://user:password@alice.btc.calendar.opentimestamps.org",
            "https://alice.btc.calendar.opentimestamps.org/mcp",
        ):
            self.assertIsNone(network.calendar_root(uri))
        self.assertIsNotNone(
            network.calendar_root("https://alice.btc.calendar.opentimestamps.org")
        )

    def test_known_mainnet_genesis_header_pow_hash_and_merkle_root(self):
        header = checked_header(GENESIS_HEADER, GENESIS_HASH)
        attestation = BitcoinBlockHeaderAttestation(0)
        self.assertEqual(
            attestation.verify_against_blockheader(header.hashMerkleRoot, header),
            1231006505,
        )
        with self.assertRaises(VerificationUnavailable):
            checked_header(GENESIS_HEADER, "00" * 32)
        altered = GENESIS_HEADER[:-8] + "00000000"
        digest = (
            hashlib.sha256(hashlib.sha256(bytes.fromhex(altered)).digest())
            .digest()[::-1]
            .hex()
        )
        with self.assertRaises(VerificationUnavailable):
            checked_header(altered, digest)

    def test_public_bitcoin_requires_matching_independent_sources(self):
        class Headers:
            def __init__(self, disagree=False):
                self.disagree = disagree

            def get(self, url, _limit):
                if url.endswith("/block-height/0"):
                    return (
                        "11" * 32
                        if self.disagree and "mempool.space" in url
                        else GENESIS_HASH
                    ).encode()
                return GENESIS_HEADER.encode()

        provider = PublicBitcoin(Headers())
        root = checked_header(GENESIS_HEADER, GENESIS_HASH).hashMerkleRoot
        self.assertEqual(provider.verify(root, BitcoinBlockHeaderAttestation(0)), 0)
        with self.assertRaises(VerificationUnavailable):
            PublicBitcoin(Headers(True)).verify(root, BitcoinBlockHeaderAttestation(0))

    def test_core_cli_requires_successful_exit_and_actual_matching_height(self):
        proof = serialize(receipt(self.digest, True)[0])

        def run(arguments, **kwargs):
            self.assertNotIn("PYTHONPATH", kwargs["env"])
            self.assertNotIn("NWC_URI", kwargs["env"])
            self.assertIn("--no-default-whitelist", arguments)
            self.assertIn(self.digest, arguments)
            kwargs["stdout"].write(
                b"Success! Bitcoin block 812345 attests existence as of 2026-10-06\n"
            )
            return SimpleNamespace(returncode=0)

        with (
            patch("shutil.which", return_value="/trusted/ots"),
            patch("subprocess.run", side_effect=run),
        ):
            self.assertEqual(
                BitcoinCore().verify_receipt(proof, self.digest, {812345}), 812345
            )
            with self.assertRaises(VerificationUnavailable):
                BitcoinCore().verify_receipt(proof, self.digest, {999})

        def failed(arguments, **kwargs):
            run(arguments, **kwargs)
            return SimpleNamespace(returncode=1)

        with (
            patch("shutil.which", return_value="/trusted/ots"),
            patch("subprocess.run", side_effect=failed),
        ):
            with self.assertRaises(VerificationUnavailable):
                BitcoinCore().verify_receipt(proof, self.digest, {812345})

    def test_markdown_output_is_private_and_never_overwrites_source(self):
        self.journal()
        target = Path(self.directory.name) / "report.md"
        with patch("builtins.print"):
            self.assertEqual(
                main([str(self.path), "--offline", "--markdown", str(target)]), 0
            )
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertIn(self.digest, target.read_text())
        original = self.path.read_bytes()
        with patch("builtins.print"):
            self.assertEqual(
                main([str(self.path), "--offline", "--markdown", str(self.path)]), 2
            )
        with self.assertRaises(ValueError):
            write_private(self.path, b"overwrite", self.path)
        self.assertEqual(self.path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
