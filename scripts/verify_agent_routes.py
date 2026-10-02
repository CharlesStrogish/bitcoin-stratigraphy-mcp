#!/usr/bin/env python3
"""Check public agent routes without credentials or invoice settlement.

Run: uv run --no-sync python scripts/verify_agent_routes.py --base-url https://HOST

The batch-cost probe intentionally POSTs {"tools": [...]} using the requested
descriptive names. It does NOT silently replace this with the existing GET cost
route or payment.get_info. A passing batch response must expose perToolSats (or
costs) keyed by both requested names, with positive integer satoshi prices.
The other probes use the existing canonical 14-tool catalog.

A protected call may create an unpaid invoice. No payment is attempted.
Challenge validation checks syntax/checksum, not cryptographic authenticity.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import json
import re
import ssl
import sys
from collections import Counter
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

import httpx

EXPECTED_TOOLS = frozenset({
    "stratigraphy.get", "stratigraphy.get_digest", "stratigraphy.get_diff",
    "stratigraphy.get_range", "stratigraphy.list",
    "proof.attenuate", "proof.verify", "proof.get_by_hash", "proof.list",
    "proof.submit", "proof.ground", "mesh.get_status", "mesh.broadcast",
    "payment.get_info",
})
NAMESPACES = {"stratigraphy": 5, "proof": 6, "mesh": 2, "payment": 1}
COST_TOOLS = ["stratigraphy.get_latest", "proof.verify_zk_proof"]
PROTOCOL_VERSION = "2025-03-26"
MCP_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
}
BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


class CheckFailed(Exception):
    """An expected contract assertion failed; never includes credential values."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailed(message)


def response_object(response: httpx.Response) -> dict:
    try:
        value = response.json()
    except ValueError as exc:
        raise CheckFailed("Response is not valid JSON") from exc
    require(isinstance(value, dict), "Response must be a JSON object")
    return value


def rpc_result(response: httpx.Response, request_id: str) -> dict:
    require(response.status_code == 200, f"MCP returned HTTP {response.status_code}, expected 200")
    media_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if media_type == "application/json":
        envelopes = [response_object(response)]
    elif media_type == "text/event-stream":
        envelopes = []
        for block in re.split(r"\r?\n\r?\n", response.text):
            data = "\n".join(
                line[5:].removeprefix(" ")
                for line in block.splitlines() if line.startswith("data:")
            )
            if not data or data == "[DONE]":
                continue
            try:
                envelopes.append(json.loads(data))
            except ValueError as exc:
                raise CheckFailed("SSE data is not valid JSON") from exc
    else:
        raise CheckFailed("MCP response must be application/json or text/event-stream")
    matching = [
        item for item in envelopes
        if isinstance(item, dict) and item.get("id") == request_id
        and ("result" in item or "error" in item)
    ]
    require(len(matching) == 1, "Expected exactly one JSON-RPC response with matching request id")
    envelope = matching[0]
    require(envelope.get("jsonrpc") == "2.0", "Missing JSON-RPC 2.0 envelope")
    require("error" not in envelope, "Server returned a JSON-RPC error")
    require(isinstance(envelope.get("result"), dict), "JSON-RPC result must be an object")
    return envelope["result"]


async def rpc(client: httpx.AsyncClient, method: str, request_id: str, params: dict) -> dict:
    response = await client.post("/mcp", headers=MCP_HEADERS, json={
        "jsonrpc": "2.0", "id": request_id, "method": method, "params": params,
    })
    return rpc_result(response, request_id)


async def check_server_card(client: httpx.AsyncClient) -> str:
    response = await client.get("/.well-known/mcp/server-card.json")
    require(response.status_code == 200, "Static server card must return HTTP 200")
    require(response.headers.get("access-control-allow-origin") == "*", "Server card must allow public CORS")
    require(response_object(response) == {
        "name": "bitcoin-stratigraphy-mcp",
        "displayName": "Bitcoin Stratigraphy Data Engine",
        "description": "Provides thermodynamic data, proof verification, and L402 payments.",
        "version": "1.0.0",
        "url": "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
    }, "Static server card differs from the canonical five-field contract")
    return "HTTP 200; exact canonical Smithery card; wildcard CORS"


