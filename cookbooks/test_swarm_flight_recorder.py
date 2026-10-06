"""Exhaustive RFC-style tree/paths, privacy, concurrency and offline evidence.

No wallet use or remote network calls. OTS test fixtures are explicitly synthetic.
"""
import hashlib
import io
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

from cookbooks.article_12_journal import canonical_json
from cookbooks.audit_verifier_ots import serialize
from cookbooks.swarm_merkle import (
    MerkleAccumulator, MerkleProofError, leaf_hash, node_hash, split_size, verify_merkle_inclusion,
)
from cookbooks.swarm_flight_evidence import (
    DisclosureError, LEAF_SCHEMA, leaf_preimage, verify_inclusion_proof,
)
from cookbooks.swarm_flight_recorder import SwarmFlightRecorder, main


def reference_root(leaves):
    # Independent RFC 6962 2.1 definition: deliberately no accumulator helpers.
    if not leaves:
        return hashlib.sha256(b"").digest()
    if len(leaves) == 1:
        return hashlib.sha256(b"\x00" + leaves[0]).digest()
    split = 1
    while split * 2 < len(leaves):
        split *= 2
    return hashlib.sha256(b"\x01" + reference_root(leaves[:split]) + reference_root(leaves[split:])).digest()


class SyntheticNotary:
    def __init__(self, *, bitcoin=False, empty=False, wrong=False, fail=False):
        self.calls = []
        self.bitcoin, self.empty, self.wrong, self.fail = bitcoin, empty, wrong, fail

    def notarize(self, root):
        self.calls.append(root)
        if self.fail:
            raise RuntimeError("Simulated uncertain request; secret provider diagnostic")
        stamp = Timestamp(bytes.fromhex(root))
        if not self.empty:
            stamp.attestations.add(BitcoinBlockHeaderAttestation(999) if self.bitcoin
                                   else PendingAttestation("https://alice.btc.calendar.opentimestamps.org"))
        return {"hash": "00" * 32 if self.wrong else root,
                "otsProofHex": serialize(DetachedTimestampFile(OpSHA256(), stamp)).hex(),
                "otsStatus": "pending_calendar"}


