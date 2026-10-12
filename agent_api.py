# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""License-gated Bitcoin supply API and its separate, single-tool MCP server."""

import asyncio
import os
import re
import ssl
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import RedirectResponse
from fastapi_mcp import FastApiMCP
from pydantic import BaseModel, Field

from main import require_enterprise_license


API_PREFIX = "/agent-api"
TIP_URL = "https://mempool.space/api/blocks/tip/height"
SUPPLY_LIMIT_BTC = 21_000_000
SATOSHIS_PER_BTC = 100_000_000
BLOCKS_PER_EPOCH = 210_000
INITIAL_SUBSIDY_SATS = 50 * SATOSHIS_PER_BTC
MAX_BLOCK_HEIGHT = 2**31 - 1


class SupplyMetrics(BaseModel):
    block_height: int = Field(ge=0, description="Live Bitcoin mainnet tip height.")
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


async def read_live_height(client: httpx.AsyncClient) -> int:
    """Bound the complete upstream operation and reject malformed responses."""
    try:
        async with asyncio.timeout(8):
            async with client.stream("GET", TIP_URL) as response:
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 32:
                        raise ValueError("Oversized Bitcoin height response")
        text = body.decode("ascii").strip()
        if not re.fullmatch(r"[0-9]{1,10}", text):
            raise ValueError("Invalid Bitcoin height response")
        height = int(text)
        if height > MAX_BLOCK_HEIGHT:
            raise ValueError("Bitcoin height out of range")
        return height
    except (httpx.HTTPError, TimeoutError, ValueError, UnicodeError) as exc:
        raise HTTPException(
            status_code=502,
            detail="Live Bitcoin height is unavailable. No placeholder data returned.",
        ) from exc


def create_app() -> FastAPI:
    # Runs during `uvicorn agent_api:app` import, before an API can be constructed.
    require_enterprise_license()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        # Recheck if a license changes/expires between ASGI import and startup.
        try:
            require_enterprise_license()
            async with httpx.AsyncClient(
                timeout=8,
                verify=ssl.create_default_context(),
                follow_redirects=False,
            ) as bitcoin_client:
                application.state.bitcoin_client = bitcoin_client
                yield
        finally:
            await tool_client.aclose()

    application = FastAPI(
        title="Bitcoin Stratigraphy Enterprise Agent API",
        description="Live Bitcoin supply metrics with an independent MCP interface.",
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs",
        openapi_url=f"{API_PREFIX}/openapi.json",
        redoc_url=None,
    )
    # Own the in-process MCP HTTP client so it can be closed on shutdown.
    tool_client = httpx.AsyncClient(
        base_url="http://agent-api",
        timeout=10,
        transport=httpx.ASGITransport(app=application, raise_app_exceptions=False),
    )

    @application.get(API_PREFIX, include_in_schema=False)
    async def index():
        return RedirectResponse(f"{API_PREFIX}/docs")

    @application.get(f"{API_PREFIX}/health", include_in_schema=False)
    async def health():
        return {"status": "ok", "service": "enterprise-agent-api"}

    @application.get(
        f"{API_PREFIX}/supply-metrics",
        operation_id="get_supply_metrics",
        response_model=SupplyMetrics,
        summary="Get live Bitcoin supply and halving-epoch metrics",
        description=(
            "Fetch the current mainnet height and compute scheduled issuance "
            "against the 21,000,000 BTC limit and the zero-based halving epoch. "
            "Returns an explicit upstream error instead of stale or invented data."
        ),
    )
    async def get_supply_metrics() -> SupplyMetrics:
        height = await read_live_height(application.state.bitcoin_client)
        return calculate_supply_metrics(height)

    mcp = FastApiMCP(
        application,
        name="Bitcoin Stratigraphy Enterprise Supply",
        include_operations=["get_supply_metrics"],
        describe_full_response_schema=True,
        http_client=tool_client,
    )
    mcp.mount_http(mount_path=f"{API_PREFIX}/mcp")
    application.state.mcp = mcp
    return application


# A direct ASGI launch cannot bypass the same Ed25519 startup gate.
app = create_app()


def run_server():
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))


if __name__ == "__main__":
    run_server()
