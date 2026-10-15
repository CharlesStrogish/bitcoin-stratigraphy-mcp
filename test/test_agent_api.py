# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Deterministic supply math, bounded upstream reads and fail-closed ASGI startup."""

import asyncio
import contextlib
import io
import json
import subprocess
import sys
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from cryptography.exceptions import InvalidSignature
from fastapi import HTTPException
from fastapi.testclient import TestClient

import agent_api
import main
import stratigraphy_pipeline as pipeline
from provenance_fixtures import MemoryArchive


class SupplyCalculationTests(unittest.TestCase):
    def test_genesis(self):
        result = agent_api.calculate_supply_metrics(0)
        self.assertEqual(result.current_epoch, 0)
        self.assertEqual(result.estimated_issued_supply_btc, 50)
        self.assertEqual(result.supply_limit_btc, 21_000_000)

    def test_first_halving_boundary(self):
        before = agent_api.calculate_supply_metrics(209_999)
        after = agent_api.calculate_supply_metrics(210_000)
        self.assertEqual(before.estimated_issued_supply_btc, 10_500_000)
        self.assertEqual(after.estimated_issued_supply_btc, 10_500_025)
        self.assertEqual(after.current_epoch, 1)
        self.assertEqual(after.current_block_subsidy_btc, 25)

    def test_epoch_four_boundary(self):
        result = agent_api.calculate_supply_metrics(840_000)
        self.assertEqual(result.current_epoch, 4)
        self.assertEqual(result.estimated_issued_supply_btc, 19_687_503.125)
        self.assertEqual(result.scheduled_issued_supply_sats, 1_968_750_312_500_000)
        self.assertEqual(result.current_block_subsidy_btc, 3.125)
        self.assertEqual(result.next_halving_height, 1_050_000)

    def test_exhausted_subsidies_do_not_exceed_cap(self):
        result = agent_api.calculate_supply_metrics(agent_api.MAX_BLOCK_HEIGHT)
        self.assertEqual(result.current_block_subsidy_btc, 0)
        self.assertLess(result.estimated_issued_supply_btc, 21_000_000)
        self.assertLess(result.supply_progress_percent, 100)

    def test_invalid_heights_rejected(self):
        for height in (-1, True, 1.5, "840000", agent_api.MAX_BLOCK_HEIGHT + 1):
            with self.subTest(height=height), self.assertRaises(ValueError):
                agent_api.calculate_supply_metrics(height)


class LiveHeightTests(unittest.IsolatedAsyncioTestCase):
    async def test_license_rechecked_before_asgi_startup(self):
        with patch.object(main, "verify_license", return_value=True):
            app = agent_api.create_app(proof_storage=MemoryArchive())
        with (
            patch.object(main, "verify_license", return_value=False),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit),
        ):
            async with app.router.lifespan_context(app):
                self.fail("Expired license reached running ASGI lifespan")

    async def read(self, response=None, error=None):
        def respond(request):
            self.assertEqual(str(request.url), agent_api.TIP_URL)
            if error:
                raise error
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await agent_api.read_live_height(client)

    async def test_valid_live_height(self):
        self.assertEqual(await self.read(httpx.Response(200, text="900001\n")), 900001)

    async def test_invalid_or_oversized_payloads_fail_explicitly(self):
        for text in ("-1", "unavailable", '{"height":900001}', "9" * 100, "2147483648"):
            with self.subTest(text=text), self.assertRaises(HTTPException) as raised:
                await self.read(httpx.Response(200, text=text))
            self.assertEqual(raised.exception.status_code, 502)

    async def test_http_error_fails_explicitly(self):
        with self.assertRaises(HTTPException):
            await self.read(httpx.Response(503))

    async def test_timeout_fails_explicitly(self):
        with self.assertRaises(HTTPException):
            await self.read(error=httpx.ReadTimeout("Test timeout"))


