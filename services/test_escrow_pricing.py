"""Pricing and lossless legacy-constraint migration regression checks."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from routers.escrow_api import EscrowApi
from services.escrow_db import EscrowStore, SCHEMA
from services.escrow_engine import EscrowEngine
from services.escrow_pricing import get_dynamic_escrow_toll


class DynamicTollTests(unittest.TestCase):
    def test_current_and_hyper_appreciated_prices(self):
        for price, expected in [
            (100_000, 20), (150_000, 13), (50_000, 40),
            (1_000_000, 2), (2_000_000, 1), (100_000_000, 1),
            (800_000, 2),  # 2.5 sats: Python's ties-to-even rule.
        ]:
            with self.subTest(price=price):
                self.assertEqual(get_dynamic_escrow_toll(lambda: price), expected)

    def test_offline_error_and_invalid_rates_select_exactly_21(self):
        with patch("services.escrow_pricing.read_bitcoin_usd_price", side_effect=TimeoutError):
            self.assertEqual(get_dynamic_escrow_toll(), 21)
        for value in [None, 0, -1, True, "100000", float("nan"), float("inf"), 1e-300]:
            with self.subTest(value=value):
                self.assertEqual(get_dynamic_escrow_toll(lambda: value), 21)
        self.assertEqual(get_dynamic_escrow_toll(lambda: 1e308), 1)

    def test_standalone_price_reader_and_bounded_payload(self):
        with patch("services.escrow_pricing.urlopen") as fetch:
            fetch.return_value.__enter__.return_value.read.return_value = b'{"USD":1000000}'
            self.assertEqual(get_dynamic_escrow_toll(), 2)
            self.assertEqual(fetch.call_args.kwargs["timeout"], 5)
            fetch.return_value.__enter__.return_value.read.return_value = b"x" * (64 * 1024 + 1)
            self.assertEqual(get_dynamic_escrow_toll(), 21)

    def test_create_response_and_storage_bind_the_issued_toll(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EscrowStore(Path(directory) / "private" / "escrow.sqlite3")
            prices = iter([1_000_000, 50_000, None])
            engine = EscrowEngine(
                store, bitcoin_price_provider=lambda: next(prices),
                strata_block_provider=lambda: 900001,
            )
            api = EscrowApi(engine)
            body = {
                "buyer_pubkey": "a" * 64, "worker_pubkey": "b" * 64,
                "task_hash": hashlib.sha256(b"task").hexdigest(), "amount_sats": 1000,
            }
            for fee in [2, 40, 21]:
                status, contract = api.dispatch("create", body)
                self.assertEqual(status, 201)
                self.assertEqual(contract["toll_fee_sats"], fee)
                self.assertEqual(store.get_contract(contract["escrow_id"])["toll_fee_sats"], fee)
                status, _ = api.dispatch("settle", {
                    "escrow_id": contract["escrow_id"],
                    "execution_trace": "trace", "result_payload": "result",
                })
                self.assertEqual(status, 200)
                self.assertEqual(store.get_contract(contract["escrow_id"])["toll_fee_sats"], fee)

    def test_amount_plus_dynamic_toll_must_fit_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = EscrowEngine(
                EscrowStore(Path(directory) / "private" / "escrow.sqlite3"),
                bitcoin_price_provider=lambda: 50_000,
            )
            with self.assertRaises(ValueError):
                engine.create_l402_escrow("a" * 64, "b" * 64, "c" * 64, 2**63 - 40)
            self.assertEqual(
                engine.create_l402_escrow(
                    "a" * 64, "b" * 64, "c" * 64, 2**63 - 41,
                )["toll_fee_sats"], 40,
            )


class TollConstraintMigrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "private" / "escrow.sqlite3"
        self.path.parent.mkdir(mode=0o700)
        legacy = SCHEMA.replace(
            "CHECK(typeof(toll_fee_sats) = 'integer' AND toll_fee_sats >= 1)",
            "CHECK(toll_fee_sats = 21)",
        )
        with sqlite3.connect(self.path) as connection:
            connection.executescript(legacy)
            for identifier, status in [("old-locked", "LOCKED"), ("old-settled", "SETTLED")]:
                connection.execute(
                    """INSERT INTO agent_escrow_contracts
                    (escrow_id, buyer_pubkey, worker_pubkey, task_hash, amount_sats,
                     toll_fee_sats, payment_hash, preimage, status)
                    VALUES (?, ?, ?, ?, 1000, 21, ?, ?, ?)""",
                    (identifier, "a" * 64, "b" * 64, "c" * 64, "d" * 64, "e" * 64, status),
                )
            connection.execute(
                "INSERT INTO escrow_execution_leaves VALUES (0, 'old-settled', ?, ?)",
                (bytes(96), json.dumps({"preserved": True})),
            )
            connection.execute("CREATE INDEX escrow_status_index ON agent_escrow_contracts(status)")
            connection.execute(
                """CREATE TRIGGER escrow_delete_guard BEFORE DELETE ON agent_escrow_contracts
                BEGIN SELECT RAISE(ABORT, 'retention guard'); END"""
            )
            self.before = connection.execute(
                "SELECT * FROM agent_escrow_contracts ORDER BY escrow_id"
            ).fetchall()
            self.leaves = connection.execute("SELECT * FROM escrow_execution_leaves").fetchall()
        os.chmod(self.path, 0o600)

    def test_migration_preserves_custody_receipts_indexes_triggers_and_wal(self):
        store = EscrowStore(self.path)
        with store.connection() as connection:
            self.assertEqual(
                [tuple(row) for row in connection.execute(
                    "SELECT * FROM agent_escrow_contracts ORDER BY escrow_id"
                )], self.before,
            )
            self.assertEqual(
                [tuple(row) for row in connection.execute("SELECT * FROM escrow_execution_leaves")],
                self.leaves,
            )
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(list(connection.execute("PRAGMA foreign_key_check")), [])
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM sqlite_master WHERE name='escrow_status_index'"
            ).fetchone()[0], 1)
            with self.assertRaisesRegex(sqlite3.IntegrityError, "retention guard"):
                connection.execute("DELETE FROM agent_escrow_contracts WHERE escrow_id='old-locked'")
            for invalid in [0, -1, 1.5, "bad"]:
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        "UPDATE agent_escrow_contracts SET toll_fee_sats=? WHERE escrow_id='old-locked'",
                        (invalid,),
                    )
            connection.execute(
                "UPDATE agent_escrow_contracts SET toll_fee_sats=2 WHERE escrow_id='old-locked'"
            )
        EscrowStore(self.path)  # Idempotent reopen.
        self.assertEqual(store.get_contract("old-locked")["toll_fee_sats"], 2)

    def test_concurrent_migration_keeps_all_records(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: EscrowStore(self.path), range(4)))
        with EscrowStore(self.path).connection() as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM agent_escrow_contracts"
            ).fetchone()[0], 2)
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM escrow_execution_leaves"
            ).fetchone()[0], 1)
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM sqlite_master WHERE name='agent_escrow_contracts_dynamic'"
            ).fetchone()[0], 0)

    def test_failed_integrity_check_rolls_back_original_schema_and_rows(self):
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "INSERT INTO escrow_execution_leaves VALUES (1, 'missing-contract', ?, '{}')",
                (bytes(96),),
            )
        with self.assertRaisesRegex(RuntimeError, "integrity check"):
            EscrowStore(self.path)
        with sqlite3.connect(self.path) as connection:
            self.assertIn("CHECK(toll_fee_sats = 21)", connection.execute(
                "SELECT sql FROM sqlite_master WHERE name='agent_escrow_contracts'"
            ).fetchone()[0])
            self.assertEqual(
                connection.execute(
                    "SELECT * FROM agent_escrow_contracts ORDER BY escrow_id"
                ).fetchall(), self.before,
            )


if __name__ == "__main__":
    unittest.main()
