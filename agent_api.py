# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""License-gated live Bitcoin metrics and historical provenance MCP server."""

import asyncio
import concurrent.futures
import logging
import os
import ssl
import threading
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse

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
MCP_OPERATIONS = ["get_supply_metrics", "get_historical_proof"]
# Background OpenTimestamps work (resuming unstamped days, upgrading receipts)
# waits until a freshly booted server has settled; none of it is urgent.
OTS_STARTUP_DELAY_SECONDS = 300.0
# The MCP server is built shortly after startup, staggered from the first refresh.
MCP_WARM_UP_DELAY_SECONDS = 2.0
logger = logging.getLogger(__name__)


async def read_live_height(client: httpx.AsyncClient) -> int:
    """Compatibility helper; the endpoint itself now reads the continuous pipeline."""
    try:
        return await read_pipeline_height(client)
    except PipelineUnavailable as exc:
        raise HTTPException(
            status_code=502,
            detail="Live Bitcoin height is unavailable. No placeholder data returned.",
        ) from exc


class LazyMcpServer:
    """Builds the MCP server at most once, in a daemon thread, when first needed.

    fastapi_mcp and the MCP SDK add about 190 modules, so they are kept off the
    startup path: the lifespan starts the build once the app is serving, and
    an MCP request that arrives before it finishes waits for it.
    """

    def __init__(self, build):
        self._build = build
        self._lock = threading.Lock()
        self._future: concurrent.futures.Future | None = None

    def start(self) -> concurrent.futures.Future:
        with self._lock:
            if self._future is None:
                future = concurrent.futures.Future()
                # A running future cannot be cancelled by a disconnecting request.
                future.set_running_or_notify_cancel()
                self._future = future
                threading.Thread(
                    target=self._run, args=(future,), name="agent-api-mcp", daemon=True,
                ).start()
            return self._future

    def _run(self, future: concurrent.futures.Future):
        try:
            result = self._build()
        except BaseException as exc:
            logger.exception("Enterprise Agent API MCP server could not be built")
            future.set_exception(exc)
        else:
            future.set_result(result)

    async def get(self):
        """Return ``(FastApiMCP, FastApiHttpSessionManager)``, building them if needed."""
        future = self.start()
        if future.done():
            return future.result()
        return await asyncio.wrap_future(future)

    async def shutdown(self):
        """Stop the MCP HTTP session manager, if the server has been built."""
        future = self._future
        if future is not None and future.done() and future.exception() is None:
            await future.result()[1].shutdown()


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
                trust_env=False,
            ) as bitcoin_client:
                pipeline = StratigraphyPipeline(bitcoin_client)
                application.state.stratigraphy_pipeline = pipeline
                anchor = ProvenanceAnchor(
                    pipeline, bitcoin_client, directory=proof_directory, storage=storage,
                    start_delay=OTS_STARTUP_DELAY_SECONDS,
                )
                application.state.provenance_anchor = anchor
                upgrader = ProvenanceUpgrader(storage, start_delay=OTS_STARTUP_DELAY_SECONDS)
                application.state.provenance_upgrader = upgrader
                try:
                    # Serve immediately; the first live refresh runs in the
                    # background and live reads wait for it (bounded).
                    await pipeline.start(wait=False)
                    await anchor.start()
                    await upgrader.start()
                    warm_up = asyncio.get_running_loop().call_later(MCP_WARM_UP_DELAY_SECONDS, mcp_server.start)
                    try:
                        yield
                    finally:
                        warm_up.cancel()
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
        pipeline = application.state.stratigraphy_pipeline
        await pipeline.wait_for_first_refresh()
        try:
            return pipeline.get_snapshot()
        except PipelineUnavailable as exc:
            raise HTTPException(
                status_code=503,
                detail="Live stratigraphy pipeline unavailable. No placeholder or stale data returned.",
            ) from exc

    register_provenance_routes(application, storage, API_PREFIX)
    register_stratigraphy_bridge(application, storage, API_PREFIX)

    def build_mcp_server():
        from fastapi_mcp import FastApiMCP
        from fastapi_mcp.transport.http import FastApiHttpSessionManager

        mcp = FastApiMCP(
            application,
            name="Bitcoin Stratigraphy Enterprise Supply",
            include_operations=MCP_OPERATIONS,
            describe_full_response_schema=True,
            http_client=tool_client,
        )
        return mcp, FastApiHttpSessionManager(mcp_server=mcp.server)

    mcp_server = LazyMcpServer(build_mcp_server)
    application.state.mcp = mcp_server

    # The same endpoint that FastApiMCP.mount_http() registers, but resolving
    # the server only when an MCP request needs it.
    @application.api_route(
        f"{API_PREFIX}/mcp",
        methods=["GET", "POST", "DELETE"],
        include_in_schema=False,
        operation_id="mcp_http",
    )
    async def handle_mcp_streamable_http(request: Request):
        try:
            _, transport = await mcp_server.get()
        except Exception as exc:
            raise HTTPException(status_code=503, detail="MCP server unavailable") from exc
        return await transport.handle_fastapi_request(request)

    return application


# A direct ASGI launch cannot bypass the same Ed25519 startup gate.
app = create_app()


def run_server():
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), ws="none")


if __name__ == "__main__":
    run_server()
