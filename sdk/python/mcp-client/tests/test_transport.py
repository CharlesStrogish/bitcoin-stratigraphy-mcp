# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Offline payment and official-MCP integration tests with HTTPX MockTransport."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.util
import json
import unittest

import httpx

from bitcoin_stratigraphy_mcp_client import (
    DEFAULT_MCP_URL,
    L402Challenge,
    L402Nip98Transport,
    PaymentError,
)

KEY = "00" * 31 + "01"
PREIMAGE = "ab" * 32
HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()


def challenge(**overrides: object) -> httpx.Response:
    data = {
        "macaroon": "test-macaroon",
        "invoice": "lnbc-test-wallet-fixture",
        "payment_hash": HASH,
        "amount_sats": 24,
        **overrides,
    }
    return httpx.Response(
        402,
        json=data,
        headers={
            "WWW-Authenticate": 'L402 macaroon="test-macaroon", invoice="lnbc-test-wallet-fixture"'
        },
    )


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_paid_retry_keeps_body_and_signs_fresh_auth(self) -> None:
        requests: list[httpx.Request] = []
        paid: list[L402Challenge] = []

        async def wallet(value: L402Challenge) -> str:
            paid.append(value)
            return PREIMAGE

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return (
                challenge()
                if len(requests) == 1
                else httpx.Response(200, json={"ok": True})
            )

        adapter = L402Nip98Transport(
            KEY, wallet, transport=httpx.MockTransport(handler)
        )
        async with adapter.http_client_factory() as client:
            response = await client.post(DEFAULT_MCP_URL, content=b'{"id":1}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(paid), 1)
        self.assertEqual(paid[0].amount_sats, 24)
        self.assertEqual(paid[0].invoice, "lnbc-test-wallet-fixture")
        self.assertEqual(requests[0].content, requests[1].content)
        self.assertNotIn("authorization", requests[0].headers)
        self.assertEqual(
            requests[1].headers["authorization"], f"L402 test-macaroon:{PREIMAGE}"
        )
        events = [
            json.loads(base64.b64decode(r.headers["x-nostr-authorization"][6:]))
            for r in requests
        ]
        self.assertNotEqual(events[0]["id"], events[1]["id"])
        self.assertEqual(
            dict(events[1]["tags"])["payload"], hashlib.sha256(b'{"id":1}').hexdigest()
        )

    async def test_wrong_preimage_prevents_paid_retry(self) -> None:
        count = 0

        async def wallet(value: L402Challenge) -> str:
            return "cd" * 32

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal count
            count += 1
            return challenge()

        adapter = L402Nip98Transport(
            KEY, wallet, transport=httpx.MockTransport(handler)
        )
        async with adapter.http_client_factory() as client:
            with self.assertRaises(PaymentError):
                await client.post(DEFAULT_MCP_URL, json={})
        self.assertEqual(count, 1)

    async def test_repeated_402_never_triggers_second_payment(self) -> None:
        calls = 0

        async def wallet(value: L402Challenge) -> str:
            nonlocal calls
            calls += 1
            return PREIMAGE

        adapter = L402Nip98Transport(
            KEY, wallet, transport=httpx.MockTransport(lambda _: challenge())
        )
        async with adapter.http_client_factory() as client:
            with self.assertRaises(PaymentError):
                await client.post(DEFAULT_MCP_URL, json={})
        self.assertEqual(calls, 1)

    async def test_conflicting_or_missing_challenges_never_call_wallet(self) -> None:
        async def wallet(value: L402Challenge) -> str:
            self.fail("Malformed challenge must not reach wallet")

        for response in (
            challenge(invoice="lnbc-other"),
            challenge(payment_hash="invalid"),
            challenge(amount_sats=True),
            httpx.Response(402, json={"error": "proof of work required"}),
        ):
            adapter = L402Nip98Transport(
                KEY, wallet, transport=httpx.MockTransport(lambda _, r=response: r)
            )
            async with adapter.http_client_factory() as client:
                with self.assertRaises(PaymentError):
                    await client.post(DEFAULT_MCP_URL, json={})

    async def test_concurrent_identical_challenge_calls_wallet_once(self) -> None:
        calls = 0

        async def wallet(value: L402Challenge) -> str:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0)
            return PREIMAGE

        def handler(request: httpx.Request) -> httpx.Response:
            if "authorization" in request.headers:
                return httpx.Response(200, json={"ok": True})
            return challenge()

        adapter = L402Nip98Transport(
            KEY, wallet, transport=httpx.MockTransport(handler)
        )
        async with adapter.http_client_factory() as client:
            responses = await asyncio.gather(
                *[client.post(DEFAULT_MCP_URL, json={"id": i}) for i in range(5)]
            )
        self.assertTrue(all(r.status_code == 200 for r in responses))
        self.assertEqual(calls, 1)

    async def test_destination_and_external_auth_fail_closed(self) -> None:
        async def wallet(value: L402Challenge) -> str:
            self.fail("No wallet calls expected")

        def handler(request: httpx.Request) -> httpx.Response:
            self.fail("No network requests expected")

        adapter = L402Nip98Transport(
            KEY, wallet, transport=httpx.MockTransport(handler)
        )
        async with adapter.http_client_factory() as client:
            for url, headers in (
                ("https://other.example/mcp", {}),
                (DEFAULT_MCP_URL, {"Authorization": "Bearer external"}),
            ):
                with self.assertRaises(ValueError):
                    await client.post(url, json={}, headers=headers)

    @unittest.skipUnless(
        importlib.util.find_spec("langchain_mcp_adapters"), "requires langchain extra"
    )
    async def test_standard_mcp_session_initializes_and_loads_langchain_tools(
        self,
    ) -> None:
        async def wallet(value: L402Challenge) -> str:
            self.fail("Free protocol discovery must not pay")

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertIn("x-nostr-authorization", request.headers)
            message = json.loads(request.content)
            if "id" not in message:
                return httpx.Response(202)
            if message["method"] == "initialize":
                result = {
                    "protocolVersion": message["params"]["protocolVersion"],
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "offline-fixture", "version": "1"},
                }
            else:
                self.assertEqual(message["method"], "tools/list")
                result = {
                    "tools": [
                        {
                            "name": "fixture.read",
                            "description": "Offline test tool",
                            "inputSchema": {"type": "object", "properties": {}},
                        }
                    ]
                }
            return httpx.Response(
                200, json={"jsonrpc": "2.0", "id": message["id"], "result": result}
            )

        adapter = L402Nip98Transport(
            KEY, wallet, transport=httpx.MockTransport(handler)
        )
        async with adapter.langchain_tools() as tools:
            self.assertEqual([tool.name for tool in tools], ["fixture.read"])

    async def test_wallet_decline_propagates_without_retry(self) -> None:
        async def wallet(value: L402Challenge) -> str:
            raise PermissionError("Wallet policy declined")

        adapter = L402Nip98Transport(
            KEY, wallet, transport=httpx.MockTransport(lambda _: challenge())
        )
        async with adapter.http_client_factory() as client:
            with self.assertRaises(PermissionError):
                await client.post(DEFAULT_MCP_URL, json={})


if __name__ == "__main__":
    unittest.main()
