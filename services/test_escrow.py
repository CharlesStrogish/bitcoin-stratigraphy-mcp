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
from services.escrow_engine import EscrowEngine, EscrowStateError


def settle_in_process(path, escrow_id):
    return EscrowEngine(
        EscrowStore(path), strata_block_provider=lambda: 900000
    ).verify_execution_and_settle(escrow_id, "trace", "result")["receipt"]["leaf_index"]


class EscrowTests(unittest.TestCase):
    def setUp(self):
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
        self.assertEqual(set(created), {"escrow_id", "payment_hash"})
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
        self.assertNotIn("preimage", json.dumps(settled["receipt"]))
        self.assertEqual(self.store.get_contract(created["escrow_id"])["status"], "SETTLED")
        self.assertEqual(settled["receipt"]["settled_at_strata_block"], 900000)
        with self.assertRaises(EscrowStateError):
            self.engine.verify_execution_and_settle(created["escrow_id"], trace, result)

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
