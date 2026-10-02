#!/usr/bin/env python3
"""CrewAI example for free discovery and explicitly authorized paid MCP calls.

Default mode only discovers MCP tools and reads public cost metadata. It does
not create an agent-provider request, wallet payment, or paid data request.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Type

try:
    from .l402_client import (
        MCP_URL,
        BitcoinStratigraphyClient,
        add_cli_arguments,
        client_from_args,
        validate_catalog,
    )
except ImportError:
    from l402_client import (  # type: ignore[no-redef]
        MCP_URL,
        BitcoinStratigraphyClient,
        add_cli_arguments,
        client_from_args,
        validate_catalog,
    )


def build_native_discovery_agent(mcp_url: str = MCP_URL) -> Any:
    """Construct CrewAI's native remote-MCP agent, restricted to free discovery.

    This demonstrates MCPServerHTTP configuration without invoking an LLM or
    asking the agent to call a paid tool. Paid L402 calls use the custom
    BaseTool wrappers below because MCPServerHTTP has no documented
    httpx-client-factory injection point.
    """
    from crewai import Agent
    from crewai.mcp import MCPServerHTTP
    from crewai.mcp.filters import create_static_tool_filter

    return Agent(
        role="Bitcoin stratigraphy catalog discoverer",
        goal="Discover available stratigraphy data without requesting paid data.",
        backstory="A careful assistant limited to free catalog discovery.",
        verbose=False,
        max_iter=4,
        mcps=[
            MCPServerHTTP(
                url=mcp_url,
                streamable=True,
                cache_tools_list=True,
                tool_filter=create_static_tool_filter(
                    allowed_tool_names=["stratigraphy.list"],
                ),
            )
        ],
    )


def _read_proof_arguments(path: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read proof arguments from {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("--proof-file must contain a JSON object of proof.verify arguments")
    if value.get("proofType") == "ots":
        valid = all(key in value for key in ("otsProof", "targetHash"))
    elif value.get("circuit") == "zk.drift.v1":
        valid = all(
            key in value
            for key in ("sessionContextHash", "targetBlockHeight", "entropyThreshold", "proof")
        )
    else:
        public_inputs = value.get("publicInputs")
        valid = (
            isinstance(value.get("proof"), str)
            and isinstance(public_inputs, dict)
            and all(
                key in public_inputs
                for key in (
                    "blockHeight",
                    "snapshotDigest",
                    "thermodynamicHash",
                    "timestamp",
                    "valuationSat",
                )
            )
            and isinstance(value.get("verificationKeyId"), str)
            and "data" in value
        )
    if not valid:
        raise ValueError(
            "--proof-file must contain an actual proof.verify argument object "
            "matching one of the server's supported proof schemas"
        )
    return value


def _build_paid_tools(
    client: BitcoinStratigraphyClient,
    proof_arguments: dict[str, Any],
) -> tuple[list[Any], set[str], list[str]]:
    from crewai.tools import BaseTool
    from pydantic import BaseModel, Field

    class StratigraphyGetArgs(BaseModel):
        days: int = Field(default=1, ge=1, le=422)

    class ProofVerifyArgs(BaseModel):
        confirm: bool = Field(
            description="Must be true to verify the exact caller-supplied proof payload."
        )

    used_tools: set[str] = set()
    tool_errors: list[str] = []

    class StratigraphyGetTool(BaseTool):
        name: str = "stratigraphy_get"
        description: str = (
            "Call canonical MCP tool stratigraphy.get for indexed telemetry. "
            "This is a paid L402 operation; use only when the task explicitly requests it."
        )
        args_schema: Type[BaseModel] = StratigraphyGetArgs

        def _run(self, days: int = 1) -> str:
            if "stratigraphy.get" in used_tools:
                raise RuntimeError("This example permits only one stratigraphy.get call.")
            used_tools.add("stratigraphy.get")
            try:
                result = client.call_tool("stratigraphy.get", {"days": days})
                return json.dumps(result, ensure_ascii=False)
            except Exception as exc:
                tool_errors.append(f"stratigraphy.get failed: {exc}")
                raise

    class ProofVerifyTool(BaseTool):
        name: str = "proof_verify"
        description: str = (
            "Call canonical MCP tool proof.verify on the exact real proof payload "
            "provided by the caller. This is a paid operation. Do not invent or modify "
            "proof inputs; invoke only when confirm=true."
        )
        args_schema: Type[BaseModel] = ProofVerifyArgs

        def _run(self, confirm: bool) -> str:
            if not confirm:
                raise ValueError("Proof verification requires explicit confirm=true.")
            if "proof.verify" in used_tools:
                raise RuntimeError("This example permits only one proof.verify call.")
            used_tools.add("proof.verify")
            try:
                result = client.call_tool("proof.verify", proof_arguments)
                return json.dumps(result, ensure_ascii=False)
            except Exception as exc:
                tool_errors.append(f"proof.verify failed: {exc}")
                raise

    return [StratigraphyGetTool(), ProofVerifyTool()], used_tools, tool_errors


def _safe_error_detail(error: Exception) -> str:
    """Keep useful failures while avoiding common payment/credential leaks."""
    detail = str(error)
    detail = re.sub(
        r"(?i)(authorization\s*[:=]\s*)(?:L402|Bearer|Nostr)?\s*[^\s,;]+",
        r"\1[REDACTED]",
        detail,
    )
    detail = re.sub(r"(?i)\b(?:lnbc|lntb|lnbcrt)[0-9a-z]+\b", "[REDACTED_INVOICE]", detail)
    detail = re.sub(
        r"(?i)(macaroon\s*[:=]\s*)[^\s,;]+",
        r"\1[REDACTED]",
        detail,
    )
    detail = re.sub(r"\b[0-9a-fA-F]{64}\b", "[REDACTED_HEX]", detail)
    return detail


def _run_paid_workflow(
    client: BitcoinStratigraphyClient,
    proof_arguments: dict[str, Any],
) -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise ValueError("Set OPENAI_API_KEY before using --run.")

    from crewai import Agent, Crew, Process, Task

    (get_tool, verify_tool), used_tools, tool_errors = _build_paid_tools(
        client, proof_arguments
    )
    data_agent = Agent(
        role="Bitcoin stratigraphy analyst",
        goal="Retrieve the requested indexed telemetry using the approved tool.",
        backstory="A cautious analyst that uses only explicitly authorized data tools.",
        tools=[get_tool],
        llm=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"),
        verbose=False,
        max_iter=4,
        allow_delegation=False,
    )
    verify_agent = Agent(
        role="ZK proof verifier",
        goal="Verify only the caller-supplied proof using the approved tool.",
        backstory="A careful verifier that never fabricates proof inputs.",
        tools=[verify_tool],
        llm=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"),
        verbose=False,
        max_iter=4,
        allow_delegation=False,
    )
    data_task = Task(
        description=(
            "Call stratigraphy_get exactly once for the latest indexed day (days=1). "
            "Report the returned result and do not call any other tool."
        ),
        expected_output="The result returned by stratigraphy.get.",
        agent=data_agent,
    )
    proof_task = Task(
        description=(
            "Call proof_verify exactly once with confirm=true. The wrapper supplies "
            "the exact caller-provided proof.verify arguments from --proof-file. "
            "Do not create, change, or infer proof fields."
        ),
        expected_output="The result returned by proof.verify.",
        agent=verify_agent,
    )
    crew = Crew(
        agents=[data_agent, verify_agent],
        tasks=[data_task, proof_task],
        process=Process.sequential,
    )
    result = crew.kickoff()
    if tool_errors:
        raise RuntimeError("; ".join(tool_errors))
    if not {"stratigraphy.get", "proof.verify"}.issubset(used_tools):
        missing = sorted({"stratigraphy.get", "proof.verify"} - used_tools)
        raise RuntimeError(
            "Crew completed without executing required tool(s): " + ", ".join(missing)
        )
    print(result)


def _discover(client: BitcoinStratigraphyClient) -> None:
    tools = validate_catalog(client.list_tools())
    print("MCP tool catalog (validated):")
    print(json.dumps([tool.get("name") for tool in tools], indent=2))
    response = client.request("GET", "/api/v1/cost")
    response.raise_for_status()
    print("Free REST cost/schema discovery:")
    print(json.dumps(response.json(), indent=2, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    add_cli_arguments(parser)
    parser.add_argument(
        "--run",
        action="store_true",
        help="Run paid stratigraphy.get and proof.verify CrewAI tasks.",
    )
    parser.add_argument(
        "--proof-file",
        help="JSON file containing real proof.verify arguments (required with --run).",
    )
    parser.add_argument(
        "--native-discovery",
        action="store_true",
        help="Also construct a free-discovery-only native MCPServerHTTP agent.",
    )
    args = parser.parse_args(argv)

    if args.run:
        if not args.proof_file:
            parser.error("--run requires --proof-file with real proof.verify arguments")
        if not os.environ.get("OPENAI_API_KEY"):
            parser.error("--run requires OPENAI_API_KEY")
        if not args.pay_hook:
            parser.error("--run requires --pay-hook module:function")
    elif args.pay_hook:
        parser.error("--pay-hook is only used with --run; default discovery is free")

    try:
        proof_arguments = _read_proof_arguments(args.proof_file) if args.run else None
    except ValueError as exc:
        parser.error(str(exc))

    try:
        with client_from_args(args) as client:
            _discover(client)
            if args.native_discovery:
                agent = build_native_discovery_agent(args.url)
                print(
                    "Constructed native CrewAI MCPServerHTTP discovery agent "
                    f"for {args.url}; only stratigraphy.list is allowed."
                )
                del agent
            if args.run:
                assert proof_arguments is not None
                _run_paid_workflow(client, proof_arguments)
        return 0
    except Exception as exc:
        print(f"CrewAI example failed: {_safe_error_detail(exc)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())