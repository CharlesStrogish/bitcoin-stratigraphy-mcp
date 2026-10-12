# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""License-gated live Bitcoin metrics and historical provenance MCP server."""

import os
import ssl
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import RedirectResponse
from fastapi_mcp import FastApiMCP

from main import require_enterprise_license
from provenance_anchor import ARCHIVE_DIRECTORY, ProvenanceAnchor
from provenance_routes import register_provenance_routes
from provenance_storage import ObjectArchive
from provenance_upgrade import ProvenanceUpgrader
from stratigraphy_bridge import register_stratigraphy_bridge
from stratigraphy_pipeline import (
    MAX_BLOCK_HEIGHT as MAX_BLOCK_HEIGHT,
    TIP_URL as TIP_URL,
    PipelineUnavailable,
    StratigraphyMetrics,
    StratigraphyPipeline,
    calculate_supply_metrics as calculate_supply_metrics,
    read_live_height as read_pipeline_height,
)


API_PREFIX = "/agent-api"
TIP_URL = "https://mempool.space/api/blocks/tip/height"


async def read_live_height(client: httpx.AsyncClient) -> int:
    """Compatibility helper; the endpoint itself now reads the continuous pipeline."""
    try:
        return await read_pipeline_height(client)
    except PipelineUnavailable as exc:
        raise HTTPException(
            status_code=502,
            detail="Live Bitcoin height is unavailable. No placeholder data returned.",
        ) from exc


def create_app(*, proof_directory=ARCHIVE_DIRECTORY, proof_storage=None) -> FastAPI:
    # Runs during `uvicorn agent_api:app` import, before an API can be constructed.
    require_enterprise_license()
    storage = proof_storage if proof_storage is not None else ObjectArchive()

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
                pipeline = StratigraphyPipeline(bitcoin_client)
                application.state.stratigraphy_pipeline = pipeline
                anchor = ProvenanceAnchor(pipeline, bitcoin_client, directory=proof_directory, storage=storage)
                application.state.provenance_anchor = anchor
                upgrader = ProvenanceUpgrader(storage)
                application.state.provenance_upgrader = upgrader
                try:
                    await pipeline.start()
                    await anchor.start()
                    await upgrader.start()
                    yield
                finally:
                    await upgrader.stop()
                    await anchor.stop()
                    await pipeline.stop()
        finally:
            await tool_client.aclose()

    application = FastAPI(
        title="Bitcoin Stratigraphy Enterprise Agent API",
        description="Continuous live Bitcoin supply, estimated energy and Hal Finney horizon metrics.",
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
        return {
            "status": "ok",
            "service": "enterprise-agent-api",
            "pipeline_ready": application.state.stratigraphy_pipeline.ready,
        }

    @application.get(
        f"{API_PREFIX}/supply-metrics",
        operation_id="get_supply_metrics",
        response_model=StratigraphyMetrics,
        summary="Get live Bitcoin supply, thermodynamics and Hal Finney horizon metrics",
        description=(
            "Read the continuous pipeline's latest complete snapshot: mainnet supply "
            "and halving epoch, live USD price, $10M/price Hal Finney horizon multiple "
            "with historical attribution, and estimated power at 15 J/TH. "
            "Returns HTTP 503 when the pipeline is unavailable or its snapshot expires."
        ),
    )
    async def get_supply_metrics() -> StratigraphyMetrics:
        try:
            return application.state.stratigraphy_pipeline.get_snapshot()
        except PipelineUnavailable as exc:
            raise HTTPException(
                status_code=503,
                detail="Live stratigraphy pipeline unavailable. No placeholder or stale data returned.",
            ) from exc

    register_provenance_routes(application, storage, API_PREFIX)
    register_stratigraphy_bridge(application, storage, API_PREFIX)

    mcp = FastApiMCP(
        application,
        name="Bitcoin Stratigraphy Enterprise Supply",
        include_operations=["get_supply_metrics", "get_historical_proof"],
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
