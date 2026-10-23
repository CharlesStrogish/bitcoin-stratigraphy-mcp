# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from routers.escrow_api import EscrowApi
from services.escrow_db import EscrowStore
from services.escrow_engine import EscrowEngine, agent_attribution_digest


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
        leaf = bytes.fromhex(settlement["article_12_receipt"]["leaf_preimage"])
        self.assertEqual(len(leaf), 96)
        self.assertEqual(leaf[:32].hex(), self.input["task_hash"])
        self.assertEqual(leaf[32:64], hashlib.sha256(b"trace").digest())
        self.assertEqual(leaf[64:], hashlib.sha256(b"result").digest())
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
        self.assertNotIn('"preimage":', json.dumps(document))
        self.assertNotIn(settlement["preimage"], json.dumps(document))

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
        self.assertNotIn('"preimage":', json.dumps(document))
        self.assertNotIn(settled["preimage"], json.dumps(document))

    def test_agent_attribution_receipt_verifies_and_rejects_forgery(self):
        contract = self.create()
        lookup = {"escrow_id": contract["escrow_id"]}
        execution = {**lookup, "execution_trace": "trace", "result_payload": "result"}
        # Attribution is accepted only on settlement, never smuggled via the body.
        self.assertEqual(self.api.dispatch("lookup", lookup, None, "planner-7")[0], 400)
        self.assertEqual(self.api.dispatch("create", self.input, None, "planner-7")[0], 400)
        self.assertEqual(self.api.dispatch("settle", {**execution, "agent_id": "planner-7"})[0], 400)
        self.assertEqual(self.api.dispatch("settle", execution, None, "planner 7")[0], 422)
        self.assertEqual(self.store.get_contract(contract["escrow_id"])["status"], "LOCKED")
        status, settled = self.api.dispatch("settle", execution, None, "planner-7")
        self.assertEqual(status, 200)
        self.assertEqual(settled["article_12_receipt"]["agent_id"], "planner-7")
        status, document = self.api.dispatch("receipt", lookup)
        self.assertEqual(status, 200)
        self.assertEqual(document["proof"]["agent_id"], "planner-7")
        self.assertTrue(document["verification"]["merkle_inclusion"])
        self.assertEqual(
            document["verification"]["agent_attribution_hash"],
            agent_attribution_digest("planner-7").hex(),
        )
        self.assertEqual(
            document["verification"]["result_hash"], hashlib.sha256(b"result").hexdigest(),
        )
        for forged in ("planner-8", None):
            with self.store.transaction() as connection:
                row = connection.execute("SELECT receipt_json FROM escrow_execution_leaves").fetchone()
                receipt = json.loads(row[0])
                if forged is None:
                    receipt.pop("agent_id")
                else:
                    receipt["agent_id"] = forged
                connection.execute(
                    "UPDATE escrow_execution_leaves SET receipt_json=?", (json.dumps(receipt),)
                )
            self.assertEqual(self.api.dispatch("receipt", lookup)[0], 422, forged)

    def test_nip98_attribution_receipt_verifies_and_rejects_downgrade(self):
        contract = self.create()
        pubkey = "cd" * 32
        lookup = {"escrow_id": contract["escrow_id"]}
        execution = {**lookup, "execution_trace": "trace", "result_payload": "result"}
        self.assertEqual(self.api.dispatch("lookup", lookup, None, None, "nip98")[0], 400)
        for agent_id in (None, "planner-7"):
            self.assertEqual(
                self.api.dispatch("settle", execution, None, agent_id, "nip98")[0], 422,
            )
        self.assertEqual(self.store.get_contract(contract["escrow_id"])["status"], "LOCKED")
        status, settled = self.api.dispatch("settle", execution, None, pubkey, "nip98")
        self.assertEqual(status, 200)
        self.assertEqual(settled["article_12_receipt"]["agent_id"], pubkey)
        self.assertEqual(settled["article_12_receipt"]["agent_authentication"], "nip98")
        status, document = self.api.dispatch("receipt", lookup)
        self.assertEqual(status, 200)
        self.assertEqual(document["proof"]["agent_authentication"], "nip98")
        self.assertEqual(
            document["verification"]["agent_attribution_hash"],
            agent_attribution_digest(pubkey, "nip98").hex(),
        )
        for forged in (None, "nip99"):
            with self.store.transaction() as connection:
                row = connection.execute("SELECT receipt_json FROM escrow_execution_leaves").fetchone()
                receipt = json.loads(row[0])
                if forged is None:
                    receipt.pop("agent_authentication", None)
                else:
                    receipt["agent_authentication"] = forged
                connection.execute(
                    "UPDATE escrow_execution_leaves SET receipt_json=?", (json.dumps(receipt),)
                )
            self.assertEqual(self.api.dispatch("receipt", lookup)[0], 422, forged)

    def test_unattributed_leaf_cannot_claim_an_agent(self):
        contract = self.create()
        lookup = {"escrow_id": contract["escrow_id"]}
        status, settled = self.api.dispatch(
            "settle", {**lookup, "execution_trace": "trace", "result_payload": "result"},
        )
        self.assertEqual(status, 200)
        self.assertNotIn("agent_id", settled["article_12_receipt"])
        status, document = self.api.dispatch("receipt", lookup)
        self.assertEqual(status, 200)
        self.assertNotIn("agent_attribution_hash", document["verification"])
        with self.store.connection() as connection:
            original = connection.execute(
                "SELECT receipt_json FROM escrow_execution_leaves",
            ).fetchone()[0]
        for claim in ({"agent_id": "planner-7"}, {"agent_authentication": "nip98"}):
            with self.store.transaction() as connection:
                receipt = {**json.loads(original), **claim}
                connection.execute(
                    "UPDATE escrow_execution_leaves SET receipt_json=?", (json.dumps(receipt),)
                )
            self.assertEqual(self.api.dispatch("receipt", lookup)[0], 422, claim)


if __name__ == "__main__":
    unittest.main()
