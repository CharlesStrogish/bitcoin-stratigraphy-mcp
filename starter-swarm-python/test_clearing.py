"""Offline clearing tests: no real wallet, relay, or HTTP requests."""

import hashlib
import io
import inspect
import json
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from bech32 import bech32_encode, convertbits
from coincurve import PrivateKey

from clearing import CREATE, SETTLE, ClearingTools, SAFE_FAILURE, VERIFIER_PENDING
from nwc_wallet import NwcWallet
from staking import YieldSettings
import test_staking as fixtures

PREIMAGE = "01" * 32
PAYMENT_HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()


def invoice(amount=100000, payment_hash=PAYMENT_HASH):
    """Sign a synthetic mainnet-format BOLT11; there is no receiving node."""

    def tag(number, data):
        return [number, len(data) // 32, len(data) % 32, *data]

    now = int(time.time())
    hrp = f"lnbc{amount * 10}p"
    words = [(now >> (5 * i)) & 31 for i in range(6, -1, -1)]
    words += tag(1, convertbits(bytes.fromhex(payment_hash), 8, 5, True))
    words += tag(13, convertbits(b"offline clearing fixture", 8, 5, True))
    words += tag(6, [3, 16, 16])  # 3600 seconds.
    digest = hashlib.sha256(
        hrp.encode() + bytes(convertbits(words, 5, 8, True))
    ).digest()
    sig = PrivateKey(bytes.fromhex("22" * 32)).sign_recoverable(digest, hasher=None)
    return bech32_encode(hrp, words + convertbits(sig, 8, 5, True))


class ClearingTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.StakingTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.escrow_id = str(uuid.uuid4())
        self.calls = []
        self.quote = {
            "escrow_id": self.escrow_id,
            "status": "pending",
            "invoice": invoice(),
            "macaroon": "synthetic-clearing-capability",
            "payment_hash": PAYMENT_HASH,
            "amount_sats": 100,
            "settlement_available": False,
            "funding_verified": False,
            "warning": "Settlement is disabled. Do not fund this scaffold.",
        }
        self.nwc = Mock()
        self.nwc.pay_invoice.return_value = {"preimage": PREIMAGE, "fees_paid": 125}
        self.client = self.fixture.client(
            self.respond,
            yield_settings=YieldSettings("stake", self.fixture.signer),
            max_spend_sats=1000,
            max_payment_sats=990,
            max_total_sats=1000,
        )
        self.tools = ClearingTools(self.client, self.nwc)
        self.args = {
            "worker_pubkey": self.fixture.signer.public_key,
            "task_hash": "ab" * 32,
            "amount_sats": 100,
        }

    def respond(self, request):
        body = json.loads(request.content)
        self.calls.append(body)
        if body["params"]["name"] == SETTLE:
            return httpx.Response(
                503,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "error": {
                        "code": -32000,
                        "message": "CLEARING_EXECUTION_VERIFIER_UNAVAILABLE",
                        "data": {
                            "settlement_available": False,
                            "zk_receipt_issued": False,
                        },
                    },
                },
            )
        return self.fixture.signed_response(request, {"structuredContent": self.quote})

    def test_registry_contains_only_the_two_exact_clearing_names(self):
        self.assertEqual(list(self.tools.registry), [CREATE, SETTLE])
        self.assertEqual(
            {t.metadata["canonical_name"] for t in self.tools.langchain_tools()},
            {CREATE, SETTLE},
        )

    def test_create_formats_authenticated_posts_silently_pays_nwc_and_returns_id(self):
        original_wallet = self.client.wallet
        out = io.StringIO()
        with redirect_stdout(out):
            result = self.tools.registry[CREATE](**self.args)
        self.assertEqual(result, self.escrow_id)
        self.assertEqual(out.getvalue(), "")
        self.assertIs(self.client.wallet, original_wallet)
        self.nwc.pay_invoice.assert_called_once_with(self.quote["invoice"])
        original_wallet.pay_invoice.assert_not_called()
        original_wallet.make_invoice.assert_not_called()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0], self.calls[1])
        self.assertEqual(self.calls[0]["params"]["name"], CREATE)
        self.assertEqual(self.calls[0]["params"]["arguments"], self.args)
        self.assertNotIn("buyer_pubkey", self.calls[0]["params"]["arguments"])
        for request in self.fixture.requests:
            self.fixture.verify_nip98(request)
            self.assertEqual(request.headers["Mcp-Name"], CREATE)
        self.assertTrue(
            self.fixture.requests[-1].headers["Authorization"].startswith("L402 ")
        )
        self.assertEqual(self.client.circuit.remaining_msats, 899875)

    def test_repeated_calls_and_restart_never_repay_and_reuse_escrow_id(self):
        self.assertEqual(self.tools.create_contract(**self.args), self.escrow_id)
        calls = len(self.calls)
        restarted = ClearingTools(self.client, self.nwc)
        self.assertEqual(restarted.create_contract(**self.args), self.escrow_id)
        self.assertEqual(len(self.calls), calls)
        self.assertEqual(self.nwc.pay_invoice.call_count, 1)

    def test_settle_parses_fail_closed_without_throwing_or_paying_at_zero_budget(self):
        self.client.circuit._limit = 0
        args = {"escrow_id": self.escrow_id, "execution_trace": '{"proof":"pending"}'}
        self.assertEqual(self.tools.registry[SETTLE](**args), VERIFIER_PENDING)
        self.assertEqual(self.calls[0]["params"]["name"], SETTLE)
        self.assertEqual(self.calls[0]["params"]["arguments"], args)
        self.fixture.verify_nip98(self.fixture.requests[0])
        self.nwc.pay_invoice.assert_not_called()

    def test_pending_error_requires_matching_rpc_id_and_exact_error_message(self):
        for bad in (
            {"id": "wrong"},
            {"jsonrpc": "1.0"},
            {"error": {"message": "private diagnostic"}},
            {"result": {"verified": True}},
        ):

            def respond(request):
                payload = {
                    "jsonrpc": "2.0",
                    "id": json.loads(request.content)["id"],
                    "error": {"message": "CLEARING_EXECUTION_VERIFIER_UNAVAILABLE"},
                }
                return httpx.Response(503, json={**payload, **bad})

            with self.subTest(bad=bad):
                self.client._http._transport = httpx.MockTransport(respond)
                result = self.tools.settle_contract(self.escrow_id, "trace")
                self.assertNotEqual(result, VERIFIER_PENDING)
                self.assertNotIn("private diagnostic", result)

    def test_unknown_http_errors_402_and_forged_success_never_pay_or_claim_settlement(
        self,
    ):
        for status in (200, 402, 403, 500):
            with self.subTest(status=status):
                self.client._http._transport = httpx.MockTransport(
                    lambda r: httpx.Response(status, json={"verified": True})
                )
                result = self.tools.settle_contract(self.escrow_id, "trace")
                self.assertNotEqual(result, VERIFIER_PENDING)
                self.assertIn("not confirmed", result)
        self.nwc.pay_invoice.assert_not_called()

    def test_quote_amount_hash_signature_and_invoice_validation_happen_before_payment(
        self,
    ):
        original = dict(self.quote)
        for changed in (
            {"amount_sats": 101},
            {"payment_hash": "ff" * 32},
            {"invoice": "not-an-invoice"},
            {"macaroon": 'bad"\r\ncredential'},
            {"escrow_id": "not-a-uuid"},
        ):
            self.quote = {**original, **changed}
            with self.subTest(changed=changed):
                self.assertEqual(self.tools.create_contract(**self.args), SAFE_FAILURE)
        self.nwc.pay_invoice.assert_not_called()

    def test_tampered_creation_response_never_authorizes_payment(self):
        self.client._http._transport = httpx.MockTransport(
            lambda r: self.fixture.signed_response(
                r,
                {"structuredContent": self.quote},
                tamper=True,
            )
        )
        self.assertEqual(self.tools.create_contract(**self.args), SAFE_FAILURE)
        self.nwc.pay_invoice.assert_not_called()

    def test_invalid_inputs_missing_nwc_and_spending_limits_do_not_pay(self):
        for changed in (
            {"amount_sats": True},
            {"amount_sats": 0},
            {"amount_sats": 1001},
            {"task_hash": "bad"},
            {"worker_pubkey": "00" * 32},
        ):
            self.assertEqual(
                self.tools.create_contract(**{**self.args, **changed}), SAFE_FAILURE
            )
        self.assertIn(
            "NWC_URI", ClearingTools(self.client).create_contract(**self.args)
        )
        self.nwc.pay_invoice.assert_not_called()

    def test_uncertain_payment_is_reserved_and_never_retried_or_leaked(self):
        self.nwc.pay_invoice.side_effect = RuntimeError("private-wallet-token")
        self.assertEqual(self.tools.create_contract(**self.args), SAFE_FAILURE)
        self.assertEqual(self.tools.create_contract(**self.args), SAFE_FAILURE)
        self.assertEqual(self.nwc.pay_invoice.call_count, 1)

    def test_invalid_wallet_preimage_never_returns_a_funded_contract_or_repays(self):
        self.nwc.pay_invoice.return_value = {"preimage": "ff" * 32, "fees_paid": 0}
        self.assertEqual(self.tools.create_contract(**self.args), SAFE_FAILURE)
        self.assertEqual(self.tools.create_contract(**self.args), SAFE_FAILURE)
        self.assertEqual(self.nwc.pay_invoice.call_count, 1)

    def test_same_invoice_cannot_fund_another_task_or_be_recovered_under_wrong_scope(
        self,
    ):
        self.assertEqual(self.tools.create_contract(**self.args), self.escrow_id)
        different_task = {**self.args, "task_hash": "cd" * 32}
        self.quote = {**self.quote, "escrow_id": str(uuid.uuid4())}
        self.assertEqual(self.tools.create_contract(**different_task), SAFE_FAILURE)
        self.assertEqual(self.tools.create_contract(**different_task), SAFE_FAILURE)
        self.assertEqual(self.nwc.pay_invoice.call_count, 1)

    def test_concurrent_calls_share_the_durable_request_and_one_payment(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(
                    lambda _: self.tools.create_contract(**self.args), range(2)
                )
            )
        self.assertIn(self.escrow_id, results)
        self.assertEqual(self.tools.create_contract(**self.args), self.escrow_id)
        self.assertEqual(self.nwc.pay_invoice.call_count, 1)

    def test_paid_post_timeout_recovers_same_contract_without_paying_again(self):
        def respond(request):
            if request.headers.get("Authorization", "").startswith("L402 "):
                raise httpx.ReadTimeout("private-transport-diagnostic", request=request)
            return self.respond(request)

        self.client._http._transport = httpx.MockTransport(respond)
        self.assertEqual(self.tools.create_contract(**self.args), SAFE_FAILURE)
        self.client.circuit._limit = 0
        self.assertEqual(self.tools.create_contract(**self.args), self.escrow_id)
        self.assertEqual(self.nwc.pay_invoice.call_count, 1)


