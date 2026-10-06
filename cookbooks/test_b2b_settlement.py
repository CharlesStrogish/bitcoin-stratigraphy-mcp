# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Real Ed25519/OTS serialization; synthetic notaries, no wallets or remote calls."""

import io
import json
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

from cookbooks.article_12_journal import canonical_json, sha256
from cookbooks.audit_verifier_ots import serialize
from cookbooks.b2b_contract import (
    ContractVerificationError,
    SigningAgent,
    snapshot,
    verify_signatures,
)
from cookbooks.b2b_settlement import (
    B2BSettlementProtocol,
    PrepaidMacroNotarizer,
    demo_contract,
    main,
)
from cookbooks.b2b_settlement_verifier import verify_contract_settlement

NOW = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)


class SyntheticNotary:
    def __init__(self, *, bitcoin=False, fail=False, wrong_hash=False):
        self.calls = []
        self.bitcoin, self.fail, self.wrong_hash = bitcoin, fail, wrong_hash

    def notarize(self, digest):
        self.calls.append(digest)
        if self.fail:
            raise RuntimeError(
                "simulated network ambiguity; private provider diagnostics"
            )
        stamp = Timestamp(bytes.fromhex(digest))
        stamp.attestations.add(
            PendingAttestation("https://alice.btc.calendar.opentimestamps.org")
        )
        if self.bitcoin:
            stamp.attestations.add(BitcoinBlockHeaderAttestation(999))
        proof = serialize(DetachedTimestampFile(OpSHA256(), stamp)).hex()
        return {
            "hash": "00" * 32 if self.wrong_hash else digest,
            "otsProofHex": proof,
            "otsStatus": "pending_calendar",
        }


