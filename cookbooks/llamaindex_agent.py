#!/usr/bin/env python3
"""Native LlamaIndex MCP / ReAct quickstart.

Installation is temporarily unavailable: LlamaIndex requires vulnerable NLTK.
This source is preserved for a future safe release; use langchain_agent.py now.
Default execution only discovers tools; --run opts into LLM and paid tool calls.
See README.md for obtaining a tool-scoped 100-call Macro-Macaroon.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import re
import sys
from urllib.parse import urlsplit

MCP_URL = "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"
DEMO_TOOLS = {"proof.notarize", "stratigraphy.list"}
SAMPLE_HASH = hashlib.sha256(b"Bitcoin Stratigraphy framework quickstart").hexdigest()


def configuration() -> tuple[argparse.Namespace, str, dict[str, str]]:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.getenv("STRATIGRAPHY_MCP_URL", MCP_URL))
    parser.add_argument("--proxy-url", default=os.getenv("L402_PROXY_URL"))
    parser.add_argument("--hash", default=SAMPLE_HASH, help="Exactly 64 SHA-256 hex characters")
    parser.add_argument("--model", default="gpt-4.1-mini")
    parser.add_argument("--run", action="store_true", help="Opt into LLM and paid notarization calls")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", args.hash):
        parser.error("--hash must be exactly 64 hexadecimal characters")
    args.hash = args.hash.lower()
    url = args.proxy_url or args.url
    parsed = urlsplit(url)
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or
            parsed.fragment or parsed.scheme not in {"http", "https"} or
            (parsed.scheme == "http" and not loopback)):
        parser.error("Use HTTPS, or loopback HTTP; do not put credentials in URLs")
    if args.proxy_url and not loopback:
        parser.error("--proxy-url must point to your trusted local L402 wallet proxy")
    credential = os.getenv("L402_AUTHORIZATION", "").strip()
    if credential and not re.fullmatch(r"L402 [^:\s]+:[^:\s]+", credential):
        parser.error("L402_AUTHORIZATION must contain L402 <macaroon>:<preimage>")
    if args.proxy_url and credential:
        parser.error("Choose a wallet proxy OR direct L402 credentials, not both")
    if args.run and not (credential or args.proxy_url):
        parser.error("--run requires a prepaid proof.notarize credential or a wallet proxy")
    if args.run and not os.getenv("OPENAI_API_KEY"):
        parser.error("--run requires OPENAI_API_KEY in your consumer project's secrets")

    # Inject the COMPLETE paid L402 <macaroon>:<preimage> value via the client's
    # HTTP headers. Do not use Bearer auth or expose this value to the LLM.
    # A proof.notarize 100-call Macro-Macaroon costs 25000 sats at 250 sats/call
    # and remains bound to that tool, expiry and inherited request limits.
    headers = {"X-L402-Batch-Size": "100"}
    if credential:
        headers["Authorization"] = credential
    # Alternatively point BasicMCPClient at a trusted local L402 wallet proxy:
    # L402_PROXY_URL=http://127.0.0.1:8000/mcp. This must expose Streamable HTTP
    # MCP and handle upstream 402s with explicit spending limits and the correct
    # per-tool credentials. It is not a generic HTTP/SSE proxy. The native client
    # does not purchase, renew, or automatically pay for Macro-Macaroons.
    return args, url, headers


async def main() -> None:
    args, url, headers = configuration()
    from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

    client = BasicMCPClient(url, headers=headers, timeout=30, sse_read_timeout=60)
    try:
        # Public catalog discovery; no paid tools execute at this stage.
        spec = McpToolSpec(client=client)
        tools = await spec.to_tool_list_async()
        names = {tool.metadata.name for tool in tools}
        if len(tools) != 15 or not DEMO_TOOLS.issubset(names):
            raise RuntimeError("Expected the published 15-tool catalog; publish Phase 1 or check --url")
        print(f"Discovered {len(tools)} canonical MCP tools: {', '.join(sorted(names))}")
        if not args.run:
            print("Discovery only: no LLM requests, paid tool calls, or invoice payments.")
            return

        from llama_index.core.agent.workflow import ReActAgent
        from llama_index.llms.openai import OpenAI

        # A single notarization credential cannot unlock every paid capability.
        # Keep all 15 discovered tools in `tools`, but expose only these two for
        # the demo: proof.notarize (paid) and stratigraphy.list (free).
        demo = [tool for tool in tools if tool.metadata.name in DEMO_TOOLS]
        for tool in demo:
            # Provider-safe names; McpToolSpec's function closure still calls
            # the original dotted MCP name, preserving the paid token scope.
            tool.metadata.name = tool.metadata.name.replace(".", "_")
        agent = ReActAgent(
            tools=demo,
            llm=OpenAI(model=args.model, temperature=0),
            system_prompt=(
                "Use proof_notarize once and stratigraphy_list for indexed height discovery. "
                "Only report actual tool results. Calendar acceptance is not Bitcoin confirmation. "
                "The latest indexed stratigraphy height is not the live Bitcoin chain tip. "
                "Stop on payment errors; do not retry or invent a receipt."
            ),
            timeout=90,
        )
        task = (
            f"Notarize this data hash: {args.hash}, and fetch the latest stratigraphy "
            "block height. Return the original hash, detached .ots receipt hex, "
            "receipt status, and the latest indexed height from the catalog."
        )
        response = await asyncio.wait_for(agent.run(user_msg=task), timeout=90)
        print(str(response))
    finally:
        # BasicMCPClient owns an HTTP client even between its short MCP sessions.
        await client.http_client.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # Avoid dumping HTTP exceptions that can contain paid credentials.
        print(f"Quickstart failed ({type(error).__name__}). Check framework dependencies, "
              "the published 15-tool endpoint, and your L402 pass/proxy. "
              "A 402 requires an explicitly funded or renewed tool-scoped pass.",
              file=sys.stderr)
        raise SystemExit(1) from None