"""Finalization uses real OTS serialization and Bitcoin genesis-header evidence."""

import asyncio
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bitcoin_stratigraphy_enterprise.audit_verifier_ots import (
    OtsVerifier, PublicBitcoin, deserialize, serialize,
)
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpAppend, OpSHA256
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

from provenance_fixtures import MemoryArchive
from provenance_storage import StorageUnavailable
from provenance_upgrade import UPGRADE_INTERVAL, ProvenanceUpgrader, finalize_proof

GENESIS_HASH = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
GENESIS_HEADER = (
    "01000000" + "00" * 32
    + "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a"
    + "29ab5f49ffff001d1dac2b7c"
)
ROOT = bytes.fromhex(GENESIS_HEADER)[36:68]
CALENDAR = "https://alice.btc.calendar.opentimestamps.org"


def pending():
    receipt = DetachedTimestampFile(OpSHA256(), Timestamp(ROOT))
    receipt.timestamp.attestations.add(PendingAttestation(CALENDAR))
    # A separate pending branch must be pruned when the valid root is finalized.
    receipt.timestamp.ops.add(OpAppend(b"x")).attestations.add(PendingAttestation(CALENDAR))
    return serialize(receipt)


class Network:
    """Real historical Bitcoin evidence, deterministic transport only."""

    calendar_root = staticmethod(lambda uri: CALENDAR if uri == CALENDAR else None)

    def timestamp(self, root, message):
        stamp = Timestamp(message)
        stamp.attestations.add(BitcoinBlockHeaderAttestation(0))
        return stamp

    def get(self, url, limit):
        return (GENESIS_HASH if "/block-height/" in url else GENESIS_HEADER).encode()


def verifier(network=None):
    value = OtsVerifier()
    value.network = network or Network()
    value.bitcoin = PublicBitcoin(value.network)
    return value


class FinalizationTests(unittest.TestCase):
    def test_upgrade_checks_real_header_and_prunes_calendar_dependencies(self):
        upgraded = finalize_proof(pending(), verifier=verifier())
        receipt = deserialize(upgraded, ROOT.hex())
        self.assertEqual(list(receipt.timestamp.all_attestations()), [(ROOT, BitcoinBlockHeaderAttestation(0))])
        self.assertFalse(receipt.timestamp.ops)
        self.assertIsNone(finalize_proof(upgraded))

    def test_unmined_and_outage_leave_original_unchanged(self):
        for status in ("pending", "unavailable", "tamper"):
            fake = SimpleNamespace(verify=lambda *args: SimpleNamespace(status=status, proof=None))
            self.assertIsNone(finalize_proof(pending(), verifier=fake))

    def test_header_tamper_and_source_disagreement_are_not_published(self):
        class Tampered(Network):
            def get(self, url, limit):
                if "/header" in url:
                    return (GENESIS_HEADER[:-2] + "00").encode()
                return super().get(url, limit)

        class Disagree(Network):
            def get(self, url, limit):
                if "mempool.space" in url and "/block-height/" in url:
                    return b"1" * 64
                return super().get(url, limit)

        for network in (Tampered(), Disagree()):
            self.assertIsNone(finalize_proof(pending(), verifier=verifier(network)))

    def test_merkle_mismatch_not_published(self):
        proof = DetachedTimestampFile(OpSHA256(), Timestamp(b"x" * 32))
        proof.timestamp.attestations.add(PendingAttestation(CALENDAR))
        self.assertIsNone(finalize_proof(serialize(proof), verifier=verifier()))

    def test_malformed_receipt_rejected(self):
        for proof in (b"garbage", pending() + b"extra"):
            with self.assertRaises(Exception):
                finalize_proof(proof)


