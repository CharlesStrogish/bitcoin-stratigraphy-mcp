#!/usr/bin/env python3
# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Discover the Stratigraphy MCP catalog, optionally running a LangGraph agent.

Requires the project-provided ``l402_client.py`` and, for discovery:
``langchain-mcp-adapters==0.3.2``. Agent mode additionally needs
``langgraph==1.2.12`` and ``langchain-openai``.

Catalog discovery is model-free and never calls a paid tool. Agent mode requires
both an OpenAI API key and an explicit wallet payment hook before paid tools are
made available to the model.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

try:
    from .l402_client import (
        CANONICAL_TOOLS,
        MCP_URL,
        add_cli_arguments,
        async_httpx_factory,
        error_detail,
        load_payment_hook,
    )
except ImportError:
    # Support direct execution as ``python cookbooks/langchain_example.py``.
    from l402_client import (  # type: ignore[no-redef]
        CANONICAL_TOOLS,
        MCP_URL,
        add_cli_arguments,
        async_httpx_factory,
        error_detail,
        load_payment_hook,
    )


EXPECTED_NAMESPACES = frozenset({"stratigraphy", "proof", "mesh", "payment", "workflow"})
REQUIRED_CANONICAL_TOOLS = frozenset({"stratigraphy.get", "proof.verify"})
AGENT_TIMEOUT_SECONDS = 55.0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Discover the live 16-tool MCP catalog without a model, or run an "
            "optional payment-enabled LangGraph agent."
        )
    )
    add_cli_arguments(parser)
    parser.add_argument(
        "--run",
        action="store_true",
        help="Run a ChatOpenAI/LangGraph agent over all 15 discovered tools.",
    )
    parser.add_argument(
        "--payment-info",
        action="store_true",
        help=(
            "Also call payment.get_info(action='query'). It is an L402-paid "
            "tool, so configure --pay-hook and spending limits first."
        ),
    )
    args = parser.parse_args()
    if not getattr(args, "url", None):
        args.url = MCP_URL
    if not isinstance(args.timeout, (int, float)) or args.timeout <= 0:
        parser.error("--timeout must be a positive number")
    if not isinstance(args.max_sats, int) or args.max_sats <= 0:
        parser.error("--max-sats must be a positive integer")
    if not isinstance(args.budget_sats, int) or args.budget_sats <= 0:
        parser.error("--budget-sats must be a positive integer")
    return args


def _validate_catalog(tools: list[Any]) -> dict[str, Any]:
    """Validate names and namespaces before displaying or exposing tools."""
    if len(CANONICAL_TOOLS) != 16:
        raise RuntimeError(
            "l402_client.CANONICAL_TOOLS must contain exactly 16 canonical names"
        )
    if not REQUIRED_CANONICAL_TOOLS.issubset(CANONICAL_TOOLS):
        raise RuntimeError(
            "l402_client.CANONICAL_TOOLS is missing a required canonical tool "
            "(stratigraphy.get or proof.verify)"
        )

    names = [tool.name for tool in tools]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    actual = set(names)
    expected = set(CANONICAL_TOOLS)
    unknown = sorted(actual - expected)
    missing = sorted(expected - actual)
    namespaces = {
        name.partition(".")[0]
        for name in names
        if isinstance(name, str) and "." in name
    }
    malformed = sorted(
        str(name) for name in names if not isinstance(name, str) or name.count(".") != 1
    )
    unexpected_namespaces = sorted(namespaces - EXPECTED_NAMESPACES)
    missing_namespaces = sorted(EXPECTED_NAMESPACES - namespaces)

    if (
        duplicates
        or unknown
        or missing
        or malformed
        or unexpected_namespaces
        or missing_namespaces
    ):
        details = []
        if duplicates:
            details.append(f"duplicate names: {duplicates}")
        if unknown:
            details.append(f"unknown names: {unknown}")
        if missing:
            details.append(f"missing canonical names: {missing}")
        if malformed:
            details.append(f"malformed names: {malformed}")
        if unexpected_namespaces:
            details.append(f"unknown namespaces: {unexpected_namespaces}")
        if missing_namespaces:
            details.append(f"missing namespaces: {missing_namespaces}")
        raise RuntimeError("MCP tool catalog validation failed: " + "; ".join(details))

    by_name = {tool.name: tool for tool in tools}
    if len(by_name) != 16:
        raise RuntimeError(
            f"Expected 16 unique MCP tools; server returned {len(by_name)}"
        )
    return by_name