class B2BSettlementTests(unittest.TestCase):
    def setUp(self):
        self.client = SigningAgent.generate("ClientSwarm", "client")
        self.vendor = SigningAgent.generate("VendorSwarm", "vendor")
        self.payload = demo_contract(self.client, self.vendor, NOW)

    def protocol(self, notary=None):
        return B2BSettlementProtocol(notary, now=lambda: NOW)

    def settle(self, notary=None):
        return self.protocol(notary).negotiate(self.payload, self.client, self.vendor)

    def test_two_real_keys_sign_exact_canonical_terms(self):
        agreement = self.protocol().agree(self.payload, self.client, self.vendor)
        verify_signatures(self.payload, agreement["signatures"])
        self.assertNotEqual(self.client.public_key, self.vendor.public_key)
        self.assertEqual(128, len(agreement["signatures"]["client"]))
        self.assertEqual(128, len(agreement["signatures"]["vendor"]))

    def test_dictionary_order_does_not_change_canonical_contract(self):
        reordered = dict(reversed(list(self.payload.items())))
        self.assertEqual(canonical_json(self.payload), canonical_json(reordered))
        self.assertEqual(
            self.client.sign_contract(self.payload),
            self.client.sign_contract(reordered),
        )

    def test_altering_one_character_of_terms_is_detected(self):
        receipt = self.settle()
        self.payload["terms"][0] += " "
        with self.assertRaises(ContractVerificationError):
            verify_contract_settlement(receipt, self.payload)

    def test_signature_tampering_is_rejected_before_any_paid_call(self):
        notary = SyntheticNotary()
        protocol = self.protocol(notary)
        agreement = protocol.agree(self.payload, self.client, self.vendor)
        agreement["signatures"]["vendor"] = "00" * 64
        with self.assertRaises(ContractVerificationError):
            protocol.settle(agreement, self.client, self.vendor)
        self.assertEqual([], notary.calls)

    def test_wrong_party_key_cannot_sign(self):
        impostor = SigningAgent.generate("VendorSwarm", "vendor")
        with self.assertRaises(ContractVerificationError):
            self.protocol().agree(self.payload, self.client, impostor)

    def test_single_key_cannot_represent_two_independent_parties(self):
        self.payload["parties"]["vendor"]["public_key"] = self.client.public_key
        with self.assertRaises(ContractVerificationError):
            self.client.sign_contract(self.payload)

    def test_sandbox_receipt_is_mutually_sealed_but_not_fabricated_anchoring(self):
        receipt = self.settle()
        report = verify_contract_settlement(receipt, self.payload)
        self.assertTrue(report["contract_signatures_valid"])
        self.assertTrue(report["receipt_signatures_valid"])
        self.assertEqual("deferred", report["status"])
        self.assertEqual("Deferred/Pending Credential", report["detail"])
        self.assertIsNone(receipt["body"]["anchoring"]["otsProofHex"])
        self.assertFalse(report["bitcoin_inclusion_verified"])
        self.assertIsNone(report["header_timestamp_before_expiration"])

    def test_paid_adapter_receipt_binds_hash_of_payload_and_both_signatures(self):
        notary = SyntheticNotary()
        protocol = self.protocol(notary)
        agreement = protocol.agree(self.payload, self.client, self.vendor)
        receipt = protocol.settle(agreement, self.client, self.vendor)
        self.assertEqual([sha256(agreement)], notary.calls)
        self.assertEqual(sha256(agreement), receipt["body"]["contract_hash"])
        report = verify_contract_settlement(receipt, self.payload)
        self.assertEqual("pending", report["status"])
        self.assertIsNone(report["header_timestamp_before_expiration"])

    def test_all_receipt_metadata_and_ots_bytes_are_covered_by_both_seals(self):
        receipt = self.settle(SyntheticNotary())
        for field, new_value in [
            ("nonce", "00" * 32),
            ("expiration_utc", "2030-01-01T00:00:00Z"),
            ("contract_hash", "00" * 32),
            ("generated_utc", "2026-10-06T12:00:01Z"),
        ]:
            changed = snapshot(receipt)
            changed["body"][field] = new_value
            with (
                self.subTest(field=field),
                self.assertRaises(ContractVerificationError),
            ):
                verify_contract_settlement(changed, self.payload)
        receipt["body"]["anchoring"]["otsProofHex"] += "00"
        with self.assertRaises(ContractVerificationError):
            verify_contract_settlement(receipt, self.payload)

    def test_receipt_seal_from_other_key_is_rejected(self):
        receipt = self.settle()
        receipt["receipt_signatures"]["client"] = self.vendor.private_key.sign(
            canonical_json(receipt["body"])
        ).hex()
        with self.assertRaises(ContractVerificationError):
            verify_contract_settlement(receipt, self.payload)

    def test_expired_contract_never_initiates_notarization(self):
        self.payload["issued_utc"] = "2026-10-04T00:00:00Z"
        self.payload["expiration_utc"] = "2026-10-05T00:00:00Z"
        notary = SyntheticNotary()
        with self.assertRaises(ContractVerificationError):
            self.protocol(notary).negotiate(self.payload, self.client, self.vendor)
        self.assertEqual([], notary.calls)

    def test_rejection_of_negotiated_terms_prevents_notarization(self):
        vendor = SigningAgent(
            "VendorSwarm", "vendor", self.vendor.private_key, approve=lambda _: False
        )
        notary = SyntheticNotary()
        with self.assertRaises(ContractVerificationError):
            self.protocol(notary).negotiate(self.payload, self.client, vendor)
        self.assertEqual([], notary.calls)

    def test_receipt_and_agreement_are_detached_from_caller_mutations(self):
        protocol = self.protocol()
        agreement = protocol.agree(self.payload, self.client, self.vendor)
        receipt = protocol.settle(agreement, self.client, self.vendor)
        original_payload = snapshot(self.payload)
        self.payload["terms"][0] = "Caller changed the terms"
        agreement["signatures"]["client"] = "00" * 64
        self.assertTrue(
            verify_contract_settlement(receipt, original_payload)[
                "contract_signatures_valid"
            ]
        )

    def test_same_contract_replay_does_not_consume_another_batch_call(self):
        notary = SyntheticNotary()
        protocol = self.protocol(notary)
        agreement = protocol.agree(self.payload, self.client, self.vendor)
        first = protocol.settle(agreement, self.client, self.vendor)
        first["body"]["contract_hash"] = "00" * 32
        second = protocol.settle(agreement, self.client, self.vendor)
        self.assertEqual(1, len(notary.calls))
        self.assertEqual(sha256(agreement), second["body"]["contract_hash"])

    def test_contract_id_cannot_be_reused_with_new_terms(self):
        notary = SyntheticNotary()
        protocol = self.protocol(notary)
        protocol.negotiate(self.payload, self.client, self.vendor)
        self.payload["pricing"]["amount_minor"] += 1
        with self.assertRaises(ContractVerificationError):
            protocol.negotiate(self.payload, self.client, self.vendor)
        self.assertEqual(1, len(notary.calls))

    def test_nonce_cannot_be_reused_for_another_contract(self):
        protocol = self.protocol()
        protocol.negotiate(self.payload, self.client, self.vendor)
        self.payload["contract_id"] += "-other"
        with self.assertRaises(ContractVerificationError):
            protocol.negotiate(self.payload, self.client, self.vendor)

    def test_unknown_provider_outcome_is_sealed_and_never_auto_retried(self):
        notary = SyntheticNotary(fail=True)
        protocol = self.protocol(notary)
        first = protocol.negotiate(self.payload, self.client, self.vendor)
        second = protocol.negotiate(self.payload, self.client, self.vendor)
        self.assertEqual(first, second)
        self.assertEqual(1, len(notary.calls))
        self.assertEqual(
            "unavailable", verify_contract_settlement(first, self.payload)["status"]
        )
        self.assertIsNone(first["body"]["anchoring"]["otsProofHex"])
        self.assertTrue(first["body"]["anchoring"]["settlement_unknown"])
        self.assertNotIn("private provider", json.dumps(first))

    def test_wrong_notary_digest_is_never_presented_as_an_anchor(self):
        receipt = self.settle(SyntheticNotary(wrong_hash=True))
        self.assertEqual("unavailable", receipt["body"]["anchoring"]["status"])
        self.assertIsNone(receipt["body"]["anchoring"]["otsProofHex"])

    def test_macro_adapter_sends_tool_and_100_call_header_without_wallet(self):
        with patch("cookbooks.b2b_settlement.BitcoinStratigraphyClient") as sdk:
            sdk.return_value.call_tool.return_value = {"synthetic": True}
            token = "L402 synthetic-macaroon:" + "01" * 32
            adapter = PrepaidMacroNotarizer(token, "https://example.test/mcp")
            self.assertEqual({"synthetic": True}, adapter.notarize("ab" * 32))
            self.assertEqual(
                {"Authorization": token, "X-L402-Batch-Size": "100"},
                sdk.call_args.kwargs["headers"],
            )
            self.assertNotIn("wallet_handler", sdk.call_args.kwargs)
            sdk.return_value.call_tool.assert_called_once_with(
                "proof.notarize", {"hash": "ab" * 32}
            )

    def test_real_sdk_transport_sends_only_digest_and_prepaid_batch_headers(self):
        captured = []
        notary = SyntheticNotary()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(
                    self.rfile.read(int(self.headers["Content-Length"]))
                )
                captured.append((dict(self.headers), request))
                result = notary.notarize(request["params"]["arguments"]["hash"])
                data = json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {
                            "structuredContent": result,
                            "content": [{"type": "text", "text": json.dumps(result)}],
                        },
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            token = "L402 synthetic-macaroon:" + "01" * 32
            adapter = PrepaidMacroNotarizer(
                token, f"http://127.0.0.1:{server.server_port}/mcp"
            )
            receipt = self.settle(adapter)
            self.assertEqual(
                "pending", verify_contract_settlement(receipt, self.payload)["status"]
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(1, len(captured))
        headers, rpc = captured[0]
        self.assertEqual("100", headers["X-L402-Batch-Size"])
        self.assertEqual(token, headers["Authorization"])
        self.assertEqual("proof.notarize", rpc["params"]["name"])
        self.assertEqual(
            {"hash": receipt["body"]["contract_hash"]}, rpc["params"]["arguments"]
        )
        self.assertNotIn(self.payload["scope"]["description"], json.dumps(rpc))

    def test_failed_receipt_seal_cannot_trigger_second_call_with_a_new_nonce(self):
        notary = SyntheticNotary()
        protocol = self.protocol(notary)

        def unavailable_custodian(*_):
            raise RuntimeError("Simulated separate enterprise key-custodian outage")

        vendor = SimpleNamespace(
            role="vendor",
            agent_id=self.vendor.agent_id,
            public_key=self.vendor.public_key,
            sign_contract=self.vendor.sign_contract,
            sign_receipt=unavailable_custodian,
        )
        with self.assertRaises(RuntimeError):
            protocol.negotiate(self.payload, self.client, vendor)
        self.payload["nonce"] = "ab" * 32
        with self.assertRaises(ContractVerificationError):
            protocol.negotiate(self.payload, self.client, self.vendor)
        self.assertEqual(1, len(notary.calls))

    def test_production_adapter_rejects_insecure_urls_and_invalid_credentials(self):
        token = "L402 synthetic-macaroon:" + "01" * 32
        for url in [
            "http://example.test/mcp",
            "https://user:pass@example.test/mcp",
            "https://example.test/mcp?token=x",
        ]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                PrepaidMacroNotarizer(token, url)
        with self.assertRaises(ValueError):
            PrepaidMacroNotarizer("invalid")

    def test_bitcoin_attestation_without_trusted_headers_is_not_confirmed(self):
        receipt = self.settle(SyntheticNotary(bitcoin=True))
        report = verify_contract_settlement(receipt, self.payload)
        self.assertEqual("unavailable", report["status"])
        self.assertFalse(report["bitcoin_inclusion_verified"])

    def test_independently_pinned_enterprise_keys_prevent_key_substitution(self):
        receipt = self.settle()
        keys = {"client": self.client.public_key, "vendor": self.vendor.public_key}
        self.assertTrue(
            verify_contract_settlement(receipt, self.payload, expected_party_keys=keys)[
                "party_keys_pinned"
            ]
        )
        keys["vendor"] = SigningAgent.generate("OtherVendor", "vendor").public_key
        with self.assertRaises(ContractVerificationError):
            verify_contract_settlement(receipt, self.payload, expected_party_keys=keys)

    def test_separately_trusted_header_time_before_and_after_expiration(self):
        # Synthetic trust fixture ONLY: real verifier uses checked_header's
        # mainnet header hash and PoW checks. No test calls this a real anchor.
        receipt = self.settle(SyntheticNotary(bitcoin=True))
        digest = receipt["body"]["contract_hash"]
        trust = {999: {"block_hash": "00" * 32, "header_hex": "00" * 80}}
        expires = NOW + timedelta(days=1)
        for timestamp, expected in [
            (NOW.timestamp(), "verified_header_time"),
            (expires.timestamp(), "after_expiration"),
        ]:
            header = SimpleNamespace(
                hashMerkleRoot=bytes.fromhex(digest), nTime=timestamp
            )
            with (
                self.subTest(expected=expected),
                patch(
                    "cookbooks.b2b_settlement_verifier.checked_header",
                    return_value=header,
                ),
            ):
                report = verify_contract_settlement(
                    receipt, self.payload, trusted_headers=trust
                )
            self.assertEqual(expected, report["status"])
            self.assertTrue(report["bitcoin_inclusion_verified"])
            self.assertEqual(
                expected == "verified_header_time",
                report["header_timestamp_before_expiration"],
            )

    def test_invalid_pow_header_is_not_accepted_as_offline_confirmation(self):
        receipt = self.settle(SyntheticNotary(bitcoin=True))
        trust = {999: {"block_hash": "00" * 32, "header_hex": "00" * 80}}
        with self.assertRaises(ContractVerificationError):
            verify_contract_settlement(receipt, self.payload, trusted_headers=trust)

    def test_schema_rejects_floats_bool_amount_unknown_fields_and_nonutc_expiry(self):
        for mutation in [
            lambda p: p["pricing"].update(amount_minor=1.5),
            lambda p: p["pricing"].update(amount_minor=True),
            lambda p: p.update(unknown_field="ignored by loose parsers"),
            lambda p: p.update(expiration_utc="2026-10-07T12:00:00"),
        ]:
            payload = snapshot(self.payload)
            mutation(payload)
            with self.assertRaises(ContractVerificationError):
                self.client.sign_contract(payload)

    def test_default_demo_never_uses_available_credentials_or_calls_notary(self):
        with (
            patch.dict("os.environ", {"L402_AUTHORIZATION": "fake-sensitive-token"}),
            patch("cookbooks.b2b_settlement.PrepaidMacroNotarizer") as notary,
            patch("sys.stdout", new_callable=io.StringIO) as output,
        ):
            self.assertEqual(0, main([]))
        notary.assert_not_called()
        self.assertIn("Both contract signatures:", output.getvalue())
        self.assertIn("Deferred/Pending Credential", output.getvalue())
        self.assertNotIn("fake-sensitive-token", output.getvalue())

    def test_explicit_production_without_credential_honestly_defers(self):
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("cookbooks.b2b_settlement.PrepaidMacroNotarizer") as notary,
            patch("sys.stdout", new_callable=io.StringIO) as output,
        ):
            self.assertEqual(0, main(["--production"]))
        notary.assert_not_called()
        self.assertIn("Deferred/Pending Credential", output.getvalue())


if __name__ == "__main__":
    unittest.main()