class NwcWalletTests(unittest.TestCase):
    def test_native_sdk_connection_is_silent_bounded_and_closed(self):
        import nostr_sdk

        self.assertTrue(inspect.iscoroutinefunction(nostr_sdk.Client.shutdown))

        key = PrivateKey(bytes.fromhex("22" * 32)).public_key.format()[1:].hex()
        uri = f"nostr+walletconnect://{key}?relay=wss%3A%2F%2Frelay.invalid&secret={'33' * 32}"
        wallet = NwcWallet(uri)
        connection = Mock()
        connection.pay_invoice = AsyncMock(
            return_value=SimpleNamespace(
                preimage=PREIMAGE,
                fees_paid=125,
            )
        )
        connection.client.return_value.shutdown = AsyncMock()
        builder = Mock()
        builder.timeout.return_value.build.return_value = connection
        with patch.object(nostr_sdk, "NostrWalletConnectBuilder", return_value=builder):
            self.assertEqual(
                wallet.pay_invoice("test-invoice"),
                {"preimage": PREIMAGE, "fees_paid": 125},
            )
        request = connection.pay_invoice.call_args.args[0]
        self.assertEqual(request.invoice, "test-invoice")
        self.assertIsNone(request.amount)
        connection.client.return_value.shutdown.assert_awaited_once()

    def test_invalid_or_insecure_nwc_configuration_is_redacted(self):
        for uri in (
            "not-an-nwc-uri",
            "nostr+walletconnect://bad?relay=ws://bad&secret=secret",
        ):
            with self.subTest(uri=uri), self.assertRaises(ValueError) as error:
                NwcWallet(uri)
            self.assertNotIn("secret=secret", str(error.exception))

    def test_nwc_timeout_never_retries_or_exposes_provider_diagnostics(self):
        from wallet import WalletError

        wallet = object.__new__(NwcWallet)
        wallet._pay = AsyncMock(side_effect=TimeoutError("private-wallet-token"))
        with self.assertRaises(WalletError) as error:
            wallet.pay_invoice("test-invoice")
        self.assertNotIn("private-wallet-token", str(error.exception))
        wallet._pay.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
