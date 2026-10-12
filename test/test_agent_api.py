# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Deterministic supply math, bounded upstream reads and fail-closed ASGI startup."""

import contextlib
import io
import unittest
from unittest.mock import patch

import httpx
from cryptography.exceptions import InvalidSignature
from fastapi import HTTPException
from fastapi.testclient import TestClient

import agent_api
import main


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
            app = agent_api.create_app()
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

        with patch.object(main, "verify_license", return_value=True):
            app = agent_api.create_app()
            with TestClient(app) as client:
                schema = client.get("/agent-api/openapi.json").json()
                operations = [
                    operation["operationId"]
                    for path in schema["paths"].values()
                    for operation in path.values()
                    if isinstance(operation, dict) and "operationId" in operation
                ]
                self.assertEqual(operations, ["get_supply_metrics"])
                with patch.object(agent_api, "read_live_height", fixed_height):
                    response = client.get("/agent-api/supply-metrics")
                self.assertEqual(response.status_code, 200)
                result = response.json()
                self.assertEqual(result["block_height"], 900_001)
                self.assertEqual(result["supply_limit_btc"], 21_000_000)
                self.assertEqual(result["current_epoch"], 4)
                self.assertIn("Not measured circulating supply", result["supply_method"])
                self.assertEqual(client.get("/agent-api/health").status_code, 200)


if __name__ == "__main__":
    unittest.main()