class MerkleLogicTests(unittest.TestCase):
    def test_empty_singleton_and_domain_separation(self):
        tree = MerkleAccumulator()
        self.assertEqual(bytes.fromhex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
                         tree.root)
        self.assertEqual(0, tree.append(b""))
        self.assertEqual(reference_root([b""]), tree.root)
        self.assertEqual([], tree.inclusion_path(0))
        self.assertTrue(verify_merkle_inclusion(b"", 0, 1, [], tree.root))
        self.assertNotEqual(leaf_hash(b"\x00" * 64), node_hash(b"\x00" * 32, b"\x00" * 32))

    def test_every_prefix_and_every_leaf_against_independent_rfc_reference(self):
        tree, leaves = MerkleAccumulator(), []
        # Includes odd/non-power-of-two trees and all boundaries through 128.
        for count in range(1, 129):
            payload = canonical_json({"step": count, "unicode": "企業 Δ", "context": {"x": count}})
            self.assertEqual(count - 1, tree.append(payload))
            leaves.append(payload)
            root = reference_root(leaves)
            self.assertEqual(root, tree.root, count)
            for index, value in enumerate(leaves):
                path = tree.inclusion_path(index)
                self.assertTrue(verify_merkle_inclusion(value, index, count, path, root), (count, index))
                self.assertFalse(verify_merkle_inclusion(value + b" ", index, count, path, root))

    def test_duplicate_leaves_remain_ordered_without_last_leaf_padding(self):
        tree = MerkleAccumulator()
        for data in (b"a", b"b", b"b"):
            tree.append(data)
        self.assertEqual(reference_root([b"a", b"b", b"b"]), tree.root)
        self.assertNotEqual(reference_root([b"a", b"b", b"b", b"b"]), tree.root)
        for index in range(3):
            data = b"a" if index == 0 else b"b"
            self.assertTrue(verify_merkle_inclusion(data, index, 3, tree.inclusion_path(index), tree.root))

    def test_all_tree_input_guards_and_capacity_atomicity(self):
        for value in (0, -1, True, 1.5, 1_000_001):
            with self.subTest(value=value), self.assertRaises(MerkleProofError):
                MerkleAccumulator(value)
        for value in (0, 1, True, 2.5, 1_000_001):
            with self.assertRaises(MerkleProofError):
                split_size(value)
        tree = MerkleAccumulator(1)
        with self.assertRaises(MerkleProofError):
            tree.append("not bytes")
        with self.assertRaises(MerkleProofError):
            tree.inclusion_path(0)
        tree.append(b"one")
        original = tree.root
        with self.assertRaises(MerkleProofError):
            tree.append(b"two")
        self.assertEqual(1, tree.size)
        self.assertEqual(original, tree.root)
        for index in (-1, 1, True, "0"):
            with self.assertRaises(MerkleProofError):
                tree.inclusion_path(index)
        for left, right in [(b"short", b"x" * 32), (b"x" * 32, b"short"),
                            ("x" * 32, b"x" * 32), (b"x" * 32, "x" * 32)]:
            with self.assertRaises(MerkleProofError):
                node_hash(left, right)

    def test_verifier_rejects_malformed_short_extra_and_wrong_paths(self):
        tree = MerkleAccumulator()
        for value in (b"a", b"b", b"c"):
            tree.append(value)
        path, root = tree.inclusion_path(0), tree.root
        invalid = [
            (b"a", True, 3, path, root), (b"a", 3, 3, path, root),
            (b"a", 0, 0, path, root), (b"a", 0, True, path, root),
            (b"a", 0, 1_000_001, path, root), (b"a", 0, 3, path, b"short"),
            (b"a", 0, 3, path, "x" * 32), (b"a", 0, 3, tuple(path), root),
            (b"a", 0, 3, [b"x" * 32] * 21, root), (b"a", 0, 3, [b"short"], root),
            (b"a", 0, 3, ["x" * 32], root), (b"a", 0, 3, path[:-1], root),
            (b"a", 0, 3, path + [b"x" * 32], root), ("a", 0, 3, path, root),
        ]
        for args in invalid:
            with self.subTest(args=args[1:3]), self.assertRaises(MerkleProofError):
                verify_merkle_inclusion(*args)
        self.assertFalse(verify_merkle_inclusion(b"a", 0, 3, list(reversed(path)), root))
        self.assertFalse(verify_merkle_inclusion(b"a", 1, 3, path, root))
        self.assertFalse(verify_merkle_inclusion(b"a", 0, 3, path, b"\x00" * 32))