class StorageTests(unittest.TestCase):
    def test_all_bucket_proofs_and_atomic_generation_replacement(self):
        storage = MemoryArchive()
        storage.objects.update({"other/receipt.ots": pending(), "unrelated.json": b"data"})
        self.assertEqual(list(storage.proof_keys()), ["other/receipt.ots"])
        original, generation = storage.read_proof_version("other/receipt.ots")
        final = finalize_proof(original, verifier=verifier())
        self.assertTrue(storage.replace_proof("other/receipt.ots", final, generation))
        self.assertFalse(storage.replace_proof("other/receipt.ots", original, generation))
        self.assertEqual(storage.objects["other/receipt.ots"], final)
        self.assertEqual(storage.objects["unrelated.json"], b"data")
        self.assertIsNone(storage.read_proof_version("absent.ots"))

    def test_storage_outage_explicit(self):
        storage = MemoryArchive()
        storage.objects["proof.ots"] = pending()
        storage.fail_download = True
        with self.assertRaises(StorageUnavailable):
            storage.read_proof_version("proof.ots")
        storage.fail_download = False
        _, generation = storage.read_proof_version("proof.ots")
        storage.fail_upload = True
        with self.assertRaises(StorageUnavailable):
            storage.replace_proof("proof.ots", pending(), generation)

    def test_bad_object_does_not_interrupt_other_proofs(self):
        storage = MemoryArchive()
        storage.objects.update({"a.ots": b"invalid", "b.ots": pending()})
        real_finalize = finalize_proof
        with patch("provenance_upgrade.finalize_proof", side_effect=lambda body: real_finalize(body, verifier=verifier())):
            ProvenanceUpgrader(storage).upgrade_all()
        self.assertEqual(storage.objects["a.ots"], b"invalid")
        self.assertFalse(any(
            isinstance(a, PendingAttestation)
            for _, a in deserialize(storage.objects["b.ots"], ROOT.hex()).timestamp.all_attestations()
        ))

    def test_stop_during_verification_prevents_publication(self):
        storage = MemoryArchive()
        storage.objects["proof.ots"] = pending()
        worker = ProvenanceUpgrader(storage)

        def complete(body):
            worker._stopped.set()
            return finalize_proof(body, verifier=verifier())

        with patch("provenance_upgrade.finalize_proof", side_effect=complete):
            worker.upgrade_all()
        self.assertEqual(storage.objects["proof.ots"], pending())

    def test_daily_snapshot_mismatch_prevents_upgrade(self):
        storage = MemoryArchive()
        day = "2026-10-12"
        storage.put(day, b"not the committed snapshot")
        storage.put(day, pending(), proof=True)
        with patch("provenance_upgrade.finalize_proof") as upgrade:
            ProvenanceUpgrader(storage).upgrade_all()
        upgrade.assert_not_called()
        self.assertEqual(storage.get(day, proof=True), pending())


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_separate_thread_event_loop_responsive_and_repeat_after_failure(self):
        worker = ProvenanceUpgrader(MemoryArchive(), interval=0.02)
        main_thread = threading.get_ident()
        started, release = threading.Event(), threading.Event()
        calls = []

        def blocking_scan():
            calls.append(threading.get_ident())
            started.set()
            release.wait(1)
            raise StorageUnavailable("test outage")

        with patch.object(worker, "upgrade_all", side_effect=blocking_scan):
            try:
                await worker.start()
                await worker.start()  # Idempotent: never duplicate the worker.
                for _ in range(100):
                    if started.is_set():
                        break
                    await asyncio.sleep(0.005)
                self.assertTrue(started.is_set())
                self.assertNotEqual(calls[0], main_thread)
                self.assertEqual(len(calls), 1)
                release.set()
                for _ in range(100):
                    if len(calls) >= 2:
                        break
                    await asyncio.sleep(0.005)
                self.assertGreaterEqual(len(calls), 2)
            finally:
                release.set()
                await worker.stop()
            self.assertIsNone(worker._task)
            self.assertIsNone(worker._executor)

    def test_default_interval_is_six_hours(self):
        self.assertEqual(UPGRADE_INTERVAL, 21600)
        self.assertEqual(ProvenanceUpgrader(MemoryArchive()).interval, 21600)