async def check_manifest(client: httpx.AsyncClient) -> str:
    response = await client.get("/.well-known/mcp.json", headers={
        "Origin": "https://agent-health-check.invalid",
    })
    require(response.status_code == 200, f"Manifest returned HTTP {response.status_code}, expected 200")
    require(response.headers.get("access-control-allow-origin") == "*", "Manifest CORS origin must be *")
    require(
        response.headers.get("access-control-allow-credentials", "").lower() != "true",
        "Wildcard CORS must not advertise credentialed access",
    )
    manifest = response_object(response)
    capability = manifest.get("mcp", {}).get("capabilities", {}).get("tools", {})
    require(isinstance(capability, dict), "Manifest MCP tool capability must be an object")
    require(type(capability.get("count")) is int and capability["count"] == 14, "Manifest must declare 14 tools")
    declared = capability.get("namespaces")
    require(
        isinstance(declared, list) and len(declared) == 4 and set(declared) == set(NAMESPACES),
        "Manifest must declare the four expected namespaces",
    )
    # This manifest declares count/namespaces, not individual tool schemas.
    # Verify those declarations against the real capability catalog.
    catalog = await rpc(client, "tools/list", "health-tools", {})
    tools = catalog.get("tools")
    require(isinstance(tools, list) and len(tools) == 14, "Live catalog must contain exactly 14 tools")
    require(not catalog.get("nextCursor"), "14-tool catalog unexpectedly requires pagination")
    require(all(isinstance(tool, dict) for tool in tools), "Every tool definition must be an object")
    names = [tool.get("name") for tool in tools]
    require(all(isinstance(name, str) for name in names), "Every tool must have a name")
    require(set(names) == EXPECTED_TOOLS, "Live catalog does not match the canonical 14 tools")
    require(Counter(name.split(".", 1)[0] for name in names) == NAMESPACES, "Live namespace counts do not match")
    for tool in tools:
        schema = tool.get("inputSchema")
        require(
            isinstance(schema, dict) and schema.get("type") == "object",
            f"{tool['name']} must expose an object input schema",
        )
    return "HTTP 200; wildcard CORS; 14 live schemas across four namespaces"


async def check_cost(client: httpx.AsyncClient) -> str:
    response = await client.post("/api/v1/cost", json={"tools": COST_TOOLS})
    require(
        response.status_code == 200,
        f"POST /api/v1/cost returned HTTP {response.status_code}, expected 200. "
        "This check requires batch POST pricing, not a GET tier quote. Requested "
        "pricing selectors correspond to canonical stratigraphy.get and proof.verify.",
    )
    body = response_object(response)
    prices = body.get("perToolSats", body.get("costs"))
    require(isinstance(prices, dict), "Expected perToolSats or costs map keyed by requested tool name")
    for name in COST_TOOLS:
        price = prices.get(name)
        if isinstance(price, dict):
            price = price.get("price_sats")
        require(type(price) is int and price > 0, f"{name} must have a positive integer satoshi price")
    return "Both requested tools have positive integer satoshi prices"


def bech32_polymod(values: list[int]) -> int:
    checksum = 1
    generators = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1FFFFFF) << 5) ^ value
        for bit, generator in enumerate(generators):
            if (top >> bit) & 1:
                checksum ^= generator
    return checksum


