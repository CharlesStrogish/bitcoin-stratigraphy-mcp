"""Pinned development receipts; mocked HTTP only, no data tools or payments."""

import base64
import copy
import hashlib
import json
import unittest

from cryptography.hazmat.primitives import serialization

import test_clearing as fixtures
from clearing import DEVELOPMENT_SCHEME, RECEIPT_DOMAIN, UNCONFIRMED


class ClearingReceiptTests(unittest.TestCase):
    def setUp(self):
        self.base = fixtures.ClearingTests()
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.tools = self.base.tools
        self.trace = {
            "scheme": DEVELOPMENT_SCHEME,
            # A synthetic verifier result for CLIENT attestation tests only.
            # Actual proof generation/verification is covered in the TS suite.
            "proof": {
                "pi_a": ["1", "2", "1"],
                "pi_b": [["1", "2"], ["3", "4"], ["1", "0"]],
                "pi_c": ["1", "2", "1"],
                "protocol": "groth16",
                "curve": "bn128",
            },
            "publicSignals": [
                "18",
                str(int(self.base.escrow_id.replace("-", ""), 16)),
            ],
        }
        self.claims = {
            "schema": DEVELOPMENT_SCHEME,
            "receipt_type": "ZK-Indemnity Receipt",
            "development_only": True,
            "guarantee": "knowledge-of-hash-preimage",
            "legal_indemnity_granted": False,
            "payout_executed": False,
            "funding_verified": True,
            "status": "settled",
            "escrow_id": self.base.escrow_id,
            "worker_pubkey": self.base.fixture.signer.public_key,
            "task_hash": f"{18:064x}",
            "proof_digest": hashlib.sha256(
                json.dumps(self.trace, separators=(",", ":")).encode()
            ).hexdigest(),
            "amount_sats": 100,
            "payment_hash": "ab" * 32,
            "verification_key_id": "cd" * 32,
        }
        self.tamper_receipt = False
        self.tamper_http = False
        self.wrong_rpc_id = False
        self.data_changes = {}
        self.base.client._http._transport = fixtures.httpx.MockTransport(self.respond)

    def respond(self, request):
        self.base.fixture.requests.append(request)
        payload = json.dumps(self.claims, separators=(",", ":"))
        key = self.base.fixture.key
        receipt = {
            "payload": payload + (" " if self.tamper_receipt else ""),
            "signature": base64.b64encode(
                key.sign(RECEIPT_DOMAIN + payload.encode())
            ).decode(),
            "key_id": hashlib.sha256(
                key.public_key().public_bytes(
                    serialization.Encoding.DER,
                    serialization.PublicFormat.SubjectPublicKeyInfo,
                )
            ).hexdigest(),
        }
        self.receipt = receipt
        return self.base.fixture.signed_response(
            request,
            {
                "structuredContent": {
                    "escrow_id": self.base.escrow_id,
                    "status": "settled",
                    "development_only": True,
                    "funding_verified": True,
                    "receipt": receipt,
                    **self.data_changes,
                }
            },
            tamper=self.tamper_http,
            wrong_id=self.wrong_rpc_id,
        )

    def settle(self, trace=None):
        return self.tools.settle_contract(
            self.base.escrow_id, json.dumps(trace or self.trace)
        )

    def test_signed_bound_development_receipt_is_returned_without_payment(self):
        self.base.client.circuit._limit = 0
        result = self.settle()
        self.assertEqual(json.loads(result), self.receipt)
        self.base.nwc.pay_invoice.assert_not_called()
        self.base.fixture.verify_nip98(self.base.fixture.requests[-1])

    def test_tampered_portable_signature_is_rejected_even_with_signed_http(self):
        self.tamper_receipt = True
        self.assertEqual(self.settle(), UNCONFIRMED)

    def test_tampered_http_and_wrong_rpc_id_are_rejected(self):
        self.tamper_http = True
        self.assertEqual(self.settle(), UNCONFIRMED)
        self.tamper_http = False
        self.wrong_rpc_id = True
        self.assertEqual(self.settle(), UNCONFIRMED)

    def test_signed_but_wrong_identity_task_escrow_or_proof_is_rejected(self):
        original = copy.deepcopy(self.claims)
        for field, value in (
            ("worker_pubkey", "ab" * 32),
            ("task_hash", "ab" * 32),
            ("escrow_id", "00000000-0000-4000-8000-000000000000"),
            ("proof_digest", "ab" * 32),
        ):
            with self.subTest(field=field):
                self.claims = {**original, field: value}
                self.assertEqual(self.settle(), UNCONFIRMED)

    def test_overstated_or_unfunded_receipts_are_rejected(self):
        original = copy.deepcopy(self.claims)
        for field, value in (
            ("guarantee", "arbitrary-task-execution"),
            ("development_only", False),
            ("payout_executed", True),
            ("legal_indemnity_granted", True),
            ("funding_verified", False),
            ("status", "pending"),
            ("amount_sats", True),
        ):
            with self.subTest(field=field):
                self.claims = {**original, field: value}
                self.assertEqual(self.settle(), UNCONFIRMED)

    def test_outer_success_flags_cannot_override_receipt_or_contract(self):
        for changed in (
            {"escrow_id": "00000000-0000-4000-8000-000000000000"},
            {"status": "pending"},
            {"development_only": False},
            {"funding_verified": False},
        ):
            self.data_changes = changed
            self.assertEqual(self.settle(), UNCONFIRMED)

    def test_public_signal_noncanonical_encoding_or_wrong_uuid_is_rejected(self):
        for signals in (
            ["018", self.trace["publicSignals"][1]],
            ["18", "1"],
            ["18", self.trace["publicSignals"][1], "0"],
        ):
            self.assertEqual(
                self.settle({**self.trace, "publicSignals": signals}), UNCONFIRMED
            )

    def test_proof_object_key_order_does_not_change_binding(self):
        reordered = {
            **self.trace,
            "proof": dict(reversed(list(self.trace["proof"].items()))),
        }
        self.assertEqual(json.loads(self.settle(reordered)), self.receipt)


if __name__ == "__main__":
    unittest.main()
