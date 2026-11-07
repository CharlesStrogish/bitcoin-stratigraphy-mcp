"""Offline request-binding and legacy payment regressions; never spends sats."""

import base64
import hashlib
import json
import os
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import httpx
from bitcoinstratigraphy_agent_yield import FiduciaryError, FiduciaryTamperingError
from bitcoinstratigraphy_agent_yield.invoices import Invoice
from coincurve import PublicKeyXOnly
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from staking import ESCROW_TOOL, Nip98Signer, YieldSettings, YieldStakingClient


class StakingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.key = Ed25519PrivateKey.generate()
        self.pin = self.key.public_key().public_bytes(
            Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
        )
        self.signer = Nip98Signer("11" * 32)
        self.wallet = Mock()
        self.requests = []
        self.data = {
            "pubkey": self.signer.public_key,
            "staked_sats": 10001,
            "vip_status": True,
            "unlocked_features": ["zero_latency_routing"],
        }

    def signed_response(self, request, result, *, tamper=False, wrong_id=False):
        envelope = json.loads(request.content)
        content = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "wrong" if wrong_id else envelope["id"],
                "result": result,
            }
        ).encode()
        prefix = (
            "bitcoinstratigraphy/payload/v1\n"
            + hashlib.sha256(request.content).hexdigest()
            + "\n"
        ).encode()
        signature = base64.b64encode(self.key.sign(prefix + content)).decode()
        return httpx.Response(
            200,
            content=content + (b" " if tamper else b""),
            headers={"X-Stratigraphy-Signature": f"v1,{signature}"},
        )

    def client(self, handler=None, **options):
        def transport(request):
            self.requests.append(request)
            if handler:
                return handler(request)
            return self.signed_response(request, {"structuredContent": self.data})

        http = httpx.Client(transport=httpx.MockTransport(transport))
        self.addCleanup(http.close)
        return YieldStakingClient(
            wallet=self.wallet,
            server_public_key=self.pin,
            http_client=http,
            state_directory=options.pop("state_directory", self.directory.name),
            **options,
        )

    def verify_nip98(self, request):
        event = json.loads(
            base64.b64decode(
                request.headers["X-Nostr-Authorization"].removeprefix("Nostr "),
                validate=True,
            )
        )
        unsigned = [
            0,
            event["pubkey"],
            event["created_at"],
            event["kind"],
            event["tags"],
            event["content"],
        ]
        digest = hashlib.sha256(
            json.dumps(unsigned, separators=(",", ":"), ensure_ascii=False).encode()
        ).digest()
        self.assertEqual(event["id"], digest.hex())
        self.assertTrue(
            PublicKeyXOnly(bytes.fromhex(event["pubkey"])).verify(
                bytes.fromhex(event["sig"]), digest
            )
        )
        tags = dict(event["tags"])
        self.assertEqual(tags["u"], str(request.url))
        self.assertEqual(tags["method"], request.method)
        self.assertEqual(tags["payload"], hashlib.sha256(request.content).hexdigest())
        self.assertLess(abs(event["created_at"] - time.time()), 60)
        self.assertEqual(event["kind"], 27235)
        self.assertEqual(event["pubkey"], self.signer.public_key)
        self.assertEqual(event["content"], "")
        return event

    def test_default_and_invalid_environment_fail_before_network(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(YieldSettings.from_env().mode, "withdraw")
            self.assertIsNone(YieldSettings.from_env().signer)
        for value in ("", "auto", "STAKE", "withdraw\r\nInjected: true"):
            with (
                self.subTest(value=value),
                patch.dict(os.environ, {"STRATIGRAPHY_YIELD_MODE": value}, clear=True),
                self.assertRaises(ValueError),
            ):
                YieldSettings.from_env()
        with patch.dict(os.environ, {"STRATIGRAPHY_YIELD_MODE": "stake"}, clear=True):
            with self.assertRaisesRegex(ValueError, "STRATIGRAPHY_NOSTR_PRIVATE_KEY"):
                YieldSettings.from_env()
        for value in ("not-a-key", "00" * 32, "ff" * 32):
            with self.subTest(key=value), self.assertRaises(ValueError):
                Nip98Signer(value)
        self.wallet.pay_invoice.assert_not_called()

    def test_signed_escrow_post_and_generic_tool_return_exact_four_fields(self):
        client = self.client(yield_settings=YieldSettings("stake", self.signer))
        self.assertEqual(client.get_escrow(), self.data)
        self.assertEqual(client.call_tool(ESCROW_TOOL, {}).payload, self.data)
        for request in self.requests:
            self.verify_nip98(request)
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.headers["X-Yield-Mode"], "stake")
            self.assertEqual(request.headers["Mcp-Name"], ESCROW_TOOL)
            params = json.loads(request.content)["params"]
            self.assertEqual(params["name"], ESCROW_TOOL)
            self.assertEqual(params["arguments"], {})
            self.assertEqual(
                params["_meta"]["io.modelcontextprotocol/protocolVersion"], "2026-07-28"
            )
        self.wallet.pay_invoice.assert_not_called()
        self.wallet.make_invoice.assert_not_called()

    def test_free_lookup_survives_exhausted_budget_and_never_pays_a_402(self):
        client = self.client(
            yield_settings=YieldSettings("stake", self.signer), max_spend_sats=0
        )
        self.assertEqual(client.get_escrow(), self.data)
        challenged = self.client(
            lambda request: httpx.Response(
                402,
                headers={
                    "WWW-Authenticate": 'L402 macaroon="m", invoice="invoice"',
                },
            ),
            yield_settings=YieldSettings("withdraw", self.signer),
        )
        with self.assertRaisesRegex(FiduciaryError, "MUST_NOT_REQUIRE_PAYMENT"):
            challenged.get_escrow()
        self.wallet.pay_invoice.assert_not_called()
        self.wallet.make_invoice.assert_not_called()

    def test_lookup_needs_identity_and_forbids_owner_arguments(self):
        client = self.client(yield_settings=YieldSettings())
        with self.assertRaises(ValueError):
            client.get_escrow()
        for args in ({"pubkey": "ab" * 32}, [], False, "owner"):
            with self.subTest(args=args), self.assertRaises(FiduciaryError):
                client.call_tool(ESCROW_TOOL, args)
        self.assertEqual(self.requests, [])

    def test_stake_fails_before_payment_against_legacy_catalog(self):
        client = self.client(
            lambda r: self.signed_response(
                r,
                {
                    "tools": [
                        {
                            "name": "stratigraphy.get_digest",
                            "description": "Legacy digest",
                            "inputSchema": {"type": "object", "properties": {}},
                        }
                    ]
                },
            ),
            yield_settings=YieldSettings("stake", self.signer),
        )
        with self.assertRaisesRegex(FiduciaryError, "DOES_NOT_SUPPORT_YIELD_STAKING"):
            client.call_tool("stratigraphy.get_digest", {})
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(json.loads(self.requests[0].content)["method"], "tools/list")
        self.wallet.pay_invoice.assert_not_called()
        self.wallet.make_invoice.assert_not_called()

    def test_tampered_or_unsigned_receipts_are_never_accepted(self):
        for tamper in (True, False):
            handler = (
                (
                    lambda r: self.signed_response(
                        r, {"structuredContent": self.data}, tamper=True
                    )
                )
                if tamper
                else lambda r: httpx.Response(
                    200, json={"result": {"structuredContent": self.data}}
                )
            )
            client = self.client(
                handler, yield_settings=YieldSettings("stake", self.signer)
            )
            with (
                self.subTest(tamper=tamper),
                self.assertRaises(FiduciaryTamperingError),
            ):
                client.get_escrow()

    def test_bad_schema_identity_vip_and_rpc_errors_fail_closed(self):
        bad = [
            {**self.data, "extra": True},
            {k: v for k, v in self.data.items() if k != "pubkey"},
            {**self.data, "pubkey": "ab" * 32},
            {**self.data, "staked_sats": 1.5},
            {**self.data, "staked_sats": True},
            {**self.data, "staked_sats": -1},
            {**self.data, "staked_sats": 2**53},
            {**self.data, "vip_status": False},
            {**self.data, "vip_status": 1},
            {**self.data, "unlocked_features": []},
        ]
        for value in bad:
            client = self.client(
                lambda r: self.signed_response(r, {"structuredContent": value}),
                yield_settings=YieldSettings("stake", self.signer),
            )
            with self.subTest(value=value), self.assertRaises(FiduciaryError):
                client.get_escrow()
        for result, wrong_id in (
            ({"isError": True}, False),
            ({"structuredContent": self.data}, True),
        ):
            client = self.client(
                lambda r: self.signed_response(r, result, wrong_id=wrong_id),
                yield_settings=YieldSettings("stake", self.signer),
            )
            with self.assertRaises(FiduciaryError):
                client.get_escrow()
        self.data.update(staked_sats=10000, vip_status=False)
        self.assertEqual(
            self.client(
                yield_settings=YieldSettings("withdraw", self.signer)
            ).get_escrow(),
            self.data,
        )

    def test_headers_and_legacy_withdrawal_through_real_sdk_payment_retries(self):
        preimage = "01" * 32
        payment_hash = hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
        self.wallet.pay_invoice.return_value = {"preimage": preimage, "fees_paid": 0}
        self.wallet.make_invoice.return_value = {"invoice": "receiving"}

        def decode(text):
            return Invoice(
                21000 if text == "receiving" else 100000,
                payment_hash,
                int(time.time()) + 3600,
            )

        for mode in (None, "withdraw", "stake"):
            self.requests.clear()
            self.wallet.reset_mock()
            calls = []
            claims = []

            def handler(request):
                body = json.loads(request.content)
                if request.url.path == "/api/claim-yield":
                    claims.append(body)
                    return httpx.Response(
                        200, json={"status": "SETTLED", "payment_sent": True}
                    )
                if body["method"] == "tools/list":
                    catalog = [
                        {
                            "name": "stratigraphy.get_digest",
                            "description": "Digest",
                            "inputSchema": {"type": "object", "properties": {}},
                        }
                    ]
                    if mode == "stake":
                        catalog.append(
                            {
                                "name": ESCROW_TOOL,
                                "description": "Read-only escrow",
                                "inputSchema": {"type": "object", "properties": {}},
                            }
                        )
                    return self.signed_response(
                        request,
                        {"tools": catalog},
                    )
                calls.append(request)
                if not request.headers.get("Authorization", "").startswith("L402 "):
                    return httpx.Response(
                        402,
                        headers={
                            "WWW-Authenticate": 'L402 macaroon="m", invoice="payable"',
                        },
                        json={
                            "macaroon": "m",
                            "invoice": "payable",
                            "payment_hash": payment_hash,
                            "amount_sats": 100,
                        },
                    )
                return self.signed_response(
                    request, {"structuredContent": {"digest": "ok"}}
                )

            env = (
                {}
                if mode is None
                else {
                    "STRATIGRAPHY_YIELD_MODE": mode,
                    "STRATIGRAPHY_NOSTR_PRIVATE_KEY": "11" * 32,
                }
            )
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.dict(os.environ, env, clear=True),
                patch(
                    "bitcoinstratigraphy_agent_yield.client.decode_invoice",
                    side_effect=decode,
                ),
            ):
                # A separate private ledger per mode; repeated synthetic invoices
                # must never accidentally reuse a previous case's paid state.
                client = self.client(
                    handler,
                    state_directory=directory,
                    max_payment_sats=100,
                    max_total_sats=200,
                )
                self.assertEqual(
                    client.call_tool("stratigraphy.get_digest", {}).payload,
                    {"digest": "ok"},
                )
            self.wallet.pay_invoice.assert_called_once_with("payable")
            for request in self.requests:
                self.assertEqual(request.headers["X-Yield-Mode"], mode or "withdraw")
                if mode and request.url.path == "/mcp":
                    self.verify_nip98(request)
            self.assertEqual(calls[0].content, calls[1].content)
            self.assertTrue(calls[1].headers["Authorization"].startswith("L402 "))
            if mode == "stake":
                self.assertEqual(claims, [])
                self.wallet.make_invoice.assert_not_called()
                self.assertNotEqual(
                    self.verify_nip98(calls[0])["id"], self.verify_nip98(calls[1])["id"]
                )
            else:
                self.assertEqual(len(claims), 1)
                self.wallet.make_invoice.assert_called_once_with(21000)

    def test_redirects_and_http_failures_never_retry_or_pay(self):
        for status in (302, 401, 403, 503):
            before = len(self.requests)
            client = self.client(
                lambda r: httpx.Response(
                    status, headers={"Location": "https://other.invalid"}
                ),
                yield_settings=YieldSettings("stake", self.signer),
            )
            with self.subTest(status=status), self.assertRaises(FiduciaryError):
                client.get_escrow()
            self.assertEqual(len(self.requests), before + 1)
        self.wallet.pay_invoice.assert_not_called()


if __name__ == "__main__":
    unittest.main()