def validate_challenge(header: str) -> None:
    scheme, _, fields = header.partition(" ")
    require(scheme.upper() == "L402", "WWW-Authenticate must use the L402 scheme")
    pairs = re.findall(r'([A-Za-z_]+)="([^"\\]*)"', fields)
    remainder = re.sub(r'[A-Za-z_]+="[^"\\]*"', "", fields)
    require(
        len(pairs) == 2 and {key.lower() for key, _ in pairs} == {"macaroon", "invoice"}
        and re.fullmatch(r"\s*,\s*", remainder) is not None,
        "L402 must contain exactly two comma-separated quoted macaroon and invoice fields",
    )
    values = {key.lower(): value for key, value in pairs}
    macaroon = values["macaroon"]
    require(bool(re.fullmatch(r"[A-Za-z0-9_+/=-]+", macaroon)), "Macaroon must be nonempty base64/base64url")
    try:
        decoded = base64.b64decode(macaroon + "=" * (-len(macaroon) % 4), altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise CheckFailed("Macaroon has invalid base64 encoding") from exc
    require(bool(decoded), "Decoded macaroon must not be empty")
    invoice = values["invoice"]
    require(invoice.lower() == invoice or invoice.upper() == invoice, "BOLT11 invoice has mixed case")
    hrp, separator, payload = invoice.lower().rpartition("1")
    require(
        separator == "1" and bool(re.fullmatch(r"ln(?:bcrt|bc|tb|tbs)(?:[0-9]+[munp]?)?", hrp)),
        "Invoice must have a Lightning BOLT11 network/amount prefix",
    )
    require(len(payload) >= 117 and all(char in BECH32 for char in payload), "Invalid BOLT11 data/signature/checksum format")
    expanded = [ord(char) >> 5 for char in hrp] + [0] + [ord(char) & 31 for char in hrp]
    require(bech32_polymod(expanded + [BECH32.index(char) for char in payload]) == 1, "Invalid BOLT11 Bech32 checksum")


async def check_l402(client: httpx.AsyncClient) -> str:
    response = await client.post("/mcp", headers=MCP_HEADERS, json={
        "jsonrpc": "2.0", "id": "health-paid", "method": "tools/call",
        "params": {"name": "stratigraphy.get", "arguments": {"days": 1}},
    })
    require(response.status_code == 402, f"Unauthenticated protected call returned HTTP {response.status_code}, expected 402")
    challenge = response.headers.get("www-authenticate")
    require(bool(challenge), "HTTP 402 is missing WWW-Authenticate")
    validate_challenge(challenge)
    return "HTTP 402; quoted L402 macaroon and checksum-valid BOLT11 invoice (not paid)"


async def check_transport(client: httpx.AsyncClient) -> str:
    initialized = await rpc(client, "initialize", "health-init", {
        "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
        "clientInfo": {"name": "agent-route-health-check", "version": "1.0.0"},
    })
    require(initialized.get("protocolVersion") == PROTOCOL_VERSION, "Initialize did not negotiate the requested Streamable HTTP version")
    capabilities = initialized.get("capabilities")
    require(isinstance(capabilities, dict) and isinstance(capabilities.get("tools"), dict), "Initialize must advertise tool capabilities")
    await rpc(client, "ping", "health-ping", {})
    return "Initialize capabilities and ping passed over JSON/SSE Streamable HTTP"


async def run_checks(client: httpx.AsyncClient) -> list[tuple[str, bool, str]]:
    async def run(label: str, check: Callable[[httpx.AsyncClient], Awaitable[str]]) -> tuple[str, bool, str]:
        try:
            return label, True, await check(client)
        except CheckFailed as exc:
            return label, False, str(exc)
        except httpx.TimeoutException:
            return label, False, "HTTP request timed out"
        except httpx.RequestError as exc:
            # Do not print request/response bodies, URLs, or invoice credentials.
            return label, False, f"Network/TLS request failed ({type(exc).__name__})"
        except Exception as exc:
            return label, False, f"Malformed response or unexpected error ({type(exc).__name__})"
    return await asyncio.gather(
        run("Manifest & tool schemas", check_manifest),
        run("Batch satoshi costs", check_cost),
        run("Unpaid L402 challenge", check_l402),
        run("Streamable HTTP transport", check_transport),
        run("Static server card", check_server_card),
    )


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", required=True, help="Server origin, e.g. https://bitcoin-stratigraphy-dashboard.replit.app")
    parser.add_argument("--timeout", type=float, default=30, help="Timeout per HTTP request in seconds (default: 30)")
    args = parser.parse_args(argv)
    try:
        url = urlsplit(args.base_url)
    except ValueError:
        parser.error("--base-url is malformed")
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}:
        parser.error("--base-url must be an HTTP(S) origin without credentials, query, fragment, or path")
    if not 0 < args.timeout <= 300:
        parser.error("--timeout must be greater than 0 and at most 300 seconds")
    print("Agent route health check (no credentials; invoices are never paid)\n")
    async with httpx.AsyncClient(
        base_url=args.base_url.rstrip("/"), timeout=args.timeout,
        verify=ssl.create_default_context(), follow_redirects=False,
    ) as client:
        results = await run_checks(client)
    for label, passed, detail in results:
        print(f"{'✓' if passed else '✗'} {label}: {detail}")
    failures = sum(not passed for _, passed, _ in results)
    print(f"\n{len(results) - failures}/{len(results)} checks passed; {failures} failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nHealth check interrupted.", file=sys.stderr)
        sys.exit(130)