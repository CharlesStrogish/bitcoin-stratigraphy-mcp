# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from routers.escrow_api import EscrowApi
from services.escrow_db import EscrowStore
from services.escrow_engine import EscrowEngine


class EscrowApiTests(unittest.TestCase):
    def setUp(self):
        price = patch("services.escrow_pricing.read_bitcoin_usd_price", return_value=None)
        price.start()
        self.addCleanup(price.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = EscrowStore(Path(directory.name) / "private" / "escrow.sqlite3")
        self.api = EscrowApi(EscrowEngine(self.store, strata_block_provider=lambda: 900001))
        self.input = {
            "buyer_pubkey": "a" * 64, "worker_pubkey": "b" * 64,
            "task_hash": hashlib.sha256(b"task").hexdigest(), "amount_sats": 100,
        }

    def create(self):
        status, body = self.api.dispatch("create", self.input)
        self.assertEqual(status, 201)
        self.assertEqual(body["status"], "LOCKED")
        self.assertEqual(body["toll_fee_sats"], 21)
        self.assertNotIn("preimage", body)
        return body

    def test_status_codes(self):
        self.assertEqual(self.api.dispatch("create", {})[0], 400)
        self.assertEqual(self.api.dispatch("settle", {})[0], 400)
        self.assertEqual(self.api.dispatch("receipt", {"escrow_id": "bad"})[0], 400)
        self.assertEqual(self.api.dispatch("settle", {
            "escrow_id": "11111111-1111-4111-8111-111111111111",
            "execution_trace": "trace", "result_payload": "result",
        })[0], 404)

    def test_full_lifecycle_and_standalone_receipt(self):
        contract = self.create()
        lookup = {"escrow_id": contract["escrow_id"]}
        self.assertEqual(self.api.dispatch("receipt", lookup)[0], 404)
        execution = {**lookup, "execution_trace": "trace", "result_payload": "result"}
        self.assertEqual(self.api.dispatch("settle", {**execution, "execution_trace": ""})[0], 422)
        status, settlement = self.api.dispatch("settle", execution)
        self.assertEqual(status, 200)
        self.assertEqual(settlement["status"], "SETTLED")
        self.assertEqual(
            hashlib.sha256(bytes.fromhex(settlement["preimage"])).hexdigest(),
            contract["payment_hash"],
        )
        self.assertEqual(self.api.dispatch("settle", execution)[0], 422)
        status, document = self.api.dispatch("receipt", lookup)
        self.assertEqual(status, 200)
        self.assertEqual(document["@type"], "DigitalDocument")
        self.assertEqual(document["proof"], settlement["article_12_receipt"])
        self.assertTrue(document["verification"]["merkle_inclusion"])
        self.assertFalse(document["verification"]["bitcoin_anchor_verified"])
        self.assertEqual(document["verification"]["strata_block_height"], 900001)
        self.assertNotIn("preimage", json.dumps(document))

    def test_corrupt_receipt_rejected(self):
        contract = self.create()
        self.api.dispatch("settle", {
            "escrow_id": contract["escrow_id"], "execution_trace": "trace", "result_payload": "result",
        })
        with self.store.transaction() as connection:
            row = connection.execute("SELECT receipt_json FROM escrow_execution_leaves").fetchone()
            receipt = json.loads(row[0])
            receipt["merkle_root"] = "0" * 64
            connection.execute(
                "UPDATE escrow_execution_leaves SET receipt_json=?", (json.dumps(receipt),)
            )
        self.assertEqual(self.api.dispatch("receipt", {"escrow_id": contract["escrow_id"]})[0], 422)

    def test_verified_toll_metadata_persists_without_payment_preimage(self):
        contract = self.create()
        lookup = {"escrow_id": contract["escrow_id"]}
        self.assertEqual(self.api.dispatch("lookup", lookup)[1]["toll_fee_sats"], 21)
        execution = {**lookup, "execution_trace": "trace", "result_payload": "result"}
        confirmation = {
            "payment_hash": "f" * 64, "amount_sats": 20,
            "provider": "coinos", "confirmed_at": "2026-10-12T12:00:00Z",
        }
        self.assertEqual(self.api.dispatch("settle", execution, confirmation)[0], 422)
        self.assertEqual(self.store.get_contract(contract["escrow_id"])["status"], "LOCKED")
        confirmation["amount_sats"] = 21
        status, settled = self.api.dispatch("settle", execution, confirmation)
        self.assertEqual(status, 200)
        self.assertEqual(settled["article_12_receipt"]["lightning_settlement"], confirmation)
        status, document = self.api.dispatch("receipt", lookup)
        self.assertEqual(status, 200)
        self.assertEqual(document["proof"]["lightning_settlement"], confirmation)
        self.assertNotIn("preimage", json.dumps(document))


if __name__ == "__main__":
    unittest.main()
