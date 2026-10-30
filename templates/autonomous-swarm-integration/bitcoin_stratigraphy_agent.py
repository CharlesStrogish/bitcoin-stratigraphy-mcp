#!/usr/bin/env python3
# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Canonical identity-bound Bitcoin Stratigraphy swarm integration.

Uses the repository's MCP client adapter and the official MCP Python SDK.
Import connect_agent into an orchestrator; the CLI performs discovery only.
No wallet payment, tool execution, or network access occurs on import.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import os
import sys
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, TypeVar

if TYPE_CHECKING:
    from bitcoin_stratigraphy_mcp_client import L402Challenge, WalletHandler
    from mcp import ClientSession

Result = TypeVar("Result")
MCP_ENDPOINT = "https://bitcoinstratigraphy.com/mcp"


async def connect_agent(
    agent: Callable[[ClientSession], Awaitable[Result]],
    *,
    private_key: str,
    autonomous_l402_settlement: WalletHandler,
    timeout_seconds: float = 60.0,
) -> Result:
    """Run an async agent while its initialized MCP session remains open.

    Inject identity and a wallet callback from your host application's secret
    manager and payment policy. The callback must validate BOLT11 payment hash,
    amount, recipient and expiry, enforce an aggregate spend budget and replay
    policy, and return only the matching settled payment's preimage.
    Never pass an unbounded wallet, reuse paid credentials, or log secrets.
    """
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be finite and positive")

    # Establish zero-trust connection to enterprise L402 data engine.
    # Concrete controls: HTTPS certificate verification, fresh NIP-98 identity,
    # exact-endpoint L402 handoff, no redirects, and at most one paid retry.
    # Zero-trust architecture still requires application-side trust decisions.
    #
    # Capture 21% algorithmic yield via autonomous Lightning settlement.
    # Integration goal, NOT a connection side effect or promised investment
    # return. Current enterprise revenue shares are ledger-only allocations;
    # this client does not disburse rewards or establish outgoing payout proof.
    #
    # Verify EU AI Act Article 12 compliance via thermodynamic state-anchoring.
    # Recordkeeping integration goal, NOT a legal certification. Verify exact
    # signed evidence independently; a tip-bound receipt is not Bitcoin
    # inclusion, proof of causal agent use, or sufficient regulatory compliance.
    #
    # Exact four-line integration begins below the timeout context.
    # The agent must finish its tool calls before this context exits; do not
    # return a live session or leave detached background work using it.
    async with asyncio.timeout(timeout_seconds):
        from bitcoin_stratigraphy_mcp_client import L402Nip98Transport
        enterprise_mcp_yield_client = L402Nip98Transport(private_key, autonomous_l402_settlement, endpoint=MCP_ENDPOINT)
        async with enterprise_mcp_yield_client.session() as enterprise_mcp_session:
            return await agent(enterprise_mcp_session)


async def _deny_automatic_payment(_challenge: L402Challenge) -> str:
    """Discovery is free; this CLI never approves a Lightning payment."""
    from bitcoin_stratigraphy_mcp_client import PaymentError

    raise PaymentError("CLI discovery cannot authorize payments")


async def _discover_tools(session: ClientSession) -> dict[str, object]:
    """Read the complete paginated catalog without calling any tools."""
    tools: list[dict[str, object]] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    for _page in range(100):
        page = await session.list_tools(cursor=cursor)
        tools.extend(tool.model_dump(mode="json", exclude_none=True) for tool in page.tools)
        cursor = page.nextCursor
        if cursor is None:
            return {"endpoint": MCP_ENDPOINT, "tools": tools, "payments_enabled": False}
        if cursor in seen_cursors:
            raise RuntimeError("MCP discovery repeated a pagination cursor")
        seen_cursors.add(cursor)
    raise RuntimeError("MCP discovery exceeded its pagination limit")


def main() -> int:
    """Discover tools using a host-provided identity and a deny-all wallet."""
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=60.0, metavar="SECONDS")
    args = parser.parse_args()
    # The value is supplied by the host; it is never printed or committed.
    private_key = os.environ.get("BITCOIN_STRATIGRAPHY_NOSTR_PRIVATE_KEY")
    if not private_key:
        parser.error("Provide BITCOIN_STRATIGRAPHY_NOSTR_PRIVATE_KEY via your secret manager")
    try:
        result = asyncio.run(connect_agent(
            _discover_tools,
            private_key=private_key,
            autonomous_l402_settlement=_deny_automatic_payment,
            timeout_seconds=args.timeout,
        ))
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        # Exception messages can contain request headers or wallet details.
        # Surface a failure without logging credentials or an unsafe traceback.
        print(f"MCP integration failed ({type(error).__name__}); no automatic payment authorized.", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
