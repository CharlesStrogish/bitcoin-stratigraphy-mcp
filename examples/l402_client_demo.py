#!/usr/bin/env python3
"""Call the Bitcoin Stratigraphy MCP server through an L402 payment challenge.

Usage:
    python3 examples/l402_client_demo.py --url https://YOUR-SERVER/mcp

Uses only Python's standard library. The example prompts for the preimage
returned by your Lightning wallet; replace pay_invoice() with your NWC/LND
wallet adapter for an unattended agent. Running it may pay a real invoice.
"""

import argparse
import getpass
import hashlib
import json
import os
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


CHALLENGE_PATTERN = re.compile(
    r'(?:L402|LSAT)\s+macaroon="([^"]+)",\s*invoice="(ln[^"]+)"',
    re.IGNORECASE,
)
PAYMENT_HASH_PATTERN = re.compile(r"[0-9a-fA-F]{64}")


class NoRedirects(HTTPRedirectHandler):
    """Do not forward bearer credentials to a redirected server."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(NoRedirects())


def post_tool(url: str, body: bytes, authorization: str | None = None):
    """Return (HTTP status, headers, JSON body), including HTTP 402 responses."""
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-03-26",
    }
    if authorization:
        headers["Authorization"] = authorization
    request = Request(url, data=body, headers=headers, method="POST")
    try:
        response = OPENER.open(request, timeout=20)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(
                f"HTTP {response.status} returned non-JSON data"
            ) from error
        return response.status, response.headers, payload


def parse_challenge(headers, payload: dict) -> tuple[str, str, str]:
    """Parse the header, cross-check the JSON challenge, and bind its payment hash."""
    match = CHALLENGE_PATTERN.fullmatch(headers.get("WWW-Authenticate", "").strip())
    if not match:
        raise ValueError(
            "402 response did not include an L402/LSAT macaroon and invoice"
        )
    macaroon, invoice = match.groups()
    if payload.get("macaroon") != macaroon or payload.get("invoice") != invoice:
        raise ValueError("WWW-Authenticate and JSON challenge disagree")
    payment_hash = payload.get("payment_hash")
    if not isinstance(payment_hash, str) or not PAYMENT_HASH_PATTERN.fullmatch(
        payment_hash
    ):
        raise ValueError("402 response did not include a valid payment_hash")
    return macaroon, invoice, payment_hash.lower()


def pay_invoice(invoice: str) -> str:
    """Get a 32-byte hex preimage from an external Lightning wallet.

    Replace this interactive demo with your agent's NWC pay_invoice or LND
    SendPaymentV2 call. Pass the exact invoice to the wallet and return its
    settled payment preimage (not just a success flag or payment hash).
    Keep wallet credentials and preimages out of logs and source code.
    """
    if not sys.stdin.isatty():
        raise RuntimeError("A wallet adapter is required in non-interactive mode")
    print(
        f"Pay this Lightning invoice with your NWC/LND wallet:\n{invoice}",
        file=sys.stderr,
    )
    return getpass.getpass("Settled payment preimage (64 hex characters): ").strip()


def call_stratigraphy_get(url: str):
    """Quote, pay once if necessary, and retry the same MCP JSON-RPC call."""
    request_body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "stratigraphy.get",
                "arguments": {"days": 1, "limit": 1},
            },
        }
    ).encode("utf-8")

    # First send the exact tool call without credentials to request its L402 quote.
    status, headers, payload = post_tool(url, request_body)
    if status == 402:
        macaroon, invoice, payment_hash = parse_challenge(headers, payload)
        preimage = pay_invoice(invoice)
        if not PAYMENT_HASH_PATTERN.fullmatch(preimage):
            raise ValueError("Wallet did not return a 32-byte hex payment preimage")
        if hashlib.sha256(bytes.fromhex(preimage)).hexdigest() != payment_hash:
            raise ValueError(
                "Wallet preimage does not match this invoice's payment hash"
            )

        # Do not pay again if this single retry fails or receives another 402.
        authorization = f"L402 {macaroon}:{preimage.lower()}"
        status, _, payload = post_tool(url, request_body, authorization)
    if status != 200:
        raise RuntimeError(f"MCP request failed (HTTP {status}): {payload}")
    if payload.get("error"):
        raise RuntimeError(f"MCP tool error: {payload['error']}")
    result = payload.get("result", {})
    if result.get("isError"):
        raise RuntimeError(f"MCP tool returned an error: {result.get('content')}")
    structured = result.get("structuredContent")
    if not isinstance(structured, dict):
        raise RuntimeError("MCP tool did not return structured JSON content")
    return structured


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url",
        default=os.environ.get("STRATIGRAPHY_MCP_URL"),
        help="Full Streamable HTTP MCP endpoint URL (or set STRATIGRAPHY_MCP_URL)",
    )
    args = parser.parse_args()
    if not args.url:
        parser.error("supply --url or STRATIGRAPHY_MCP_URL")
    parts = urlsplit(args.url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        parser.error("--url must be an HTTP(S) MCP endpoint")
    if parts.scheme != "https" and parts.hostname not in (
        "localhost",
        "127.0.0.1",
        "::1",
    ):
        parser.error("use HTTPS outside localhost to protect the L402 credential")
    try:
        print(json.dumps(call_stratigraphy_get(args.url), indent=2, ensure_ascii=False))
    except (RuntimeError, ValueError, OSError) as error:
        parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
    main()
