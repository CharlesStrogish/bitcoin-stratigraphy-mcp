# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Live-provider parsing, exact requested models and continuous worker lifecycle."""

import asyncio
import os
import time
import unittest
from unittest.mock import patch

import httpx
from pydantic import ValidationError

import stratigraphy_pipeline as pipeline


def live_response(request):
    url = str(request.url)
    if url == pipeline.TIP_URL:
        return httpx.Response(200, text="971032")
    if url == pipeline.HASHRATE_URL:
        return httpx.Response(200, json={"currentHashrate": 1e21})
    if url == pipeline.PRICE_URL:
        return httpx.Response(200, json={"data": {"base": "BTC", "currency": "USD", "amount": "83530.875"}})
    if url == pipeline.PRICE_FALLBACK_URL:
        return httpx.Response(200, json={"USD": 83000, "time": time.time()})
    raise AssertionError("Unexpected provider")


class MetricModelTests(unittest.TestCase):
    def test_invalid_heights_and_numeric_conversion_failures(self):
        for height in (-1, True, "1", pipeline.MAX_BLOCK_HEIGHT + 1):
            with self.assertRaises(ValueError):
                pipeline.calculate_supply_metrics(height)
        self.assertEqual(pipeline.calculate_supply_metrics(0).scheduled_issued_supply_sats, 50 * 10**8)
        self.assertEqual(pipeline.calculate_supply_metrics(pipeline.MAX_BLOCK_HEIGHT).current_block_subsidy_btc, 0)
        for value in ("bad", 10**1000):
            with self.assertRaises(pipeline.PipelineUnavailable):
                pipeline._positive_number(value, allow_string=True)

    def test_requested_formulas_and_exact_metadata(self):
        result = pipeline.calculate_stratigraphy_metrics(971032, 83530.875, 1e21, pipeline.PRICE_URL)
        self.assertEqual(result.hal_finney_horizon_multiple, 10000000.0 / 83530.875)
        self.assertEqual(result.network_hashrate_th_s, 1_000_000_000)
        self.assertEqual(result.network_energy_watts, 15_000_000_000)
        self.assertEqual(result.efficiency_baseline_j_th, 15)
        self.assertEqual(result.attribution, "Projected by Hal Finney on January 10, 2009 ($10M per coin valuation under total global wealth absorption).")
        self.assertEqual(result.current_epoch, 4)
        keys = list(result.model_dump())
        self.assertEqual(keys[keys.index("hal_finney_horizon_multiple") + 1], "attribution")
        self.assertIn("Not measured electricity", result.energy_method)

    def test_no_horizon_clamp_or_invented_days_forecast(self):
        result = pipeline.calculate_stratigraphy_metrics(971032, 20_000_000, 1e21, pipeline.PRICE_URL)
        self.assertEqual(result.hal_finney_horizon_multiple, 0.5)
        self.assertNotIn("days_remaining", result.model_dump())

    def test_invalid_inputs_and_nonfinite_calculations_are_rejected(self):
        for invalid in (0, -1, True, "100", float("nan"), float("inf")):
            with self.subTest(invalid=invalid), self.assertRaises(pipeline.PipelineUnavailable):
                pipeline.calculate_stratigraphy_metrics(971032, invalid, 1e21, pipeline.PRICE_URL)
            with self.subTest(invalid_hashrate=invalid), self.assertRaises(pipeline.PipelineUnavailable):
                pipeline.calculate_stratigraphy_metrics(971032, 100000, invalid, pipeline.PRICE_URL)
        with self.assertRaises(ValidationError):
            pipeline.calculate_stratigraphy_metrics(971032, 1e-320, 1e21, pipeline.PRICE_URL)

    def test_snapshot_is_immutable(self):
        result = pipeline.calculate_stratigraphy_metrics(971032, 100000, 1e21, pipeline.PRICE_URL)
        with self.assertRaises(ValidationError):
            result.btc_price_usd = 1


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        env = patch.dict(os.environ, {}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    async def test_height_parser_rejects_invalid_public_responses(self):
        for body in (b"invalid", b"\xff", b"2147483648", b"x" * 33):
            async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=body),
            )) as client:
                with self.assertRaises(pipeline.PipelineUnavailable):
                    await pipeline.read_live_height(client)

    async def test_invalid_worker_intervals(self):
        async with httpx.AsyncClient() as client:
            for value in (0, -1, float("nan"), float("inf")):
                for key in ("refresh_interval", "max_age"):
                    with self.assertRaises(ValueError):
                        pipeline.StratigraphyPipeline(client, **{key: value})

    async def test_failed_public_input_cancels_remaining_tasks(self):
        cancelled = []
        async def failed(_client):
            await asyncio.sleep(0)
            raise pipeline.PipelineUnavailable("fixture failure")
        async def pending(_client):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)
        async with httpx.AsyncClient() as client:
            worker = pipeline.StratigraphyPipeline(client)
            with (
                patch.object(pipeline, "read_live_height", failed),
                patch.object(pipeline, "read_live_price", pending),
                patch.object(pipeline, "read_live_hashrate", pending),
                self.assertRaises(pipeline.PipelineUnavailable),
            ):
                await worker._refresh()
            self.assertEqual(len(cancelled), 2)

    async def test_primary_price_and_hashrate_units(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(live_response)) as client:
            price, source = await pipeline.read_live_price(client)
            self.assertEqual(price, 83530.875)
            self.assertEqual(source, pipeline.PRICE_URL)
            self.assertEqual(await pipeline.read_live_hashrate(client), 1e21)

    async def test_price_fallback_on_bad_primary(self):
        for bad in (httpx.Response(429), httpx.Response(200, json={"data": {"base": "BTC", "currency": "EUR", "amount": "100"}})):
            def response(request):
                return bad if str(request.url) == pipeline.PRICE_URL else live_response(request)
            async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
                self.assertEqual(await pipeline.read_live_price(client), (83000, pipeline.PRICE_FALLBACK_URL))

    async def test_old_and_future_fallback_quotes_rejected(self):
        for delta in (-901, 61):
            def response(request):
                if str(request.url) == pipeline.PRICE_URL:
                    return httpx.Response(503)
                return httpx.Response(200, json={"USD": 100000, "time": 2000 + delta})
            async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
                with patch.object(pipeline.time, "time", return_value=2000):
                    with self.assertRaises(pipeline.PipelineUnavailable):
                        await pipeline.read_live_price(client)

    async def test_bad_hashrate_and_oversized_json_rejected(self):
        responses = [httpx.Response(200, json={"currentHashrate": value}) for value in (0, -1, True, "1e21", None)]
        responses += [httpx.Response(200, text="invalid"), httpx.Response(200, json=[]), httpx.Response(200, text="x" * (256 * 1024 + 1))]
        for response in responses:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: response)) as client:
                with self.assertRaises(pipeline.PipelineUnavailable):
                    await pipeline.read_live_hashrate(client)

    async def test_timeout_rejected(self):
        def response(_request):
            raise httpx.ReadTimeout("Timeout")
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            with self.assertRaises(pipeline.PipelineUnavailable):
                await pipeline.read_live_hashrate(client)

    async def test_refreshes_without_readers_and_only_one_worker(self):
        heights = 0
        def response(request):
            nonlocal heights
            if str(request.url) == pipeline.TIP_URL:
                heights += 1
                return httpx.Response(200, text=str(971032 + heights))
            return live_response(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            worker = pipeline.StratigraphyPipeline(client, refresh_interval=0.01)
            try:
                await worker.start()
                first_task = worker._task
                await worker.start()
                self.assertIs(worker._task, first_task)
                async with asyncio.timeout(1):
                    while worker.get_snapshot().block_height <= 971033:
                        await asyncio.sleep(0.002)
                self.assertGreater(worker.get_snapshot().block_height, 971033)
                self.assertEqual(worker.get_snapshot().price_source, pipeline.PRICE_URL)
            finally:
                await worker.stop()
            self.assertTrue(first_task.done())
            self.assertFalse(worker.ready)

    async def test_snapshot_expiry_and_no_network_on_reads(self):
        requests = 0
        def response(request):
            nonlocal requests
            requests += 1
            return live_response(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            worker = pipeline.StratigraphyPipeline(client)
            try:
                await worker.start()
                observed = worker.get_snapshot().observed_at_utc
                for _ in range(10):
                    self.assertEqual(worker.get_snapshot().observed_at_utc, observed)
                self.assertEqual(requests, 3)
                _, updated = worker._published
                with patch.object(pipeline.time, "monotonic", return_value=updated + 91):
                    with self.assertRaises(pipeline.PipelineUnavailable):
                        worker.get_snapshot()
            finally:
                await worker.stop()

    async def test_failed_refresh_discards_previous_snapshot_and_recovers(self):
        failed = False
        def response(request):
            if failed and str(request.url) == pipeline.HASHRATE_URL:
                return httpx.Response(503)
            return live_response(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            worker = pipeline.StratigraphyPipeline(client, refresh_interval=0.01)
            try:
                await worker.start()
                self.assertTrue(worker.ready)
                failed = True
                async with asyncio.timeout(1):
                    while worker.ready:
                        await asyncio.sleep(0.002)
                with self.assertRaises(pipeline.PipelineUnavailable):
                    worker.get_snapshot()
                failed = False
                async with asyncio.timeout(1):
                    while not worker.ready:
                        await asyncio.sleep(0.002)
                self.assertEqual(worker.get_snapshot().block_height, 971032)
            finally:
                await worker.stop()

    async def test_stop_cancels_all_inflight_requests(self):
        entered = asyncio.Event()
        active = 0
        async def response(_request):
            nonlocal active
            active += 1
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                active -= 1
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            worker = pipeline.StratigraphyPipeline(client)
            starter = asyncio.create_task(worker.start())
            async with asyncio.timeout(1):
                await entered.wait()
                await worker.stop()
                await starter
            self.assertEqual(active, 0)
            self.assertFalse(worker.ready)


if __name__ == "__main__":
    unittest.main()