class AgentApiTests(unittest.TestCase):
    def test_invalid_license_prevents_app_creation(self):
        for failure in (FileNotFoundError(), InvalidSignature(), ValueError()):
            with (
                self.subTest(failure=type(failure).__name__),
                patch.object(main, "verify_license", side_effect=failure),
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as raised,
            ):
                agent_api.create_app()
            self.assertEqual(raised.exception.code, 1)

    def test_expired_license_prevents_app_creation(self):
        with (
            patch.object(main, "verify_license", return_value=False),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit),
        ):
            agent_api.create_app()

    def test_single_operation_and_rest_json(self):
        async def fixed_height(_client):
            return 900_001

        with (
            patch.object(main, "verify_license", return_value=True),
            patch.object(pipeline, "read_live_height", fixed_height),
            patch.object(pipeline, "read_live_price", AsyncMock(return_value=(100_000, pipeline.PRICE_URL))) as price_reader,
            patch.object(pipeline, "read_live_hashrate", AsyncMock(return_value=1e21)) as hashrate_reader,
        ):
            app = agent_api.create_app(proof_storage=MemoryArchive())
            with TestClient(app) as client:
                schema = client.get("/agent-api/openapi.json").json()
                operations = [
                    operation["operationId"]
                    for path in schema["paths"].values()
                    for operation in path.values()
                    if isinstance(operation, dict) and "operationId" in operation
                ]
                self.assertEqual(operations, ["get_supply_metrics", "get_historical_proof"])
                response = client.get("/agent-api/supply-metrics")
                self.assertEqual(response.status_code, 200)
                result = response.json()
                self.assertEqual(result["block_height"], 900_001)
                self.assertEqual(result["supply_limit_btc"], 21_000_000)
                self.assertEqual(result["current_epoch"], 4)
                self.assertIn("Not measured circulating supply", result["supply_method"])
                self.assertEqual(result["hal_finney_horizon_multiple"], 100)
                self.assertEqual(result["attribution"], pipeline.ATTRIBUTION)
                keys = list(result)
                self.assertEqual(keys[keys.index("hal_finney_horizon_multiple") + 1], "attribution")
                self.assertEqual(result["network_energy_watts"], 15_000_000_000)
                self.assertEqual(result["efficiency_baseline_j_th"], 15)
                self.assertEqual(client.get("/agent-api/health").status_code, 200)
                self.assertTrue(client.get("/agent-api/health").json()["pipeline_ready"])
                self.assertEqual(client.get("/agent-api/supply-metrics").status_code, 200)
                price_reader.assert_awaited_once()
                hashrate_reader.assert_awaited_once()
            self.assertIsNone(app.state.stratigraphy_pipeline._task)

    def test_failed_pipeline_returns_explicit_service_unavailable(self):
        with (
            patch.object(main, "verify_license", return_value=True),
            patch.object(pipeline, "read_live_height", AsyncMock(side_effect=pipeline.PipelineUnavailable())),
            patch.object(pipeline, "read_live_price", AsyncMock(return_value=(100_000, pipeline.PRICE_URL))),
            patch.object(pipeline, "read_live_hashrate", AsyncMock(return_value=1e21)),
        ):
            app = agent_api.create_app(proof_storage=MemoryArchive())
            with TestClient(app) as client:
                response = client.get("/agent-api/supply-metrics")
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("block_height", response.json())
                self.assertFalse(client.get("/agent-api/health").json()["pipeline_ready"])


