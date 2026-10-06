#!/usr/bin/env python3
# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""AutoGen HTTP/REST example with explicitly authorized L402 calls.

Default mode performs only free MCP catalog and REST cost discovery. It makes
no LLM-provider calls and does not require wallet credentials.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

try:
    from .l402_client import (
        BitcoinStratigraphyClient,
        add_cli_arguments,
        client_from_args,
        validate_catalog,
    )
except ImportError:
    from l402_client import (  # type: ignore[no-redef]
        BitcoinStratigraphyClient,
        add_cli_arguments,
        client_from_args,
        validate_catalog,
    )


def _read_proof_arguments(path: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read proof arguments from {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(
            "--proof-file must contain a JSON object of proof.verify arguments"
        )
    if value.get("proofType") == "ots":
        valid = all(key in value for key in ("otsProof", "targetHash"))
    elif value.get("circuit") == "zk.drift.v1":
        valid = all(
            key in value
            for key in (
                "sessionContextHash",
                "targetBlockHeight",
                "entropyThreshold",
                "proof",
            )
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


async def _discover(client: BitcoinStratigraphyClient) -> None:
    tools = await asyncio.to_thread(client.list_tools)
    validated = validate_catalog(tools)
    print("MCP tool catalog (validated):")
    print(json.dumps([tool.get("name") for tool in validated], indent=2))
    response = await asyncio.to_thread(client.request, "GET", "/api/v1/cost")
    response.raise_for_status()
    print("Free REST cost/schema discovery (GET /api/v1/cost):")
    print(json.dumps(response.json(), indent=2, ensure_ascii=False))


async def _run_paid_workflow(
    client: BitcoinStratigraphyClient,
    proof_arguments: dict[str, Any] | None,
) -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise ValueError("Set OPENAI_API_KEY before using --run.")

    from autogen_agentchat.agents import AssistantAgent
    from autogen_agentchat.ui import Console
    from autogen_core.tools import FunctionTool
    from autogen_ext.models.openai import OpenAIChatCompletionClient

    model_client = OpenAIChatCompletionClient(
        model=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"),
        api_key=os.environ["OPENAI_API_KEY"],
    )
    used_tools: set[str] = set()
    tool_errors: list[str] = []

    async def stratigraphy_get(days: int = 1) -> str:
        """Fetch paid stratigraphy with GET /api/v1/stratigraphy?days=N.

        This REST operation is L402 protected; a wallet payment hook is needed.
        Only days is exposed, as specified by the REST API's query schema.
        """
        if not 1 <= days <= 422:
            raise ValueError("days must be in the OpenAPI range 1..422")
        if "stratigraphy.get" in used_tools:
            raise RuntimeError(
                "This example permits only one paid stratigraphy request."
            )
        used_tools.add("stratigraphy.get")
        try:
            # The server implements days=N as the most recent N indexed records;
            # days=1 is therefore the latest indexed daily record.
            response = await asyncio.to_thread(
                client.request,
                "GET",
                "/api/v1/stratigraphy",
                params={"days": days},
            )
            response.raise_for_status()
            return json.dumps(response.json(), ensure_ascii=False)
        except Exception as exc:
            tool_errors.append(f"stratigraphy.get REST request failed: {exc}")
            raise

    tools = [
        FunctionTool(
            stratigraphy_get,
            name="stratigraphy_get",
            description=(
                "Paid REST query of indexed telemetry. Calls GET /api/v1/stratigraphy "
                "with the exact OpenAPI query parameter days."
            ),
        ),
    ]
    if proof_arguments is not None:

        async def proof_verify(confirm: bool) -> str:
            """Verify caller-provided proof arguments through canonical MCP proof.verify."""
            if confirm is not True:
                raise ValueError("Proof verification requires explicit confirm=true.")
            if "proof.verify" in used_tools:
                raise RuntimeError("This example permits only one proof.verify call.")
            used_tools.add("proof.verify")
            try:
                result = await asyncio.to_thread(
                    client.call_tool, "proof.verify", proof_arguments
                )
                return json.dumps(result, ensure_ascii=False)
            except Exception as exc:
                tool_errors.append(f"proof.verify MCP call failed: {exc}")
                raise

        tools.append(
            FunctionTool(
                proof_verify,
                name="proof_verify",
                description=(
                    "Paid verification with canonical MCP tool proof.verify. Uses only the "
                    "real proof arguments supplied via --proof-file; never invent inputs."
                ),
            )
        )
    system_message = (
        "Use stratigraphy_get once for the latest indexed day. "
        "Do not make any other tool calls."
    )
    task = (
        "Use stratigraphy_get with days=1 to retrieve the latest indexed daily record."
    )
    if proof_arguments is not None:
        system_message = (
            "Use stratigraphy_get once for the latest indexed day. Then use proof_verify "
            "once with confirm=true to verify the caller-supplied proof. Never invent, "
            "rewrite, or infer proof inputs. Do not make any other tool calls."
        )
        task += (
            " Then verify the supplied proof using proof_verify(confirm=true). "
            "The proof payload comes unchanged from the user's proof file."
        )
    agent = AssistantAgent(
        name="bitcoin_stratigraphy",
        model_client=model_client,
        tools=tools,
        system_message=system_message,
        reflect_on_tool_use=True,
    )
    try:
        await Console(agent.run_stream(task=task))
        if tool_errors:
            raise RuntimeError("; ".join(tool_errors))
        required_tools = {"stratigraphy.get"}
        if proof_arguments is not None:
            required_tools.add("proof.verify")
        if not required_tools.issubset(used_tools):
            missing = sorted(required_tools - used_tools)
            raise RuntimeError(
                "Agent completed without executing required tool(s): "
                + ", ".join(missing)
            )
    finally:
        await model_client.close()


def _safe_error_detail(error: Exception) -> str:
    """Keep useful failures while avoiding common payment/credential leaks."""
    detail = str(error)
    detail = re.sub(
        r"(?i)(authorization\s*[:=]\s*)(?:L402|Bearer|Nostr)?\s*[^\s,;]+",
        r"\1[REDACTED]",
        detail,
    )
    detail = re.sub(
        r"(?i)\b(?:lnbc|lntb|lnbcrt)[0-9a-z]+\b", "[REDACTED_INVOICE]", detail
    )
    detail = re.sub(
        r"(?i)(macaroon\s*[:=]\s*)[^\s,;]+",
        r"\1[REDACTED]",
        detail,
    )
    detail = re.sub(r"\b[0-9a-fA-F]{64}\b", "[REDACTED_HEX]", detail)
    return detail


async def _async_main(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if args.run:
        if not os.environ.get("OPENAI_API_KEY"):
            parser.error("--run requires OPENAI_API_KEY")
        if not args.pay_hook:
            parser.error("--run requires --pay-hook module:function")
    elif args.pay_hook:
        parser.error("--pay-hook is only used with --run; default discovery is free")
    if args.proof_file and not args.run:
        parser.error("--proof-file is only used with --run")

    try:
        proof_arguments = (
            _read_proof_arguments(args.proof_file) if args.proof_file else None
        )
    except ValueError as exc:
        parser.error(str(exc))

    try:
        with client_from_args(args) as client:
            await _discover(client)
            if args.run:
                await _run_paid_workflow(client, proof_arguments)
        return 0
    except Exception as exc:
        print(f"AutoGen example failed: {_safe_error_detail(exc)}", file=sys.stderr)
        return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    add_cli_arguments(parser)
    parser.add_argument(
        "--run",
        action="store_true",
        help="Run paid REST stratigraphy and MCP proof.verify tasks with AutoGen.",
    )
    parser.add_argument(
        "--proof-file",
        help=(
            "Optional JSON file with real proof.verify arguments; when supplied with "
            "--run, enables a paid MCP proof-verification tool."
        ),
    )
    args = parser.parse_args(argv)
    return asyncio.run(_async_main(args, parser))


if __name__ == "__main__":
    raise SystemExit(main())
