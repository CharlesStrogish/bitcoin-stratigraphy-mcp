#!/usr/bin/env python3
"""Native LangChain MCP / ReAct quickstart (langchain[mcp]>=1.4).

Install requirements-langchain.txt in a separate consumer Python project.
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

    # MCPAdapter accepts a transport/client, not a headers keyword itself.
    # Inject the COMPLETE paid credential into the underlying HTTP transport.
    # This is L402, NOT Bearer auth. Never put wallet credentials in the prompt.
    headers = {"X-L402-Batch-Size": "100"}
    if credential:
        headers["Authorization"] = credential
    # Alternatively set L402_PROXY_URL=http://127.0.0.1:8000/mcp. That endpoint
    # must be an L402-aware Streamable HTTP MCP proxy, not a generic HTTP proxy.
    # It must handle 402s, enforce your wallet spending budget, request 100-call
    # batches upstream, and attach the right credential for each paid tool.
    # The native adapter itself neither pays invoices nor refreshes L402 passes.
    return args, url, headers


async def main() -> None:
    args, url, headers = configuration()
    from fastmcp.client import Client
    from fastmcp.client.transports import StreamableHttpTransport
    from langchain.mcp import MCPAdapter

    transport = StreamableHttpTransport(url=url, headers=headers)
    # This server uses the initialize-based MCP protocol (legacy here means
    # protocol negotiation, not an obsolete SSE endpoint).
    client = Client(transport, mode="legacy", timeout=30)
    async with MCPAdapter(client) as adapter:
        tools = await adapter.list_tools()
        names = {tool.name for tool in tools}
        if len(tools) != 15 or not DEMO_TOOLS.issubset(names):
            raise RuntimeError("Expected the published 15-tool catalog; publish Phase 1 or check --url")
        print(f"Discovered {len(tools)} canonical MCP tools: {', '.join(sorted(names))}")
        if not args.run:
            print("Discovery only: no LLM requests, paid tool calls, or invoice payments.")
            return

        from langchain.agents import create_agent
        from langchain_openai import ChatOpenAI

        # A Macro-Macaroon is tool-scoped: a proof.notarize pass does NOT unlock
        # the other paid tools. Discovery is public; stratigraphy.list is free.
        # The complete catalog remains available in `tools`, but least privilege
        # exposes only these two capabilities for this demo.
        # Dots are not allowed in OpenAI tool names. Renaming the wrapper leaves
        # the adapter's captured ORIGINAL remote MCP tool name unchanged.
        demo = [tool.model_copy(update={"name": tool.name.replace(".", "_")})
                for tool in tools if tool.name in DEMO_TOOLS]
        # create_agent is LangChain's current ReAct loop: model -> tool ->
        # observation -> model. No deprecated create_react_agent API is needed.
        agent = create_agent(
            model=ChatOpenAI(model=args.model, temperature=0),
            tools=demo,
            system_prompt=(
                "Use proof_notarize once and stratigraphy_list for indexed height discovery. "
                "Only report actual tool results. Calendar acceptance is not Bitcoin confirmation. "
                "The latest indexed stratigraphy height is not the live Bitcoin chain tip. "
                "Stop on payment errors; do not retry or invent a receipt."
            ),
        )
        task = (
            f"Notarize this data hash: {args.hash}, and fetch the latest stratigraphy "
            "block height. Return the original hash, detached .ots receipt hex, "
            "receipt status, and the latest indexed height from the catalog."
        )
        result = await asyncio.wait_for(
            agent.ainvoke({"messages": [{"role": "user", "content": task}]},
                          config={"recursion_limit": 12}),
            timeout=90,
        )
        print(result["messages"][-1].content)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # HTTP exceptions can include credential-bearing request objects.
        # Do not dump them or enable HTTP debug logging in this quickstart.
        print(f"Quickstart failed ({type(error).__name__}). Check framework dependencies, "
              "the published 15-tool endpoint, and your L402 pass/proxy. "
              "A 402 requires an explicitly funded or renewed tool-scoped pass.",
              file=sys.stderr)
        raise SystemExit(1) from None