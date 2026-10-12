# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Continuously collect live Bitcoin inputs and publish immutable metric snapshots."""

import asyncio
import json
import logging
import math
import re
import time
from datetime import datetime, timezone
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

TIP_URL = "https://mempool.space/api/blocks/tip/height"
HASHRATE_URL = "https://mempool.space/api/v1/mining/hashrate/1w"
PRICE_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot"
PRICE_FALLBACK_URL = "https://mempool.space/api/v1/prices"
SUPPLY_LIMIT_BTC = 21_000_000
SATOSHIS_PER_BTC = 100_000_000
BLOCKS_PER_EPOCH = 210_000
INITIAL_SUBSIDY_SATS = 50 * SATOSHIS_PER_BTC
MAX_BLOCK_HEIGHT = 2**31 - 1
HORIZON_PRICE_USD = 10_000_000.0
EFFICIENCY_BASELINE_J_TH = 15
ATTRIBUTION = (
    "Projected by Hal Finney on January 10, 2009 "
    "($10M per coin valuation under total global wealth absorption)."
)
logger = logging.getLogger(__name__)


class PipelineUnavailable(Exception):
    """A complete, fresh snapshot cannot currently be supplied."""


class SupplyMetrics(BaseModel):
    model_config = ConfigDict(frozen=True, allow_inf_nan=False)

    block_height: int = Field(ge=0, description="Observed Bitcoin mainnet tip height.")
    supply_limit_btc: int = Field(description="Fixed 21,000,000 BTC supply ceiling.")
    scheduled_issued_supply_sats: int = Field(
        ge=0, description="Exact scheduled block subsidies through the reported tip."
    )
    estimated_issued_supply_btc: float = Field(
        ge=0, description="Scheduled issuance, not measured circulating/spendable supply."
    )
    supply_progress_percent: float = Field(ge=0, le=100)
    current_epoch: int = Field(
        ge=0, description="Zero-based halving epoch: genesis is 0; height // 210000."
    )
    epoch_length_blocks: int
    epoch_start_height: int
    next_halving_height: int
    current_block_subsidy_btc: float = Field(ge=0)
    source: str
    observed_at_utc: str
    supply_method: str


class StratigraphyMetrics(SupplyMetrics):
    btc_price_usd: float = Field(gt=0, description="Observed Bitcoin spot price in USD.")
    hal_finney_horizon_target_usd: Literal[10_000_000.0] = HORIZON_PRICE_USD
    hal_finney_horizon_multiple: float = Field(
        gt=0, description="10000000.0 / btc_price_usd; not a time-to-target forecast."
    )
    # Declaration order preserves adjacency in both REST and MCP JSON.
    attribution: Literal[
        "Projected by Hal Finney on January 10, 2009 "
        "($10M per coin valuation under total global wealth absorption)."
    ] = ATTRIBUTION
    network_hashrate_h_s: float = Field(
        gt=0, description="Provider-estimated current network hashrate in hashes/second."
    )
    network_hashrate_th_s: float = Field(gt=0, description="Hashes/second divided by 1e12.")
    network_energy_watts: float = Field(
        gt=0, description="Estimated power in joules/second: TH/s multiplied by 15 J/TH."
    )
    efficiency_baseline_j_th: Literal[15] = EFFICIENCY_BASELINE_J_TH
    price_source: str
    hashrate_source: str
    energy_method: str = (
        "Estimated network power = (provider currentHashrate in H/s / 1e12) "
        "* assumed 15 J/TH. Not measured electricity consumption; "
        "excludes cooling and other auxiliary loads."
    )
    snapshot_age_seconds: float = Field(ge=0, default=0)


