# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Offline payment/transport regression tests: no real invoices or wallet calls."""

import asyncio
import hashlib
import json
import unittest

import httpx

from cookbooks.l402_client import (
    BitcoinStratigraphyClient, CANONICAL_TOOLS, L402Auth,
    PaymentRejectedError, PaymentRequiredError, _invoice_details,
    async_httpx_factory, validate_catalog,
)

URL = "https://merchant.example/mcp"
PREIMAGE = "23" * 32  # Public, synthetic fixture, never usable as a real payment.
HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()


def invoice(sats=250, payment_hash=HASH):
    """Unsigned synthetic BOLT11 envelope for parser tests, not a payable invoice."""
    alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    hrp = f"lnbc{sats * 10}n"
    number = int(payment_hash, 16) << 4
    words = [0] * 7 + [1, 1, 20]
    words += [(number >> (5 * offset)) & 31 for offset in range(51, -1, -1)]
    words += [0] * 104
    expanded = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    check = 1
    for value in expanded + words + [0] * 6:
        top = check >> 25
        check = ((check & 0x1FFFFFF) << 5) ^ value
        for index, generator in enumerate((0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)):
            if (top >> index) & 1:
                check ^= generator
    check ^= 1
    words += [(check >> (5 * offset)) & 31 for offset in range(5, -1, -1)]
    return hrp + "1" + "".join(alphabet[word] for word in words)


def challenge(request, sats=250, **overrides):
    body = {"macaroon": "synthetic_macaroon", "invoice": invoice(sats),
            "payment_hash": HASH, "amount_sats": sats}
    body.update(overrides)
    return httpx.Response(402, request=request, json=body, headers={
        "WWW-Authenticate": f'L402 macaroon="{body["macaroon"]}", invoice="{body["invoice"]}"',
    })


