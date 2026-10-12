# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Offline transport fixtures: every local request must target the node, never a public API."""

import asyncio
import base64
import json
import os
import unittest
from unittest.mock import patch

import httpx

import stratigraphy_pipeline as pipeline

RPC_ENV = {
    "BITCOIN_CORE_RPC_URL": "http://127.0.0.1:8332",
    "RPC_USER": "fixture-user",
    "RPC_PASSWORD": "fixture-password",
}
BLOCK_HASH = "a" * 64
CHAIN_INFO = {
    "chain": "main", "blocks": 971032, "bestblockhash": BLOCK_HASH,
    "initialblockdownload": False,
}
HEADER = {"hash": BLOCK_HASH, "height": 971032, "time": 1791800000, "bits": "17012345"}


def rpc_response(request):
    assert str(request.url) == RPC_ENV["BITCOIN_CORE_RPC_URL"]
    assert request.method == "POST"
    expected = base64.b64encode(b"fixture-user:fixture-password").decode()
    assert request.headers["Authorization"] == f"Basic {expected}"
    data = json.loads(request.content)
    assert data["jsonrpc"] == "1.0"
    result = {
        "getblockchaininfo": CHAIN_INFO,
        "getblockheader": HEADER,
        "getnetworkhashps": 1e21,
    }[data["method"]]
    return httpx.Response(200, json={"id": data["id"], "error": None, "result": result})


