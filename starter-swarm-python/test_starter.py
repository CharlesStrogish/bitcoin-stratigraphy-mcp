"""Offline checks: real LangChain/SDK, synthetic signatures, no paid services.

Run: python -m unittest -v test_starter.py
"""

import base64
import hashlib
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

import httpx
from bitcoinstratigraphy_agent_yield import (
    CircuitBreakerError,
    FiduciaryTamperingError,
    TruthReceipt,
)
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

import main
from staking import YieldStakingClient
from wallet import LndWallet, WalletError


class OfflineModel(BaseChatModel):
    """Exercise the real agent graph with deterministic, unpaid tool selection."""

    @property
    def _llm_type(self):
        return "offline-starter-test"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        message = (
            AIMessage(content="The indexed digest is available.")
            if any(isinstance(item, ToolMessage) for item in messages)
            else AIMessage(
                content="",
                tool_calls=[
                    {"name": "latest_bitcoin_digest", "args": {}, "id": "offline-call"}
                ],
            )
        )
        return ChatResult(generations=[ChatGeneration(message=message)])


class StarterTests(unittest.TestCase):
    def run_agent(self, tamper=False, stake=False):
        signing_key = Ed25519PrivateKey.generate()
        pin = signing_key.public_key().public_bytes(
            Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
        )
        calls = []

        def respond(request):
            self.assertEqual(
                request.headers["X-Yield-Mode"], "stake" if stake else "withdraw"
            )
            if stake:
                self.assertTrue(
                    request.headers["X-Nostr-Authorization"].startswith("Nostr ")
                )
            body = json.loads(request.content)
            if body["method"] == "tools/list":
                result = {
                    "tools": [
                        {
                            "name": main.CANONICAL_TOOL,
                            "description": "Indexed digest",
                            "inputSchema": {"type": "object", "properties": {}},
                        }
                    ]
                }
            else:
                calls.append(body["params"])
                result = {"structuredContent": {"h": 900000, "ts": "2026-11-01"}}
            if stake and body["method"] == "tools/list":
                result["tools"].append(
                    {
                        "name": "payment.get_escrow",
                        "description": "Read-only escrow",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                )
            payload = json.dumps(
                {"jsonrpc": "2.0", "id": body["id"], "result": result}
            ).encode()
            prefix = (
                "bitcoinstratigraphy/payload/v1\n"
                f"{hashlib.sha256(request.content).hexdigest()}\n"
            ).encode()
            signature = base64.b64encode(signing_key.sign(prefix + payload)).decode()
            if tamper and body["method"] == "tools/call":
                payload += b" "
            return httpx.Response(
                200,
                content=payload,
                headers={"X-Stratigraphy-Signature": f"v1,{signature}"},
            )

        wallet = Mock()
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "server-public-key.pem").write_bytes(pin)
            env = {
                "OPENAI_API_KEY": "offline-placeholder",
                "LND_REST_URL": "https://wallet.invalid",
                "LND_MACAROON_HEX": "aa",
                "STRATIGRAPHY_SERVER_PUBLIC_KEY_PATH": "./server-public-key.pem",
            }
            if stake:
                env.update(
                    STRATIGRAPHY_YIELD_MODE="stake",
                    STRATIGRAPHY_NOSTR_PRIVATE_KEY="11" * 32,
                )
            with httpx.Client(transport=httpx.MockTransport(respond)) as http:
                from langchain.agents import create_agent

                def configure(**policy):
                    self.assertEqual(policy["max_spend_sats"], 1000)
                    self.assertEqual(policy["max_total_sats"], 1000)
                    policy["http_client"] = http
                    return YieldStakingClient(**policy)

                def build_agent(**options):
                    self.assertEqual(
                        {tool.name for tool in options["tools"]},
                        {
                            "latest_bitcoin_digest",
                            "get_escrow",
                            "clearing_create_contract",
                            "clearing_settle_contract",
                        }
                        if stake
                        else {"latest_bitcoin_digest"},
                    )
                    return create_agent(**options)

                with (
                    patch.dict(os.environ, env, clear=True),
                    patch.object(main, "ROOT", root),
                    patch.object(main, "LndWallet", return_value=wallet),
                    patch.object(main, "YieldStakingClient", side_effect=configure),
                    patch("langchain_openai.ChatOpenAI", return_value=OfflineModel()),
                    patch("langchain.agents.create_agent", side_effect=build_agent),
                    redirect_stdout(output),
                ):
                    if tamper:
                        with self.assertRaises(FiduciaryTamperingError):
                            main.main()
                    else:
                        main.main()
        wallet.pay_invoice.assert_not_called()
        wallet.close.assert_called_once()
        return output.getvalue(), calls

    def test_real_agent_and_sdk_signed_receipt(self):
        output, calls = self.run_agent()
        self.assertIn('"provenance_verified": true', output)
        self.assertIn("1000 / 1000 sats", output)
        self.assertIn("Agent summary:", output)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["name"], "stratigraphy.get_digest")
        self.assertEqual(calls[0]["arguments"], {"target": "latest", "format": "kv"})

    def test_one_byte_tamper_never_prints_verified_receipt(self):
        output, _ = self.run_agent(tamper=True)
        self.assertNotIn('"provenance_verified": true', output)

    def test_staking_exposes_read_only_escrow_without_breaking_digest_agent(self):
        output, calls = self.run_agent(stake=True)
        self.assertIn('"provenance_verified": true', output)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["name"], main.CANONICAL_TOOL)

    def test_receipt_output_redacts_payment_preimage(self):
        secret = "ab" * 32
        receipt = TruthReceipt({"digest": "example"}, provenance_verified=True)
        receipt["cryptographic_proof"] = secret
        output = io.StringIO()
        with redirect_stdout(output):
            main.display_receipt(receipt, 975125)
        self.assertNotIn(secret, output.getvalue())
        self.assertIn("975.125 / 1000 sats", output.getvalue())
        self.assertEqual(receipt["cryptographic_proof"], secret)

    def test_breaker_blocks_reservation_above_hardcoded_cap(self):
        from bitcoinstratigraphy_agent_yield.armor import SpendCircuit

        circuit = SpendCircuit(main.MAX_SPEND_SATS)
        with self.assertRaises(CircuitBreakerError):
            circuit.reserve("offline-invoice", 1000001)
        with self.assertRaises(CircuitBreakerError):
            circuit.assert_capacity()

    def test_missing_configuration_stops_before_wallet_access(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "OPENAI_API_KEY"):
                main.required("OPENAI_API_KEY")

    def wallet_with_transport(self, handler):
        wallet = LndWallet("https://wallet.invalid", "aa")
        wallet.http.close()
        wallet.http = httpx.Client(
            base_url="https://wallet.invalid",
            transport=httpx.MockTransport(handler),
        )
        self.addCleanup(wallet.close)
        return wallet

    def test_wallet_receives_exact_msats_and_enforces_route_fee_limit(self):
        requests = []

        def respond(request):
            body = json.loads(request.content)
            requests.append((request.url.path, body))
            if request.url.path == "/v2/router/send":
                return httpx.Response(
                    200,
                    json={
                        "result": {
                            "status": "SUCCEEDED",
                            "payment_preimage": "01" * 32,
                            "fee_msat": "125",
                        }
                    },
                )
            return httpx.Response(200, json={"payment_request": "offline-invoice"})

        wallet = self.wallet_with_transport(respond)
        self.assertEqual(wallet.pay_invoice("offline-invoice")["fees_paid"], 125)
        self.assertEqual(wallet.make_invoice(5040), {"invoice": "offline-invoice"})
        self.assertEqual(requests[0][1]["fee_limit_sat"], "10")
        self.assertTrue(requests[0][1]["no_inflight_updates"])
        self.assertEqual(requests[1][1]["value_msat"], "5040")

    def test_wallet_unknown_payment_fails_without_retry(self):
        count = 0

        def timeout(request):
            nonlocal count
            count += 1
            raise httpx.ReadTimeout("offline", request=request)

        wallet = self.wallet_with_transport(timeout)
        with self.assertRaises(WalletError):
            wallet.pay_invoice("offline-invoice")
        self.assertEqual(count, 1)

    def test_wallet_rejects_bad_proofs_failed_status_and_excess_fees(self):
        for result in (
            {"status": "FAILED"},
            {"status": "SUCCEEDED", "payment_preimage": "bad", "fee_msat": "0"},
            {"status": "SUCCEEDED", "payment_preimage": "01" * 32, "fee_msat": "10001"},
        ):
            with self.subTest(result=result):
                wallet = self.wallet_with_transport(
                    lambda request: httpx.Response(200, json={"result": result})
                )
                with self.assertRaises(WalletError):
                    wallet.pay_invoice("offline-invoice")

    def test_wallet_rejects_insecure_or_credential_bearing_origins(self):
        for url in (
            "http://wallet.invalid",
            "https://secret@wallet.invalid",
            "https://wallet.invalid?token=secret",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                LndWallet(url, "aa")


if __name__ == "__main__":
    unittest.main()