class L402Tests(unittest.TestCase):
    def test_invoice_parser(self):
        self.assertEqual(_invoice_details(invoice()), (HASH, 250_000))
        with self.assertRaises(ValueError):
            _invoice_details(invoice()[:-1] + "q")

    def test_payment_retry_exact_body_and_no_cached_credentials(self):
        calls, paid = [], []

        def server(request):
            calls.append((request.content, request.headers.get("Authorization")))
            if request.headers.get("Authorization"):
                return httpx.Response(200, json={"ok": True})
            return challenge(request)

        auth = L402Auth(URL, lambda value: paid.append(value) or PREIMAGE)
        with httpx.Client(auth=auth, transport=httpx.MockTransport(server)) as client:
            for _ in range(2):
                response = client.post(URL, json={"method": "tools/call", "params": {"name": "stratigraphy.get"}})
                self.assertTrue(response.json()["ok"])
                self.assertNotIn("Authorization", response.request.headers)
        self.assertEqual(len(paid), 2)
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[0][0], calls[1][0])
        self.assertIsNone(calls[2][1])
        self.assertEqual(calls[1][1], f"L402 synthetic_macaroon:{PREIMAGE}")

    def test_no_wallet_explicit_error(self):
        with httpx.Client(auth=L402Auth(URL), transport=httpx.MockTransport(challenge)) as client:
            with self.assertRaises(PaymentRequiredError):
                client.get("https://merchant.example/api/v1/stratigraphy")

    def test_wrong_or_uuid_preimage_never_sent(self):
        for preimage in ("45" * 32, "12345678-1234-1234-1234-123456789abc"):
            calls = []
            with httpx.Client(
                auth=L402Auth(URL, lambda _: preimage),
                transport=httpx.MockTransport(lambda r: calls.append(r) or challenge(r)),
            ) as client:
                with self.assertRaises(ValueError):
                    client.get("https://merchant.example/api/v1/stratigraphy")
            self.assertEqual(len(calls), 1)
            self.assertNotIn("Authorization", calls[0].headers)

    def test_invalid_challenge_never_calls_wallet(self):
        for overrides in (
            {"payment_hash": "00" * 32}, {"amount_sats": 1},
            {"amount_sats": True}, {"invoice": "not-an-invoice"},
        ):
            paid = []
            with httpx.Client(
                auth=L402Auth(URL, lambda c: paid.append(c) or PREIMAGE),
                transport=httpx.MockTransport(lambda r: challenge(r, **overrides)),
            ) as client:
                with self.assertRaises(ValueError):
                    client.get("https://merchant.example/api/v1/stratigraphy")
            self.assertEqual(paid, [])

    def test_header_body_mismatch_rejected(self):
        def server(request):
            response = challenge(request)
            response.headers["WWW-Authenticate"] = 'L402 macaroon="different", invoice="wrong"'
            return response
        with httpx.Client(auth=L402Auth(URL, lambda _: PREIMAGE), transport=httpx.MockTransport(server)) as client:
            with self.assertRaises(ValueError):
                client.get("https://merchant.example/api/v1/stratigraphy")

    def test_limits_checked_before_payment(self):
        for auth, amount in (
            (L402Auth(URL, lambda _: self.fail("Wallet must not be called"), max_sats=10), 250),
            (L402Auth(URL, lambda _: self.fail("Wallet must not be called"), budget_sats=10), 250),
        ):
            with httpx.Client(auth=auth, transport=httpx.MockTransport(lambda r: challenge(r, amount))) as client:
                with self.assertRaises(ValueError):
                    client.get("https://merchant.example/api/v1/stratigraphy")

    def test_second_402_does_not_pay_again(self):
        paid = []
        with httpx.Client(
            auth=L402Auth(URL, lambda c: paid.append(c) or PREIMAGE),
            transport=httpx.MockTransport(challenge),
        ) as client:
            with self.assertRaises(PaymentRejectedError):
                client.get("https://merchant.example/api/v1/stratigraphy")
        self.assertEqual(len(paid), 1)

    def test_discovery_and_other_origins_never_pay(self):
        auth = L402Auth(URL, lambda _: self.fail("Wallet must not be called"))
        with httpx.Client(auth=auth, transport=httpx.MockTransport(challenge)) as client:
            with self.assertRaises(ValueError):
                client.post(URL, json={"method": "tools/list"})
            with self.assertRaises(ValueError):
                client.get("https://other.example/api/v1/stratigraphy")

    def test_failed_wallet_reservation_is_not_released(self):
        def fail(_):
            raise RuntimeError("Ambiguous wallet result")
        auth = L402Auth(URL, fail, budget_sats=250)
        with httpx.Client(auth=auth, transport=httpx.MockTransport(challenge)) as client:
            with self.assertRaises(RuntimeError):
                client.get("https://merchant.example/api/v1/stratigraphy")
            auth.pay_invoice = lambda _: self.fail("Do not attempt payment again")
            with self.assertRaises(ValueError):
                client.get("https://merchant.example/api/v1/stratigraphy")

    def test_mcp_handshake_catalog_and_tool_error(self):
        notifications = []
        def server(request):
            body = json.loads(request.content)
            method = body["method"]
            if method == "initialize":
                result = {"protocolVersion": "2025-11-25", "capabilities": {}, "serverInfo": {}}
            elif method == "notifications/initialized":
                notifications.append(body)
                return httpx.Response(202)
            elif method == "tools/list":
                result = {"tools": [{"name": name} for name in sorted(CANONICAL_TOOLS)]}
            else:
                result = {"isError": True, "content": [{"type": "text", "text": "Invalid proof"}]}
            return httpx.Response(
                200, headers={"Mcp-Session-Id": "test-session", "Content-Type": "application/json"},
                stream=httpx.ByteStream(json.dumps({
                    "jsonrpc": "2.0", "id": body["id"], "result": result,
                }).encode()),
            )
        with BitcoinStratigraphyClient(URL, transport=httpx.MockTransport(server)) as client:
            self.assertEqual(len(validate_catalog(client.list_tools())), 14)
            with self.assertRaises(RuntimeError):
                client.call_tool("proof.verify", {})
        self.assertEqual(len(notifications), 1)

    def test_catalog_rejects_duplicates_and_missing(self):
        for names in ([], ["payment.get_info"] * 14):
            with self.assertRaises(ValueError):
                validate_catalog([{"name": name} for name in names])

    def test_sse_rpc_result(self):
        def server(request):
            body = json.loads(request.content)
            result = {"protocolVersion": "2025-11-25"} if body["method"] == "initialize" else {"tools": []}
            if "id" not in body:
                return httpx.Response(202)
            data = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result})
            return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, text=f"event: message\ndata: {data}\n\n")
        with BitcoinStratigraphyClient(URL, transport=httpx.MockTransport(server)) as client:
            self.assertEqual(client.list_tools(), [])


class AsyncL402Tests(unittest.IsolatedAsyncioTestCase):
    async def test_async_retry_and_shared_factory_budget(self):
        paid, sent = [], []
        async def server(request):
            sent.append(request.headers.get("Authorization"))
            if sent[-1]:
                return httpx.Response(200, json={"ok": True})
            return challenge(request)
        factory = async_httpx_factory(URL, lambda c: paid.append(c) or PREIMAGE, budget_sats=250)
        for index in range(2):
            async with factory() as client:
                # Replace the transport only inside this offline test.
                client._transport = httpx.MockTransport(server)
                if index == 0:
                    response = await client.post(URL, json={"method": "tools/call", "params": {"name": "stratigraphy.get"}})
                    self.assertTrue(response.json()["ok"])
                else:
                    with self.assertRaises(ValueError):
                        await client.post(URL, json={"method": "tools/call", "params": {"name": "stratigraphy.get"}})
        self.assertEqual(len(paid), 1)
        self.assertEqual(sent[1], f"L402 synthetic_macaroon:{PREIMAGE}")

    async def test_successful_sse_is_not_prebuffered_by_auth(self):
        class LiveStream(httpx.AsyncByteStream):
            def __init__(self):
                self.reads = 0
            async def __aiter__(self):
                self.reads += 1
                yield b"data: ready\n\n"
                await asyncio.sleep(60)
        stream = LiveStream()
        async def server(_):
            return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=stream)
        async with httpx.AsyncClient(auth=L402Auth(URL), transport=httpx.MockTransport(server)) as client:
            async with client.stream("GET", URL) as response:
                self.assertEqual(stream.reads, 0)
                self.assertEqual(await anext(response.aiter_bytes()), b"data: ready\n\n")


if __name__ == "__main__":
    unittest.main()