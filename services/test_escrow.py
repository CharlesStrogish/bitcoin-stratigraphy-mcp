# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Stdlib-only regression checks for the isolated escrow service."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from bitcoin_stratigraphy_enterprise.swarm_merkle import verify_merkle_inclusion
from services.escrow_db import EscrowStore
from services.escrow_engine import (
    EscrowEngine, EscrowStateError, agent_attribution_digest, trace_context_digest,
)


def settle_in_process(path, escrow_id):
    return EscrowEngine(
        EscrowStore(path), strata_block_provider=lambda: 900000
    ).verify_execution_and_settle(escrow_id, "trace", "result")["receipt"]["leaf_index"]


class EscrowTests(unittest.TestCase):
    def setUp(self):
        price = patch("services.escrow_pricing.read_bitcoin_usd_price", return_value=None)
        price.start()
        self.addCleanup(price.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "private" / "escrow.sqlite3"
        self.store = EscrowStore(self.path)
        self.engine = EscrowEngine(self.store, strata_block_provider=lambda: 900000)
        self.task = hashlib.sha256(b"task").hexdigest()

    def create(self, engine=None):
        return (engine or self.engine).create_l402_escrow(
            "a" * 64, "b" * 64, self.task, 1000
        )

    def test_traceparent_is_committed_before_receipt_release(self):
        from routers.escrow_api import EscrowApi

        context = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        for agent in (None, "planner-7"):
            created = self.create()
            settled = self.engine.verify_execution_and_settle(
                created["escrow_id"], "trace", "result", agent_id=agent, traceparent=context,
            )
            receipt = settled["receipt"]
            self.assertEqual(receipt["traceparent"], context)
            with self.store.connection() as connection:
                row = connection.execute(
                    "SELECT leaf_preimage FROM escrow_execution_leaves WHERE escrow_id=?",
                    (created["escrow_id"],),
                ).fetchone()
            data = row["leaf_preimage"]
            self.assertEqual(len(data), 160)
            self.assertEqual(data[128:], trace_context_digest(context))
            self.assertTrue(verify_merkle_inclusion(
                data, receipt["leaf_index"], receipt["tree_size"],
                [bytes.fromhex(item) for item in receipt["audit_path"]],
                bytes.fromhex(receipt["merkle_root"]),
            ))
            api = EscrowApi(self.engine)
            self.assertEqual(api.dispatch("receipt", {"escrow_id": created["escrow_id"]})[0], 200)
            receipt["traceparent"] = context[:-2] + "00"
            with self.store.transaction() as connection:
                connection.execute(
                    "UPDATE escrow_execution_leaves SET receipt_json=? WHERE escrow_id=?",
                    (json.dumps(receipt), created["escrow_id"]),
                )
            self.assertEqual(api.dispatch("receipt", {"escrow_id": created["escrow_id"]})[0], 422)

    def test_invalid_traceparent_cannot_create_a_settlement(self):
        created = self.create()
        for value in ("invalid", "00-" + "0" * 32 + "-00f067aa0ba902b7-01"):
            with self.assertRaises(ValueError):
                self.engine.verify_execution_and_settle(
                    created["escrow_id"], "trace", "result", traceparent=value,
                )
        self.assertEqual(self.store.get_contract(created["escrow_id"])["status"], "LOCKED")

    def test_legacy_leaf_constraint_upgrade_preserves_committed_bytes(self):
        from services.escrow_db import SCHEMA
        import sqlite3

        path = Path(self.directory.name) / "private" / "legacy.sqlite3"
        connection = sqlite3.connect(path)
        connection.executescript(SCHEMA.replace("(96, 128, 160)", "(96, 128)"))
        connection.close()
        os.chmod(path, 0o600)
        with patch.object(EscrowStore, "_upgrade_trace_leaf_constraint"):
            store = EscrowStore(path)
        engine = EscrowEngine(store, strata_block_provider=lambda: 900000)
        created = self.create(engine)
        legacy = engine.verify_execution_and_settle(created["escrow_id"], "trace", "result")
        with store.connection() as connection:
            before = connection.execute(
                "SELECT leaf_preimage, receipt_json FROM escrow_execution_leaves",
            ).fetchone()
        # Reopening is idempotent, including custody data and exact leaf bytes.
        EscrowStore(path)
        with store.connection() as connection:
            after = connection.execute(
                "SELECT leaf_preimage, receipt_json FROM escrow_execution_leaves",
            ).fetchone()
            self.assertEqual(tuple(before), tuple(after))
        self.verify_receipt(legacy["receipt"])

    def verify_receipt(self, receipt, trace="trace", result="result"):
        data = (
            bytes.fromhex(self.task)
            + hashlib.sha256(trace.encode("utf-8")).digest()
            + hashlib.sha256(result.encode("utf-8")).digest()
        )
        self.assertEqual(
            hashlib.sha256(b"\x00" + data).hexdigest(),
            receipt["execution_leaf_hash"],
        )
        self.assertTrue(verify_merkle_inclusion(
            data, receipt["leaf_index"], receipt["tree_size"],
            [bytes.fromhex(item) for item in receipt["audit_path"]],
            bytes.fromhex(receipt["merkle_root"]),
        ))

    def test_create_pragmas_and_private_storage(self):
        created = self.create()
        self.assertEqual(uuid.UUID(created["escrow_id"]).version, 4)
        self.assertEqual(set(created), {"escrow_id", "payment_hash", "toll_fee_sats"})
        metadata = self.store.get_contract(created["escrow_id"])
        self.assertNotIn("preimage", metadata)
        self.assertEqual(metadata["status"], "LOCKED")
        self.assertEqual(metadata["toll_fee_sats"], 21)
        self.assertEqual(metadata["amount_sats"], 1000)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        with self.store.connection() as connection:
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(connection.execute("PRAGMA busy_timeout").fetchone()[0], 5000)
            self.assertEqual(connection.execute("PRAGMA synchronous").fetchone()[0], 1)

    def test_exact_hash_and_private_release(self):
        created = self.create()
        trace, result = "trace \u2603\n", '{"result": 1}'
        settled = self.engine.verify_execution_and_settle(created["escrow_id"], trace, result)
        self.assertEqual(
            hashlib.sha256(bytes.fromhex(settled["preimage"])).hexdigest(),
            created["payment_hash"],
        )
        self.verify_receipt(settled["receipt"], trace, result)
        self.assertNotIn('"preimage":', json.dumps(settled["receipt"]))
        self.assertNotIn(settled["preimage"], json.dumps(settled["receipt"]))
        self.assertEqual(self.store.get_contract(created["escrow_id"])["status"], "SETTLED")
        self.assertEqual(settled["receipt"]["settled_at_strata_block"], 900000)
        self.assertEqual(
            settled["receipt"]["ots_calendar_standard"],
            "OpenTimestamps / RFC 6962 SHA-256",
        )
        self.assertIn("Nostr Kind 38102", settled["receipt"]["attestation_directive"])
        with self.assertRaises(EscrowStateError):
            self.engine.verify_execution_and_settle(created["escrow_id"], trace, result)

    def test_agent_attribution_is_committed_into_the_leaf(self):
        attributed, plain = self.create(), self.create()
        settled = self.engine.verify_execution_and_settle(
            attributed["escrow_id"], "trace", "result", agent_id="planner-7",
        )["receipt"]
        self.assertEqual(settled["agent_id"], "planner-7")
        digest = hashlib.sha256(b'{"agent_id":"planner-7"}').digest()
        self.assertEqual(agent_attribution_digest("planner-7"), digest)
        data = (
            bytes.fromhex(self.task)
            + hashlib.sha256(b"trace").digest()
            + hashlib.sha256(b"result").digest()
            + digest
        )
        self.assertEqual(len(data), 128)
        self.assertEqual(
            hashlib.sha256(b"\x00" + data).hexdigest(), settled["execution_leaf_hash"],
        )
        self.assertTrue(verify_merkle_inclusion(
            data, settled["leaf_index"], settled["tree_size"],
            [bytes.fromhex(item) for item in settled["audit_path"]],
            bytes.fromhex(settled["merkle_root"]),
        ))
        with self.store.connection() as connection:
            stored = connection.execute(
                "SELECT leaf_preimage FROM escrow_execution_leaves WHERE escrow_id=?",
                (attributed["escrow_id"],),
            ).fetchone()[0]
        self.assertEqual(stored, data)
        # Unattributed settlements keep the original 96-byte leaf and no agent field.
        unattributed = self.engine.verify_execution_and_settle(
            plain["escrow_id"], "trace", "result",
        )["receipt"]
        self.assertNotIn("agent_id", unattributed)
        self.verify_receipt(unattributed)
        self.assertNotEqual(unattributed["execution_leaf_hash"], settled["execution_leaf_hash"])

    def test_nip98_authenticated_attribution_commits_the_mode(self):
        created = self.create()
        pubkey = "ab" * 32
        settled = self.engine.verify_execution_and_settle(
            created["escrow_id"], "trace", "result",
            agent_id=pubkey, agent_authentication="nip98",
        )["receipt"]
        self.assertEqual(settled["agent_id"], pubkey)
        self.assertEqual(settled["agent_authentication"], "nip98")
        canonical = ('{"agent_authentication":"nip98","agent_id":"%s"}' % pubkey).encode()
        digest = hashlib.sha256(canonical).digest()
        self.assertEqual(agent_attribution_digest(pubkey, "nip98"), digest)
        # The same pubkey, self-declared, commits a different leaf segment.
        self.assertNotEqual(agent_attribution_digest(pubkey), digest)
        data = (
            bytes.fromhex(self.task)
            + hashlib.sha256(b"trace").digest()
            + hashlib.sha256(b"result").digest()
            + digest
        )
        self.assertEqual(len(data), 128)
        self.assertEqual(
            hashlib.sha256(b"\x00" + data).hexdigest(), settled["execution_leaf_hash"],
        )
        self.assertTrue(verify_merkle_inclusion(
            data, settled["leaf_index"], settled["tree_size"],
            [bytes.fromhex(item) for item in settled["audit_path"]],
            bytes.fromhex(settled["merkle_root"]),
        ))

    def test_invalid_agent_authentication_never_settles(self):
        created = self.create()
        pubkey = "ab" * 32
        for agent_id, authentication in (
            (None, "nip98"), ("planner-7", "nip98"), (pubkey.upper(), "nip98"),
            (pubkey, "NIP98"), (pubkey, "nip-98"), (pubkey, True), (pubkey, ""),
        ):
            with self.assertRaises(ValueError):
                self.engine.verify_execution_and_settle(
                    created["escrow_id"], "trace", "result",
                    agent_id=agent_id, agent_authentication=authentication,
                )
        self.assertEqual(self.store.get_contract(created["escrow_id"])["status"], "LOCKED")
        with self.store.connection() as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM escrow_execution_leaves").fetchone()[0], 0,
            )

    def test_invalid_agent_attribution_never_settles(self):
        created = self.create()
        for invalid in ("", " planner", "planner 7", "-lead", "a" * 129, 7, b"planner"):
            with self.assertRaises(ValueError):
                self.engine.verify_execution_and_settle(
                    created["escrow_id"], "trace", "result", agent_id=invalid,
                )
        self.assertEqual(self.store.get_contract(created["escrow_id"])["status"], "LOCKED")
        with self.store.connection() as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM escrow_execution_leaves").fetchone()[0], 0,
            )

    def test_restart_and_uneven_tree_paths(self):
        receipts = []
        for _ in range(7):
            engine = EscrowEngine(EscrowStore(self.path), strata_block_provider=lambda: 42)
            contract = self.create(engine)
            receipt = engine.verify_execution_and_settle(
                contract["escrow_id"], "trace", "result"
            )["receipt"]
            receipts.append(receipt)
        self.assertEqual([r["leaf_index"] for r in receipts], list(range(7)))
        for receipt in receipts:
            self.verify_receipt(receipt)

    def test_same_contract_concurrent_release_once(self):
        created = self.create()

        def attempt(_):
            try:
                self.engine.verify_execution_and_settle(created["escrow_id"], "trace", "result")
                return True
            except EscrowStateError:
                return False

        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(attempt, range(8))), 1)
        with self.store.connection() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM escrow_execution_leaves").fetchone()[0], 1
            )

    def test_cross_process_serialization(self):
        contracts = [self.create()["escrow_id"] for _ in range(6)]
        with multiprocessing.get_context("fork").Pool(3) as pool:
            indexes = pool.starmap(
                settle_in_process, [(str(self.path), item) for item in contracts]
            )
        self.assertEqual(sorted(indexes), list(range(6)))

    def test_database_failure_rolls_back_leaf_and_contract(self):
        created = self.create()
        with self.store.connection() as connection:
            connection.execute("""
                CREATE TRIGGER reject_settlement BEFORE UPDATE ON agent_escrow_contracts
                BEGIN SELECT RAISE(ABORT, 'injected failure'); END
            """)
        with self.assertRaisesRegex(Exception, "injected failure"):
            self.engine.verify_execution_and_settle(created["escrow_id"], "trace", "result")
        self.assertEqual(self.store.get_contract(created["escrow_id"])["status"], "LOCKED")
        with self.store.connection() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM escrow_execution_leaves").fetchone()[0], 0
            )
            connection.execute("DROP TRIGGER reject_settlement")
        receipt = self.engine.verify_execution_and_settle(
            created["escrow_id"], "trace", "result"
        )["receipt"]
        self.assertEqual(receipt["leaf_index"], 0)

    def test_missing_height_and_capacity_do_not_settle(self):
        created = self.create()
        with self.assertRaises(RuntimeError):
            EscrowEngine(self.store).verify_execution_and_settle(
                created["escrow_id"], "trace", "result"
            )
        self.assertEqual(self.store.get_contract(created["escrow_id"])["status"], "LOCKED")
        limited = EscrowEngine(self.store, strata_block_provider=lambda: 1, max_leaves=1)
        limited.verify_execution_and_settle(created["escrow_id"], "trace", "result")
        second = self.create()
        with self.assertRaises(ValueError):
            limited.verify_execution_and_settle(second["escrow_id"], "trace", "result")
        self.assertEqual(self.store.get_contract(second["escrow_id"])["status"], "LOCKED")

    def test_invalid_inputs_and_lifecycle(self):
        for amount in [True, 0, -1, 1.1, 2**63]:
            with self.assertRaises(ValueError):
                self.engine.create_l402_escrow("a" * 64, "b" * 64, self.task, amount)
        with self.assertRaises(ValueError):
            self.engine.create_l402_escrow("not-a-key", "b" * 64, self.task, 1)
        with self.assertRaises(EscrowStateError):
            self.engine.verify_execution_and_settle("unknown", "trace", "result")
        for status in ["PENDING", "EXPIRED", "DISPUTED"]:
            created = self.create()
            with self.store.transaction() as connection:
                connection.execute(
                    "UPDATE agent_escrow_contracts SET status=? WHERE escrow_id=?",
                    (status, created["escrow_id"]),
                )
            with self.assertRaises(EscrowStateError):
                self.engine.verify_execution_and_settle(created["escrow_id"], "trace", "result")

    def test_insecure_existing_file_rejected(self):
        os.chmod(self.path, 0o644)
        with self.assertRaises(PermissionError):
            EscrowStore(self.path)

    def test_corrupt_secret_and_hashing_failure_do_not_settle(self):
        created = self.create()
        with patch("services.escrow_engine.leaf_hash", side_effect=RuntimeError("hash failure")):
            with self.assertRaises(RuntimeError):
                self.engine.verify_execution_and_settle(created["escrow_id"], "trace", "result")
        with self.store.transaction() as connection:
            connection.execute(
                "UPDATE agent_escrow_contracts SET preimage=? WHERE escrow_id=?",
                ("0" * 64, created["escrow_id"]),
            )
        with self.assertRaises(EscrowStateError):
            self.engine.verify_execution_and_settle(created["escrow_id"], "trace", "result")
        self.assertEqual(self.store.get_contract(created["escrow_id"])["status"], "LOCKED")


if __name__ == "__main__":
    unittest.main()