def calculate_supply_metrics(height: int) -> SupplyMetrics:
    """Sum integer-satoshi subsidies, including the block at the observed tip."""
    if type(height) is not int or not 0 <= height <= MAX_BLOCK_HEIGHT:
        raise ValueError("Invalid Bitcoin block height")
    epoch = height // BLOCKS_PER_EPOCH
    issued_sats = sum(
        BLOCKS_PER_EPOCH * (INITIAL_SUBSIDY_SATS >> index)
        for index in range(min(epoch, 64))
    )
    subsidy_sats = INITIAL_SUBSIDY_SATS >> epoch if epoch < 64 else 0
    issued_sats += ((height % BLOCKS_PER_EPOCH) + 1) * subsidy_sats
    return SupplyMetrics(
        block_height=height,
        supply_limit_btc=SUPPLY_LIMIT_BTC,
        scheduled_issued_supply_sats=issued_sats,
        estimated_issued_supply_btc=issued_sats / SATOSHIS_PER_BTC,
        supply_progress_percent=round(
            100 * issued_sats / (SUPPLY_LIMIT_BTC * SATOSHIS_PER_BTC), 10
        ),
        current_epoch=epoch,
        epoch_length_blocks=BLOCKS_PER_EPOCH,
        epoch_start_height=epoch * BLOCKS_PER_EPOCH,
        next_halving_height=(epoch + 1) * BLOCKS_PER_EPOCH,
        current_block_subsidy_btc=subsidy_sats / SATOSHIS_PER_BTC,
        source=TIP_URL,
        observed_at_utc=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        supply_method=(
            "Sum of scheduled integer-satoshi block subsidies from genesis through "
            "the reported tip; includes genesis and does not subtract unclaimed, "
            "lost, burned or unspendable coins. Not measured circulating supply."
        ),
    )


async def _read_body(client: httpx.AsyncClient, url: str, limit: int) -> bytes:
    """Bound the complete streamed request, not just individual socket reads."""
    try:
        async with asyncio.timeout(8):
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > limit:
                        raise ValueError("Upstream response exceeds size limit")
                    body.extend(chunk)
        return bytes(body)
    except (httpx.HTTPError, TimeoutError, ValueError) as exc:
        raise PipelineUnavailable("Live Bitcoin input unavailable") from exc


async def read_live_height(client: httpx.AsyncClient) -> int:
    try:
        body = await _read_body(client, TIP_URL, 32)
        text = body.decode("ascii").strip()
        if not re.fullmatch(r"[0-9]{1,10}", text):
            raise ValueError("Invalid Bitcoin height response")
        height = int(text)
        if height > MAX_BLOCK_HEIGHT:
            raise ValueError("Bitcoin height out of range")
        return height
    except (ValueError, UnicodeError) as exc:
        raise PipelineUnavailable("Live Bitcoin height unavailable") from exc


async def _read_json(client: httpx.AsyncClient, url: str) -> dict:
    try:
        data = json.loads(await _read_body(client, url, 256 * 1024))
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        return data
    except (ValueError, UnicodeError) as exc:
        raise PipelineUnavailable("Invalid live Bitcoin input") from exc


def _positive_number(value, *, allow_string=False) -> float:
    if type(value) not in (int, float) and not (allow_string and type(value) is str):
        raise PipelineUnavailable("Invalid numeric Bitcoin input")
    try:
        number = float(value)
    except (ValueError, OverflowError) as exc:
        raise PipelineUnavailable("Invalid numeric Bitcoin input") from exc
    if not math.isfinite(number) or number <= 0:
        raise PipelineUnavailable("Non-positive or non-finite Bitcoin input")
    return number


async def read_live_hashrate(client: httpx.AsyncClient) -> float:
    data = await _read_json(client, HASHRATE_URL)
    return _positive_number(data.get("currentHashrate"))