class RpcConfigTests(unittest.TestCase):
    def test_no_configuration_preserves_public_mode(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(pipeline.BitcoinCoreConfig.from_environment())

    def test_complete_configuration_and_secret_safe_repr(self):
        with patch.dict(os.environ, RPC_ENV, clear=True):
            config = pipeline.BitcoinCoreConfig.from_environment()
        self.assertEqual(config.url, RPC_ENV["BITCOIN_CORE_RPC_URL"])
        self.assertEqual(repr(config), "BitcoinCoreConfig()")

    def test_partial_empty_and_invalid_configuration_fails_closed(self):
        invalid = [
            {key: value} for key, value in RPC_ENV.items()
        ] + [
            {**RPC_ENV, key: value}
            for key in RPC_ENV for value in ("", " ")
        ] + [
            {**RPC_ENV, "BITCOIN_CORE_RPC_URL": value}
            for value in (
                "file:///etc/passwd", "http://", "http://node:wrong",
                "http://node:0", "http://[", "http://user:password@node",
                "http://node?secret=value", "http://node#fragment",
            )
        ]
        for env in invalid:
            with self.subTest(env_keys=list(env)), patch.dict(os.environ, env, clear=True):
                with self.assertRaises(pipeline.PipelineUnavailable):
                    pipeline.BitcoinCoreConfig.from_environment()


class RpcPipelineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, RPC_ENV, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    async def test_snapshot_uses_only_three_authenticated_rpc_commands(self):
        requests = []
        def response(request):
            requests.append(json.loads(request.content))
            return rpc_response(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            worker = pipeline.StratigraphyPipeline(client)
            await worker._refresh()
            snapshot = worker.get_snapshot()
            self.assertEqual(snapshot.block_height, 971032)
            self.assertEqual(snapshot.best_block_hash, BLOCK_HASH)
            self.assertEqual(snapshot.block_header, HEADER)
            self.assertEqual(snapshot.network_hashrate_h_s, 1e21)
            self.assertEqual(snapshot.network_energy_watts, 15e9)
            self.assertIsNone(snapshot.btc_price_usd)
            self.assertIsNone(snapshot.hal_finney_horizon_multiple)
            self.assertEqual(snapshot.source, "bitcoin-core-rpc:getblockchaininfo")
            self.assertEqual(snapshot.hashrate_source, "bitcoin-core-rpc:getnetworkhashps")
            self.assertIn("no-fiat-price", snapshot.price_source)
            self.assertEqual(
                [(r["method"], r["params"]) for r in requests],
                [
                    ("getblockchaininfo", []),
                    ("getblockheader", [BLOCK_HASH, True]),
                    ("getnetworkhashps", [120, 971032]),
                ],
            )
            # JSON, including the nullable horizon, remains valid for archive readers.
            pipeline.StratigraphyMetrics.model_validate_json(snapshot.model_dump_json())
            await worker.stop()

    async def test_direct_readers_never_contact_public_endpoints(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(rpc_response)) as client:
            self.assertEqual(await pipeline.read_live_height(client), 971032)
            self.assertEqual(await pipeline.read_live_hashrate(client), 1e21)
            self.assertEqual(
                await pipeline.read_live_price(client),
                (None, "unavailable:bitcoin-core-has-no-fiat-price"),
            )

    async def test_invalid_rpc_envelopes_and_http_failures(self):
        responses = [
            httpx.Response(status) for status in (401, 403, 500)
        ] + [
            httpx.Response(200, json=body)
            for body in (
                [], {"id": "wrong", "result": CHAIN_INFO},
                {"id": "getblockchaininfo"},
                {"id": "getblockchaininfo", "result": None, "error": {"message": "secret"}},
            )
        ] + [
            httpx.Response(200, content=b"\xff"),
            httpx.Response(200, text="{broken"),
            httpx.Response(200, text="x" * (256 * 1024 + 1)),
            httpx.Response(302, headers={"location": pipeline.TIP_URL}),
        ]
        for bad in responses:
            requests = []
            def response(request):
                requests.append(str(request.url))
                return bad
            # Even a redirect-enabled injected client must not follow RPC redirects.
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(response), follow_redirects=True,
            ) as client:
                with self.assertRaises(pipeline.PipelineUnavailable) as raised:
                    await pipeline.StratigraphyPipeline(client)._refresh()
                self.assertEqual(str(raised.exception), "Bitcoin Core RPC input unavailable")
                self.assertEqual(requests, [RPC_ENV["BITCOIN_CORE_RPC_URL"]])

    async def test_transport_timeouts_never_fallback(self):
        for exception in (httpx.ReadTimeout("private"), TimeoutError("private")):
            requests = []
            def response(request):
                requests.append(str(request.url))
                raise exception
            async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
                with self.assertRaises(pipeline.PipelineUnavailable):
                    await pipeline.StratigraphyPipeline(client)._refresh()
            self.assertEqual(requests, [RPC_ENV["BITCOIN_CORE_RPC_URL"]])

    async def test_invalid_chain_header_and_hashrate_data(self):
        bad_results = [
            ("getblockchaininfo", None),
            *[
                ("getblockchaininfo", {**CHAIN_INFO, key: value})
                for key, value in (
                    ("chain", "test"), ("blocks", True), ("blocks", -1),
                    ("blocks", pipeline.MAX_BLOCK_HEIGHT + 1),
                    ("bestblockhash", None), ("bestblockhash", "invalid"),
                    ("initialblockdownload", True),
                )
            ],
            ("getblockheader", None),
            *[
                ("getblockheader", {**HEADER, key: value})
                for key, value in (
                    ("hash", "b" * 64), ("height", True), ("height", 1),
                    ("time", True), ("time", -1),
                )
            ],
            *[("getnetworkhashps", value) for value in (0, -1, None, True, "1e21", float("inf"))],
        ]
        for method, value in bad_results:
            with self.subTest(method=method, value=value):
                def response(request):
                    result = rpc_response(request)
                    if json.loads(request.content)["method"] == method:
                        # encode manually to exercise non-finite upstream JSON rejection too
                        return httpx.Response(200, text=json.dumps({"id": method, "error": None, "result": value}))
                    return result
                async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
                    with self.assertRaises(pipeline.PipelineUnavailable):
                        await pipeline.StratigraphyPipeline(client)._refresh()

    async def test_worker_discards_failed_rpc_snapshot_then_recovers_without_public_calls(self):
        failed = False
        def response(request):
            rpc_response(request)  # asserts exact private URL and authentication, even on failures
            return httpx.Response(503) if failed else rpc_response(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            worker = pipeline.StratigraphyPipeline(client, refresh_interval=0.01)
            try:
                await worker.start()
                self.assertTrue(worker.ready)
                failed = True
                async with asyncio.timeout(1):
                    while worker.ready:
                        await asyncio.sleep(0.002)
                failed = False
                async with asyncio.timeout(1):
                    while not worker.ready:
                        await asyncio.sleep(0.002)
                self.assertEqual(worker.get_snapshot().block_header, HEADER)
            finally:
                await worker.stop()

    async def test_partial_configuration_worker_never_contacts_any_host(self):
        def response(_request):
            self.fail("Misconfigured RPC must not make any network request")
        with patch.dict(os.environ, {"RPC_USER": "fixture-user"}, clear=True):
            async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
                worker = pipeline.StratigraphyPipeline(client)
                try:
                    await worker.start()
                    self.assertFalse(worker.ready)
                finally:
                    await worker.stop()


if __name__ == "__main__":
    unittest.main()