def _print_catalog(by_name: dict[str, Any]) -> None:
    """Print the live server names, descriptions, and argument schemas."""
    catalog = []
    for name, tool in sorted(by_name.items()):
        schema = tool.args_schema
        if hasattr(schema, "model_json_schema"):
            schema = schema.model_json_schema()
        elif schema is None:
            schema = tool.args
        catalog.append(
            {
                "name": name,
                "description": tool.description,
                "input_schema": schema,
            }
        )
    print(json.dumps(catalog, indent=2, ensure_ascii=False, default=str))


def _agent_tool_names(by_name: dict[str, Any]) -> list[Any]:
    """Use model-compatible names while preserving each MCP tool's closure."""
    renamed = []
    for name, tool in sorted(by_name.items()):
        # The adapter's coroutine closes over the original MCP Tool and creates
        # MCPToolCallRequest(name=tool.name), so changing the LangChain wrapper's
        # exposed name does not change the original server-side dotted name.
        alias = name.replace(".", "_")
        renamed.append(tool.model_copy(update={"name": alias}))
    return renamed


async def _run(args: argparse.Namespace) -> None:
    if args.run:
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("--run requires OPENAI_API_KEY to be set")
        if not args.pay_hook:
            raise RuntimeError(
                "--run requires --pay-hook module:function; paid tools will not "
                "be exposed to an agent without an explicit wallet connector"
            )
        pay_invoice = load_payment_hook(args.pay_hook)
        if pay_invoice is None or not callable(pay_invoice):
            raise RuntimeError(
                f"Could not load a callable wallet payment hook from {args.pay_hook!r}"
            )
    else:
        pay_invoice = None

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError as error:
        raise RuntimeError(
            "MCP discovery requires langchain-mcp-adapters==0.3.2 "
            f"({type(error).__name__}: {error})"
        ) from error

    factory = async_httpx_factory(
        args.url,
        pay_invoice=pay_invoice,
        max_sats=args.max_sats,
        timeout=float(args.timeout),
        budget_sats=args.budget_sats,
    )
    client = MultiServerMCPClient(
        {
            "catalog": {
                "transport": "streamable_http",
                "url": args.url,
                "timeout": float(args.timeout),
                "httpx_client_factory": factory,
            }
        },
        # Surface MCP execution failures as exceptions instead of representing
        # them to an agent as ordinary tool output.
        handle_tool_errors=False,
    )

    # get_tools() only performs catalog discovery; no model or paid tool call is
    # involved. The factory creates a fresh, session-owned AsyncClient each time.
    tools = await client.get_tools()
    by_name = _validate_catalog(tools)
    _print_catalog(by_name)

    if args.payment_info:
        try:
            info = await by_name["payment.get_info"].ainvoke({"action": "query"})
        except Exception as error:
            raise RuntimeError(
                "Paid payment.get_info(action='query') failed: "
                f"{type(error).__name__}: {error}"
            ) from error
        print("payment.get_info(action='query'):")
        print(json.dumps(info, indent=2, ensure_ascii=False, default=str))

    if not args.run:
        return

    try:
        from langchain_openai import ChatOpenAI

        # Deprecated in LangGraph v1; used here because this cookbook explicitly
        # demonstrates the requested create_react_agent API.
        from langgraph.prebuilt import create_react_agent
    except ImportError as error:
        raise RuntimeError(
            "Agent mode requires langgraph==1.2.12 and langchain-openai "
            f"({type(error).__name__}: {error})"
        ) from error

    model = ChatOpenAI(
        model=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"),
        timeout=float(args.timeout),
    )
    agent = create_react_agent(
        model,
        _agent_tool_names(by_name),
        prompt=(
            "You are a Bitcoin Stratigraphy MCP assistant. Use the discovered "
            "tools for claims that need current data. Payment-backed tool calls "
            "are made only through the configured wallet hook; report any "
            "payment, credential, or tool error clearly and never claim success "
            "unless the tool returned successfully."
        ),
    )
    result = await agent.ainvoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Use payment.get_info with action='query' for pricing, "
                        "then summarize the currently available tool-backed data."
                    ),
                }
            ]
        },
        config={"recursion_limit": 8},
    )
    # Preserve and show the full returned state; do not discard tool/model output.
    print("Agent result:")
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))


def main() -> int:
    args = _parse_args()
    try:
        asyncio.run(asyncio.wait_for(_run(args), timeout=AGENT_TIMEOUT_SECONDS))
    except TimeoutError:
        print(
            f"Error: cookbook operation exceeded {AGENT_TIMEOUT_SECONDS:g} seconds",
            file=sys.stderr,
        )
        return 1
    except Exception as error:
        print(f"Error: {error_detail(error)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