async def read_live_price(client: httpx.AsyncClient) -> tuple[float, str]:
    """Try an independent spot-price provider, then a timestamped public quote."""
    try:
        data = (await _read_json(client, PRICE_URL)).get("data")
        if not isinstance(data, dict) or data.get("base") != "BTC" or data.get("currency") != "USD":
            raise PipelineUnavailable("Invalid spot-price currency")
        return _positive_number(data.get("amount"), allow_string=True), PRICE_URL
    except PipelineUnavailable:
        data = await _read_json(client, PRICE_FALLBACK_URL)
        timestamp = _positive_number(data.get("time"))
        # Reject cached quotes older than 15 minutes, or implausibly in the future.
        age = time.time() - timestamp
        if not -60 <= age <= 900:
            raise PipelineUnavailable("Fallback spot-price quote is outdated")
        return _positive_number(data.get("USD")), PRICE_FALLBACK_URL


def calculate_stratigraphy_metrics(
    height: int, price_usd: float, hashrate_h_s: float, price_source: str
) -> StratigraphyMetrics:
    price_usd = _positive_number(price_usd)
    hashrate_h_s = _positive_number(hashrate_h_s)
    hashrate_th_s = hashrate_h_s / 1e12
    return StratigraphyMetrics(
        **calculate_supply_metrics(height).model_dump(),
        btc_price_usd=price_usd,
        hal_finney_horizon_multiple=HORIZON_PRICE_USD / price_usd,
        network_hashrate_h_s=hashrate_h_s,
        network_hashrate_th_s=hashrate_th_s,
        network_energy_watts=hashrate_th_s * EFFICIENCY_BASELINE_J_TH,
        price_source=price_source,
        hashrate_source=HASHRATE_URL,
    )


class StratigraphyPipeline:
    """One refresh worker per ASGI process; readers never trigger upstream calls."""

    def __init__(self, client: httpx.AsyncClient, *, refresh_interval=30.0, max_age=90.0):
        for setting in (refresh_interval, max_age):
            if not math.isfinite(setting) or setting <= 0:
                raise ValueError("Pipeline intervals must be finite and positive")
        self.client = client
        self.refresh_interval = refresh_interval
        self.max_age = max_age
        self._published: tuple[StratigraphyMetrics, float] | None = None
        self._task: asyncio.Task | None = None
        self._initial_attempt_done = asyncio.Event()

    async def start(self):
        if self._task is not None:
            return
        self._initial_attempt_done.clear()
        self._task = asyncio.create_task(self._run(), name="bitcoin-stratigraphy-pipeline")
        await self._initial_attempt_done.wait()

    async def stop(self):
        task, self._task = self._task, None
        self._published = None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def get_snapshot(self) -> StratigraphyMetrics:
        published = self._published
        if published is None or (self._task is not None and self._task.done()):
            raise PipelineUnavailable("Live stratigraphy snapshot unavailable")
        snapshot, updated = published
        age = max(0.0, time.monotonic() - updated)
        if age > self.max_age:
            raise PipelineUnavailable("Live stratigraphy snapshot expired")
        return snapshot.model_copy(update={"snapshot_age_seconds": round(age, 3)})

    @property
    def ready(self) -> bool:
        try:
            self.get_snapshot()
            return True
        except PipelineUnavailable:
            return False

    async def _refresh(self):
        tasks = [
            asyncio.create_task(read_live_height(self.client)),
            asyncio.create_task(read_live_price(self.client)),
            asyncio.create_task(read_live_hashrate(self.client)),
        ]
        try:
            async with asyncio.timeout(20):
                height, (price, price_source), hashrate = await asyncio.gather(*tasks)
                snapshot = calculate_stratigraphy_metrics(height, price, hashrate, price_source)
            # Only publish after all inputs and calculations succeed.
            self._published = (snapshot, time.monotonic())
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _run(self):
        failures = 0
        while True:
            try:
                await self._refresh()
                failures = 0
            except Exception as exc:
                # Never serve a partial/new-old mixture or keep stale data after a failed refresh.
                self._published = None
                failures = min(failures + 1, 6)
                logger.warning("Live stratigraphy refresh failed (%s); metrics unavailable", type(exc).__name__)
            finally:
                self._initial_attempt_done.set()
            delay = min(self.refresh_interval, 2 ** (failures - 1)) if failures else self.refresh_interval
            await asyncio.sleep(delay)