class ColdStartTests(unittest.TestCase):
    """Startup does not wait for upstream data; live reads wait for it, bounded."""

    def live_inputs(self, release: threading.Event):
        async def read_height(_client):
            while not release.is_set():
                await asyncio.sleep(0.01)
            return 900_001

        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(main, "verify_license", return_value=True))
        stack.enter_context(patch.object(pipeline, "read_live_height", read_height))
        stack.enter_context(
            patch.object(pipeline, "read_live_price", AsyncMock(return_value=(100_000, pipeline.PRICE_URL)))
        )
        stack.enter_context(patch.object(pipeline, "read_live_hashrate", AsyncMock(return_value=1e21)))
        return stack

    def test_health_answers_at_once_and_metrics_wait_for_the_first_refresh(self):
        release = threading.Event()
        self.addCleanup(release.set)
        with self.live_inputs(release):
            app = agent_api.create_app(proof_storage=MemoryArchive())
            with TestClient(app) as client:
                health = client.get("/agent-api/health")
                self.assertEqual(health.status_code, 200)
                self.assertFalse(health.json()["pipeline_ready"])
                timer = threading.Timer(0.2, release.set)
                self.addCleanup(timer.cancel)
                started = time.monotonic()
                timer.start()
                metrics = client.get("/agent-api/supply-metrics")
                self.assertEqual(metrics.status_code, 200)
                self.assertEqual(metrics.json()["block_height"], 900_001)
                self.assertGreaterEqual(time.monotonic() - started, 0.15)
                self.assertTrue(client.get("/agent-api/health").json()["pipeline_ready"])

    def test_metrics_answer_503_when_the_first_refresh_outlasts_the_wait(self):
        release = threading.Event()
        self.addCleanup(release.set)
        with self.live_inputs(release), patch.object(pipeline, "FIRST_REFRESH_WAIT_SECONDS", 0.2):
            app = agent_api.create_app(proof_storage=MemoryArchive())
            with TestClient(app) as client:
                started = time.monotonic()
                response = client.get("/agent-api/supply-metrics")
                elapsed = time.monotonic() - started
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("block_height", response.json())
                self.assertGreaterEqual(elapsed, 0.15)
                self.assertLess(elapsed, 3)


class DeferredDependencyTests(unittest.TestCase):
    def test_heavy_dependencies_load_only_when_first_needed(self):
        # A fresh interpreter, loading the app exactly as the server does.
        script = textwrap.dedent(
            """
            import json, sys
            import main
            main.verify_license = lambda *args, **kwargs: True
            import agent_startup
            app = agent_startup._load_agent_api()
            heavy = ("fastapi_mcp", "mcp", "google.cloud.storage", "replit.object_storage",
                     "opentimestamps", "bitcoin", "rich", "pygments")
            loaded = [name for name in heavy if name in sys.modules]
            server, _transport = app.state.mcp.start().result(timeout=120)
            print(json.dumps({"loaded": loaded, "tools": [tool.name for tool in server.tools]}))
            """
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=Path(agent_api.__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=180,
        )
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        report = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(report["loaded"], [])
        self.assertEqual(report["tools"], ["get_supply_metrics", "get_historical_proof"])


class LazyMcpServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_disconnecting_request_does_not_cancel_the_shared_build(self):
        release = threading.Event()
        builds = []

        def build():
            builds.append(threading.current_thread().name)
            release.wait(5)
            return "server", "transport"

        server = agent_api.LazyMcpServer(build)
        waiting = asyncio.ensure_future(server.get())
        await asyncio.sleep(0.05)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        release.set()
        self.assertEqual(await server.get(), ("server", "transport"))
        self.assertIs(server.start(), server.start())
        self.assertEqual(builds, ["agent-api-mcp"])

    def test_a_failed_build_answers_503_without_affecting_rest_routes(self):
        with (
            patch.object(main, "verify_license", return_value=True),
            patch.object(pipeline, "read_live_height", AsyncMock(return_value=900_001)),
            patch.object(pipeline, "read_live_price", AsyncMock(return_value=(100_000, pipeline.PRICE_URL))),
            patch.object(pipeline, "read_live_hashrate", AsyncMock(return_value=1e21)),
            patch("fastapi_mcp.FastApiMCP", side_effect=RuntimeError("unavailable")),
            self.assertLogs("agent_api", level="ERROR"),
        ):
            app = agent_api.create_app(proof_storage=MemoryArchive())
            with TestClient(app) as client:
                response = client.post("/agent-api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"detail": "MCP server unavailable"})
                self.assertEqual(client.get("/agent-api/supply-metrics").status_code, 200)


if __name__ == "__main__":
    unittest.main()