class FlightRecorderTests(unittest.TestCase):
    def make_disclosure(self, notary=None):
        recorder = SwarmFlightRecorder(notary)
        recorder.record_trace({"agent": "one", "thought": "Private corporate context", "tool": "validate"})
        recorder.record_trace({"agent": "two", "decision": "Deny PII export"})
        recorder.record_trace({"agent": "three", "context": "SECRET-NON-DISCLOSED-SWARM-IP"})
        receipt = recorder.flush_root()
        return recorder, receipt, recorder.export_disclosure(1)

    def verify(self, bundle, **kwargs):
        return verify_inclusion_proof(bundle["trace"], bundle["merkle_proof"], bundle["root_receipt"], **kwargs)

    def clone(self, value):
        return json.loads(canonical_json(value))

    def test_only_selected_trace_is_exported_and_no_fake_bitcoin_claim(self):
        recorder, receipt, bundle = self.make_disclosure()
        report = self.verify(bundle, expected_recorder_key=recorder.public_key)
        self.assertTrue(report["merkle_inclusion_verified"])
        self.assertTrue(report["recorder_key_pinned"])
        self.assertFalse(report["bitcoin_inclusion_verified"])
        self.assertEqual("Deferred/Pending Credential", report["detail"])
        self.assertIsNone(receipt["body"]["anchoring"]["otsProofHex"])
        self.assertEqual({"agent": "two", "decision": "Deny PII export"}, bundle["trace"])
        self.assertNotIn("SECRET-NON-DISCLOSED-SWARM-IP", json.dumps(bundle))
        self.assertNotIn("Private corporate context", json.dumps(bundle))
        self.assertIn("not a zero-knowledge proof", report["limitations"])
        self.assertEqual(0, recorder.pending_count)

    def test_one_paid_call_per_batch_and_empty_flush_does_not_repay(self):
        notary = SyntheticNotary()
        recorder, receipt, bundle = self.make_disclosure(notary)
        self.assertEqual([receipt["body"]["root_hash"]], notary.calls)
        self.assertEqual("pending", self.verify(bundle)["status"])
        self.assertFalse(self.verify(bundle)["bitcoin_inclusion_verified"])
        self.assertEqual(receipt, recorder.flush_root())
        self.assertEqual(1, len(notary.calls))
        receipt["body"]["root_hash"] = "00" * 32
        self.assertEqual(notary.calls[0], recorder.flush_root()["body"]["root_hash"])
        recorder.add_trace({"event": "second batch"})
        second = recorder.flush_root()
        self.assertNotEqual(bundle["root_receipt"]["body"]["batch_id"], second["body"]["batch_id"])
        self.assertEqual(2, len(notary.calls))
        self.assertTrue(self.verify(recorder.export_disclosure(0))["merkle_inclusion_verified"])
        self.assertTrue(self.verify(recorder.export_disclosure(1, batch_id=bundle["merkle_proof"]["batch_id"]))[
            "merkle_inclusion_verified"])

    def test_random_leaf_salts_prevent_identical_trace_fingerprints(self):
        recorder = SwarmFlightRecorder()
        recorder.append_trace({"same": "low entropy"})
        recorder.append_trace({"same": "low entropy"})
        recorder.flush_root()
        a, b = recorder.export_disclosure(0), recorder.export_disclosure(1)
        self.assertNotEqual(a["merkle_proof"]["leaf_salt"], b["merkle_proof"]["leaf_salt"])
        self.assertTrue(self.verify(a)["merkle_inclusion_verified"])
        self.assertTrue(self.verify(b)["merkle_inclusion_verified"])

    def test_trace_and_nested_context_detached_from_caller_mutations(self):
        recorder = SwarmFlightRecorder()
        payload = {"context": {"policy": ["original"]}}
        recorder.record_trace(payload)
        payload["context"]["policy"][0] = "changed"
        recorder.flush_root()
        bundle = recorder.export_disclosure(0)
        self.assertEqual("original", bundle["trace"]["context"]["policy"][0])
        bundle["trace"]["context"]["policy"][0] = "also changed"
        self.assertEqual("original", recorder.export_disclosure(0)["trace"]["context"]["policy"][0])

    def test_fifty_concurrent_agents_are_recorded_once(self):
        recorder = SwarmFlightRecorder()
        with ThreadPoolExecutor(max_workers=50) as pool:
            indices = list(pool.map(lambda i: recorder.record_trace({"agent": i, "event": "execute"}), range(1000)))
        self.assertEqual(set(range(1000)), set(indices))
        recorder.flush_root()
        for index in (0, 13, 499, 999):
            self.assertTrue(self.verify(recorder.export_disclosure(index))["merkle_inclusion_verified"])

    def test_appends_continue_during_notary_io_and_roots_are_frozen(self):
        entered, release = threading.Event(), threading.Event()
        notary = SyntheticNotary()

        class SlowNotary:
            def notarize(self, root):
                entered.set()
                if not release.wait(3):
                    raise TimeoutError("Test coordination timeout")
                return notary.notarize(root)

        recorder = SwarmFlightRecorder(SlowNotary())
        recorder.record_trace({"event": "before flush"})
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(recorder.flush_root)
            self.assertTrue(entered.wait(3))
            self.assertEqual(0, recorder.record_trace({"event": "during flush"}))
            self.assertEqual(1, recorder.pending_count)
            release.set()
            first = future.result(timeout=3)
        self.assertEqual(1, first["body"]["tree_size"])
        self.assertTrue(self.verify(recorder.export_disclosure(0))["merkle_inclusion_verified"])
        second = recorder.flush_root()
        self.assertNotEqual(first["body"]["root_hash"], second["body"]["root_hash"])

    def test_concurrent_flushes_do_not_duplicate_quota_redemption(self):
        recorder = SwarmFlightRecorder(SyntheticNotary())
        recorder.record_trace({"event": "one"})
        with ThreadPoolExecutor(max_workers=8) as pool:
            receipts = list(pool.map(lambda _: recorder.flush_root(), range(8)))
        self.assertTrue(all(receipt == receipts[0] for receipt in receipts))
        self.assertEqual(1, len(recorder.notarizer.calls))

    def test_one_character_trace_salt_path_receipt_and_cross_batch_tampering(self):
        _, _, bundle = self.make_disclosure()
        mutations = [
            lambda b: b["trace"].update(decision="Deny PII expOrt"),
            lambda b: b["merkle_proof"].update(leaf_salt="00" * 32),
            lambda b: b["merkle_proof"].update(leaf_index=0),
            lambda b: b["merkle_proof"].update(tree_size=4),
            lambda b: b["merkle_proof"].update(batch_id="another batch"),
            lambda b: b["merkle_proof"].update(path=["00" * 32] * 2),
            lambda b: b["root_receipt"]["body"].update(root_hash="00" * 32),
            lambda b: b["root_receipt"].update(signature="00" * 64),
            lambda b: b["root_receipt"]["body"]["anchoring"].update(status="unavailable"),
            lambda b: b["merkle_proof"].update(extra="not ignored"),
        ]
        for mutation in mutations:
            changed = self.clone(bundle)
            mutation(changed)
            with self.assertRaises(DisclosureError):
                self.verify(changed)
        _, _, other = self.make_disclosure()
        bundle["root_receipt"] = other["root_receipt"]
        with self.assertRaises(DisclosureError):
            self.verify(bundle)

    def test_independently_enrolled_recorder_key_and_hex_guards(self):
        recorder, _, bundle = self.make_disclosure()
        for key in ("00" * 32, "bad", recorder.public_key.upper()):
            with self.assertRaises(DisclosureError):
                self.verify(bundle, expected_recorder_key=key)
        for salt in ("z" * 64, "00 " * 21 + "0", True):
            changed = self.clone(bundle)
            changed["merkle_proof"]["leaf_salt"] = salt
            with self.assertRaises(DisclosureError):
                self.verify(changed)

    def test_limits_are_explicit_and_release_restores_capacity(self):
        recorder = SwarmFlightRecorder(max_leaves=1, max_retained_batches=1, max_buffer_bytes=1024)
        with self.assertRaises(MerkleProofError):
            recorder.flush_root()
        with self.assertRaises(ValueError):
            recorder.generate_inclusion_proof(0)
        recorder.record_trace({"event": "one"})
        with self.assertRaises(MerkleProofError):
            recorder.record_trace({"event": "two"})
        first = recorder.flush_root()
        recorder.record_trace({"event": "three"})
        with self.assertRaises(BufferError):
            recorder.flush_root()
        recorder.release_batch(first["body"]["batch_id"])
        with self.assertRaises(ValueError):
            recorder.export_disclosure(0, batch_id=first["body"]["batch_id"])
        self.assertEqual(1, recorder.flush_root()["body"]["tree_size"])
        for value in ("", 0, [], "missing"):
            with self.assertRaises(ValueError):
                recorder.generate_inclusion_proof(0, batch_id=value)
        with self.assertRaises(MerkleProofError):
            recorder.generate_inclusion_proof(-1)
        latest = recorder.flush_root()
        recorder.release_batch(latest["body"]["batch_id"])
        with self.assertRaises(ValueError):
            recorder.flush_root()
        tight = SwarmFlightRecorder(max_buffer_bytes=1024)
        with self.assertRaises(BufferError):
            tight.record_trace({"data": "x" * 1024})
        self.assertEqual(0, tight.pending_count)

    def test_invalid_capacity_keys_and_trace_inputs(self):
        for kwargs in ({"max_leaves": True}, {"max_retained_batches": 0},
                       {"max_retained_batches": True}, {"max_buffer_bytes": 1},
                       {"signing_key": "not a key"}):
            with self.assertRaises(ValueError):
                SwarmFlightRecorder(**kwargs)
        recorder = SwarmFlightRecorder()
        for payload in ([], {"huge": "x" * 65536}, {"bad": float("nan")},
                        {"bad": float("inf")}, {1: "numeric", "1": "collision"},
                        {1: "numeric key"}, {"tuple": (1, 2)}):
            with self.assertRaises((ValueError, TypeError)):
                recorder.record_trace(payload)
        self.assertEqual(0, recorder.pending_count)
        expected = canonical_json({"schema_version": LEAF_SCHEMA, "salt": "ab" * 32, "trace": {"x": "企業"}})
        self.assertEqual(expected, leaf_preimage({"x": "企業"}, "ab" * 32))

    def test_unknown_or_invalid_notary_outcome_is_sealed_and_not_retried(self):
        for notary in (SyntheticNotary(fail=True), SyntheticNotary(wrong=True), SyntheticNotary(empty=True)):
            recorder, receipt, bundle = self.make_disclosure(notary)
            self.assertEqual("unavailable", self.verify(bundle)["status"])
            self.assertTrue(receipt["body"]["anchoring"]["settlement_unknown"])
            self.assertIsNone(receipt["body"]["anchoring"]["otsProofHex"])
            self.assertEqual(receipt, recorder.flush_root())
            self.assertEqual(1, len(notary.calls))
            self.assertNotIn("secret provider", json.dumps(bundle))

    def test_failed_seal_reserves_batch_without_repaying(self):
        recorder = SwarmFlightRecorder(SyntheticNotary())
        key = recorder._key
        recorder._key = SimpleNamespace(public_key=key.public_key,
                                        sign=lambda _: (_ for _ in ()).throw(RuntimeError("Key outage")))
        recorder.record_trace({"event": "one"})
        with self.assertRaises(RuntimeError):
            recorder.flush_root()
        with self.assertRaises(ValueError):
            recorder.flush_root()
        self.assertEqual(1, len(recorder.notarizer.calls))

    def test_ots_proof_bytes_bound_to_root_and_sealed_metadata(self):
        recorder, _, bundle = self.make_disclosure(SyntheticNotary())
        anchor = bundle["root_receipt"]["body"]["anchoring"]
        for proof in ("zz", anchor["otsProofHex"] + "00", "aa" * (512 * 1024 + 1)):
            changed = self.clone(bundle)
            changed["root_receipt"]["body"]["anchoring"]["otsProofHex"] = proof
            changed["root_receipt"]["signature"] = recorder._key.sign(
                canonical_json(changed["root_receipt"]["body"])).hex()
            with self.assertRaises(DisclosureError):
                self.verify(changed)
        _, _, other = self.make_disclosure(SyntheticNotary())
        with self.assertRaises(DisclosureError):
            self.verify(bundle, upgraded_ots_proof_hex=other["root_receipt"]["body"]["anchoring"]["otsProofHex"])

    def test_pending_original_can_be_upgraded_without_rewriting_receipt(self):
        _, _, bundle = self.make_disclosure(SyntheticNotary())
        original = self.clone(bundle)
        root = bundle["root_receipt"]["body"]["root_hash"]
        upgraded = SyntheticNotary(bitcoin=True).notarize(root)["otsProofHex"]
        report = self.verify(bundle, upgraded_ots_proof_hex=upgraded)
        self.assertEqual("unavailable", report["status"])
        self.assertEqual(original, bundle)

    def test_bitcoin_confirmation_requires_independent_headers_and_commitment(self):
        _, receipt, bundle = self.make_disclosure(SyntheticNotary(bitcoin=True))
        self.assertFalse(self.verify(bundle)["bitcoin_inclusion_verified"])
        self.assertEqual("unavailable", self.verify(bundle, trusted_headers={1: {}})["status"])
        headers = {"999": {"block_hash": "00" * 32, "header_hex": "00" * 80}}
        with self.assertRaises(DisclosureError):
            self.verify(bundle, trusted_headers=headers)
        root = bytes.fromhex(receipt["body"]["root_hash"])
        # Synthetic trusted-header fixture only, not a claim of actual Bitcoin anchoring.
        with patch("cookbooks.swarm_flight_evidence.checked_header",
                   return_value=SimpleNamespace(hashMerkleRoot=root, nTime=1791288000)):
            report = self.verify(bundle, trusted_headers=headers)
        self.assertTrue(report["bitcoin_inclusion_verified"])
        self.assertEqual("verified_bitcoin", report["status"])
        with patch("cookbooks.swarm_flight_evidence.checked_header",
                   return_value=SimpleNamespace(hashMerkleRoot=b"\x00" * 32, nTime=1791288000)):
            with self.assertRaises(DisclosureError):
                self.verify(bundle, trusted_headers=headers)

    def test_offline_cli_and_tampered_file_rejection(self):
        recorder, _, bundle = self.make_disclosure()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "disclosure.json"
            path.write_bytes(canonical_json(bundle))
            with patch("sys.stdout", new_callable=io.StringIO) as output, patch(
                    "cookbooks.swarm_flight_recorder.PrepaidMacroNotarizer") as notary:
                self.assertEqual(2, main(["--verify", str(path), "--recorder-key", recorder.public_key]))
            notary.assert_not_called()
            self.assertTrue(json.loads(output.getvalue())["merkle_inclusion_verified"])
            bundle["trace"]["decision"] += "!"
            path.write_bytes(canonical_json(bundle))
            with patch("sys.stderr", new_callable=io.StringIO) as output:
                self.assertEqual(1, main(["--verify", str(path)]))
            self.assertNotIn("Deny PII", output.getvalue())

    def test_demo_simulates_50_agents_without_using_available_credentials(self):
        with patch.dict("os.environ", {"L402_AUTHORIZATION": "fake-sensitive-token"}), patch(
                "sys.stdout", new_callable=io.StringIO) as output, patch(
                "cookbooks.swarm_flight_recorder.PrepaidMacroNotarizer") as notary:
            self.assertEqual(0, main([]))
        notary.assert_not_called()
        self.assertIn("50 synthetic agents; 1000 traces", output.getvalue())
        self.assertIn("Deferred/Pending Credential", output.getvalue())
        self.assertNotIn("fake-sensitive-token", output.getvalue())
        with patch.dict("os.environ", {}, clear=True), patch(
                "sys.stdout", new_callable=io.StringIO):
            self.assertEqual(0, main(["--production"]))

    def test_production_uses_existing_macro_adapter_for_one_root(self):
        token = "L402 synthetic-macaroon:" + "01" * 32
        notary = SyntheticNotary()
        with patch.dict("os.environ", {"L402_AUTHORIZATION": token}), patch(
                "cookbooks.swarm_flight_recorder.PrepaidMacroNotarizer", return_value=notary) as adapter, patch(
                "sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(0, main(["--production", "--url", "https://example.test/mcp"]))
        adapter.assert_called_once_with(token, "https://example.test/mcp")
        self.assertEqual(1, len(notary.calls))
        self.assertNotIn(token, output.getvalue())


if __name__ == "__main__":
    unittest.main()
