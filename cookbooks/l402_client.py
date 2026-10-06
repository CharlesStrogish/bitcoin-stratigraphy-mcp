# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""HTTPX MCP/REST client with explicit, bounded Lightning payment callbacks.

Requires Python 3.11+ and httpx. No credentials are loaded or invoices paid
unless a callback is explicitly supplied. HTTP retries never reuse a paid token.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib
import itertools
import json
import math
import os
import re
import ssl
import threading
from dataclasses import dataclass, field
from typing import Callable
from urllib.request import parse_http_list

import httpx

MCP_URL = "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"
CANONICAL_TOOLS = frozenset(
    {
        "stratigraphy.list",
        "stratigraphy.get",
        "stratigraphy.get_digest",
        "stratigraphy.get_diff",
        "stratigraphy.get_range",
        "proof.attenuate",
        "proof.verify",
        "proof.get_by_hash",
        "proof.list",
        "proof.submit",
        "proof.ground",
        "mesh.get_status",
        "mesh.broadcast",
        "payment.get_info",
    }
)


@dataclass(frozen=True)
class L402Challenge:
    macaroon: str = field(repr=False)
    invoice: str = field(repr=False)
    payment_hash: str
    amount_sats: int
    request_url: str
    tool_name: str | None = None


class PaymentRequiredError(RuntimeError):
    def __init__(self, challenge: L402Challenge):
        self.challenge = challenge
        super().__init__(
            f"L402 payment of {challenge.amount_sats} sats requires an explicit "
            "--pay-hook module:function callback returning a settled hex preimage."
        )


class PaymentRejectedError(RuntimeError):
    """A settled invoice must not be paid again automatically."""


PaymentHook = Callable[[L402Challenge], str]


def _invoice_details(invoice: str) -> tuple[str, int]:
    """Read a BOLT11 payment hash/amount; the wallet verifies its signature."""
    alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    if invoice.lower() != invoice and invoice.upper() != invoice:
        raise ValueError("Mixed-case BOLT11 invoice")
    invoice = invoice.lower()
    hrp, separator, encoded = invoice.rpartition("1")
    if not separator:
        raise ValueError("Invalid BOLT11 invoice")
    amount = re.fullmatch(r"ln(?:bcrt|bc|tb|sb)([0-9]+)([munp]?)", hrp)
    if not amount:
        raise ValueError("An amount-bearing Bitcoin Lightning invoice is required")
    try:
        words = [alphabet.index(char) for char in encoded]
    except ValueError as exc:
        raise ValueError("Invalid BOLT11 encoding") from exc
    check = 1
    expanded = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    generators = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    for value in expanded + words:
        top = check >> 25
        check = ((check & 0x1FFFFFF) << 5) ^ value
        for index, generator in enumerate(generators):
            if (top >> index) & 1:
                check ^= generator
    if check != 1 or len(words) < 117:
        raise ValueError("Invalid BOLT11 checksum or truncated invoice")
    factors = {"": 100_000_000_000, "m": 100_000_000, "u": 100_000, "n": 100}
    value, unit = int(amount[1]), amount[2]
    if unit == "p":
        if value % 10:
            raise ValueError("Invoice amount is below millisatoshi precision")
        msats = value // 10
    else:
        msats = value * factors[unit]
    tagged = words[7:-110]  # Seven timestamp words, 104 signature words, six checksum.
    hashes = []
    while tagged:
        if len(tagged) < 3:
            raise ValueError("Truncated BOLT11 tag")
        tag, size = tagged[0], (tagged[1] << 5) | tagged[2]
        payload, tagged = tagged[3 : 3 + size], tagged[3 + size :]
        if len(payload) != size:
            raise ValueError("Truncated BOLT11 tagged payload")
        if alphabet[tag] == "p":
            if size != 52:
                raise ValueError("Invalid BOLT11 payment hash")
            number = 0
            for word in payload:
                number = (number << 5) | word
            if number & 15:
                raise ValueError("Invalid BOLT11 payment-hash padding")
            hashes.append((number >> 4).to_bytes(32, "big").hex())
    if len(hashes) != 1 or msats <= 0:
        raise ValueError(
            "Invoice must contain exactly one payment hash and a positive amount"
        )
    return hashes[0], msats


class _Budget:
    def __init__(self, total_sats: int):
        if (
            isinstance(total_sats, bool)
            or not isinstance(total_sats, int)
            or total_sats <= 0
        ):
            raise ValueError("Payment budget must be a positive integer")
        self.remaining = total_sats
        self.lock = threading.Lock()


class L402Auth(httpx.Auth):
    """Sync/async HTTPX auth; only 402 bodies are buffered, never live SSE."""

    def __init__(
        self,
        merchant_url: str,
        pay_invoice: PaymentHook | None = None,
        max_sats: int = 250,
        budget_sats: int = 1000,
        budget: _Budget | None = None,
    ):
        url = httpx.URL(merchant_url)
        if url.scheme not in ("http", "https") or not url.host or url.userinfo:
            raise ValueError("Use an HTTP(S) merchant URL without embedded credentials")
        if isinstance(max_sats, bool) or not isinstance(max_sats, int) or max_sats <= 0:
            raise ValueError("Per-invoice limit must be a positive integer")
        self.origin = (url.scheme, url.host, url.port)
        self.mcp_path = url.path
        self.pay_invoice = pay_invoice
        self.max_sats = max_sats
        self.budget = budget or _Budget(budget_sats)

    def _challenge(self, response: httpx.Response) -> L402Challenge:
        request = response.request
        if (request.url.scheme, request.url.host, request.url.port) != self.origin:
            raise ValueError("Refusing a payment challenge from a different origin")
        if request.method not in ("GET", "POST"):
            raise ValueError("Only explicit GET/POST requests can authorize payments")
        tool = None
        if request.url.path == self.mcp_path:
            rpc = json.loads(request.content)
            if rpc.get("method") != "tools/call":
                raise ValueError(
                    "MCP discovery and initialization must not require payment"
                )
            tool = rpc.get("params", {}).get("name")
            if tool not in CANONICAL_TOOLS:
                raise ValueError("Refusing payment for an unrecognized MCP tool")
        header = response.headers.get("www-authenticate", "")
        scheme, _, fields = header.partition(" ")
        if scheme.lower() != "l402":
            raise ValueError("HTTP 402 did not contain an L402 challenge")
        attributes = {}
        for item in parse_http_list(fields):
            match = re.fullmatch(r'\s*([A-Za-z_][\w-]*)="([^"\r\n]+)"\s*', item)
            if not match or match[1].lower() in attributes:
                raise ValueError("Malformed or duplicate L402 challenge fields")
            attributes[match[1].lower()] = match[2]
        body = response.json()
        if not isinstance(body, dict):
            raise ValueError("L402 challenge body must be a JSON object")
        macaroon, invoice = (
            attributes.get("macaroon", ""),
            attributes.get("invoice", ""),
        )
        if not re.fullmatch(r"[A-Za-z0-9_+/=-]{1,8192}", macaroon):
            raise ValueError("Invalid L402 macaroon")
        if body.get("macaroon") != macaroon or body.get("invoice") != invoice:
            raise ValueError("Conflicting header and body challenge values")
        payment_hash, msats = _invoice_details(invoice)
        supplied_hash = body.get("payment_hash")
        if not isinstance(supplied_hash, str) or supplied_hash.lower() != payment_hash:
            raise ValueError("Invoice and challenge payment hashes differ")
        amount = body.get("amount_sats")
        if (
            isinstance(amount, bool)
            or not isinstance(amount, int)
            or amount * 1000 != msats
        ):
            raise ValueError("Invoice and challenge amounts differ")
        if amount > self.max_sats:
            raise ValueError(
                "Invoice exceeds the configured per-invoice spending limit"
            )
        return L402Challenge(
            macaroon, invoice, payment_hash, amount, str(request.url), tool
        )

    def _settle(self, challenge: L402Challenge) -> str:
        if self.pay_invoice is None:
            raise PaymentRequiredError(challenge)
        # Serialize callbacks across adapter sessions. A failed/ambiguous wallet call
        # still consumes the reservation: it may already have transferred money.
        with self.budget.lock:
            if challenge.amount_sats > self.budget.remaining:
                raise ValueError("Run-wide invoice spending budget exhausted")
            self.budget.remaining -= challenge.amount_sats
            preimage = self.pay_invoice(challenge)
        if not isinstance(preimage, str) or not re.fullmatch(
            r"[0-9a-fA-F]{64}", preimage
        ):
            raise ValueError(
                "Wallet callback must return a 32-byte hex preimage, not an invoice ID"
            )
        if (
            hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
            != challenge.payment_hash
        ):
            raise ValueError("Wallet preimage does not match the selected invoice")
        return f"L402 {challenge.macaroon}:{preimage.lower()}"

    def sync_auth_flow(self, request: httpx.Request):
        request.read()  # Make exactly the same body replayable once.
        original = request.headers.get("Authorization")
        try:
            response = yield request
            if response.status_code == 402:
                response.read()
                challenge = self._challenge(response)
                response.close()
                request.headers["Authorization"] = self._settle(challenge)
                response = yield request
                if response.status_code == 402:
                    response.close()
                    raise PaymentRejectedError(
                        "Paid retry still returned 402; no second invoice payment attempted"
                    )
        finally:
            if original is None:
                request.headers.pop("Authorization", None)
            else:
                request.headers["Authorization"] = original

    async def async_auth_flow(self, request: httpx.Request):
        await request.aread()
        original = request.headers.get("Authorization")
        try:
            response = yield request
            if response.status_code == 402:
                await response.aread()
                challenge = self._challenge(response)
                await response.aclose()
                request.headers["Authorization"] = await asyncio.to_thread(
                    self._settle, challenge
                )
                response = yield request
                if response.status_code == 402:
                    await response.aclose()
                    raise PaymentRejectedError(
                        "Paid retry still returned 402; no second invoice payment attempted"
                    )
        finally:
            if original is None:
                request.headers.pop("Authorization", None)
            else:
                request.headers["Authorization"] = original


def async_httpx_factory(
    mcp_url: str,
    pay_invoice: PaymentHook | None = None,
    max_sats: int = 250,
    timeout: float = 20.0,
    budget_sats: int = 1000,
):
    """Factory accepted by langchain-mcp-adapters; each session owns its client."""
    budget = _Budget(budget_sats)

    def factory(headers=None, timeout=None, auth=None):
        if auth is not None:
            raise ValueError(
                "Do not combine another HTTP auth provider with the L402 factory"
            )
        return httpx.AsyncClient(
            headers=headers,
            timeout=timeout if timeout is not None else default_timeout,
            auth=L402Auth(mcp_url, pay_invoice, max_sats, budget=budget),
            follow_redirects=False,
            verify=ssl.create_default_context(),
        )

    default_timeout = timeout
    return factory


class BitcoinStratigraphyClient:
    """Remote JSON-RPC and REST. Credentials are request-local and never cached."""

    def __init__(
        self,
        mcp_url: str = MCP_URL,
        pay_invoice: PaymentHook | None = None,
        max_sats: int = 250,
        timeout: float = 20.0,
        budget_sats: int = 1000,
        transport: httpx.BaseTransport | None = None,
    ):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("HTTP timeout must be finite and positive")
        self.mcp_url = str(httpx.URL(mcp_url))
        self.protocol_version = "2025-11-25"
        self._ids = itertools.count(1)
        self._initialized = False
        self._initialize_lock = threading.RLock()
        self._http = httpx.Client(
            transport=transport,
            timeout=timeout,
            follow_redirects=False,
            auth=L402Auth(mcp_url, pay_invoice, max_sats, budget_sats),
            verify=ssl.create_default_context(),
        )
        self._headers = {"Accept": "application/json, text/event-stream"}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        self._http.close()

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("REST paths must be origin-relative, not external URLs")
        url = httpx.URL(self.mcp_url).copy_with(path=path, query=None, fragment=None)
        response = self._http.request(method, url, **kwargs)
        response.raise_for_status()
        return response

    def _rpc(self, method: str, params: dict | None = None) -> dict:
        request_id = next(self._ids)
        body = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            body["params"] = params
        headers = {**self._headers, "MCP-Protocol-Version": self.protocol_version}
        with self._http.stream(
            "POST", self.mcp_url, json=body, headers=headers
        ) as response:
            response.raise_for_status()
            if response.headers.get("mcp-session-id"):
                self._headers["Mcp-Session-Id"] = response.headers["mcp-session-id"]
            if response.headers.get("content-type", "").startswith("text/event-stream"):
                event, size = [], 0
                message = None
                for line in response.iter_lines():
                    size += len(line)
                    if size > 4_000_000:
                        raise ValueError("MCP response exceeds the cookbook size limit")
                    if line.startswith("data:"):
                        event.append(line[5:].lstrip())
                    if not line and event:
                        candidate = json.loads("\n".join(event))
                        event = []
                        if candidate.get("id") == request_id:
                            message = candidate
                            break
                if message is None:
                    raise ValueError(
                        "MCP SSE response contained no matching JSON-RPC result"
                    )
            else:
                response.read()
                message = response.json()
        if message.get("id") != request_id or message.get("jsonrpc") != "2.0":
            raise ValueError("Mismatched MCP JSON-RPC response")
        if "error" in message:
            raise RuntimeError(
                f"MCP error: {message['error'].get('message', 'unknown error')}"
            )
        if not isinstance(message.get("result"), dict):
            raise ValueError("MCP response is missing a structured result")
        return message["result"]

    def initialize(self):
        with self._initialize_lock:
            if self._initialized:
                return
            result = self._rpc(
                "initialize",
                {
                    "protocolVersion": self.protocol_version,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "bitcoin-stratigraphy-python-cookbooks",
                        "version": "1.0.0",
                    },
                },
            )
            version = result.get("protocolVersion")
            if version not in {"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}:
                raise ValueError("Unsupported negotiated MCP protocol")
            self.protocol_version = version
            response = self._http.post(
                self.mcp_url,
                headers={
                    **self._headers,
                    "MCP-Protocol-Version": version,
                },
                json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            )
            response.raise_for_status()
            self._initialized = True

    def list_tools(self) -> list[dict]:
        self.initialize()
        tools, cursor, seen = [], None, set()
        while True:
            result = self._rpc("tools/list", {"cursor": cursor} if cursor else {})
            tools.extend(result.get("tools", []))
            cursor = result.get("nextCursor")
            if not cursor:
                return tools
            if cursor in seen or len(seen) >= 20:
                raise ValueError("Invalid or unbounded MCP tool pagination")
            seen.add(cursor)

    def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        if name not in CANONICAL_TOOLS:
            raise ValueError(f"Unknown tool: {name}")
        self.initialize()
        result = self._rpc("tools/call", {"name": name, "arguments": arguments or {}})
        if result.get("isError"):
            raise RuntimeError(f"MCP tool {name} failed: {result.get('content', [])}")
        return result


def validate_catalog(tools: list[dict]) -> list[dict]:
    names = [tool["name"] for tool in tools]
    if len(names) != 14 or len(set(names)) != 14 or set(names) != CANONICAL_TOOLS:
        raise ValueError(
            "Remote catalog does not match the 14 canonical Stratigraphy tools"
        )
    return tools


def load_payment_hook(spec: str | None) -> PaymentHook | None:
    if not spec:
        return None
    module, separator, function = spec.partition(":")
    if not separator or not module or not function:
        raise ValueError("--pay-hook must be module:function")
    hook = getattr(importlib.import_module(module), function)
    if not callable(hook):
        raise ValueError("Payment hook must be callable")
    return hook


def error_detail(error: BaseException) -> str:
    """Expose async transport causes without printing payment credentials."""
    if isinstance(error, BaseExceptionGroup):
        return "; ".join(error_detail(child) for child in error.exceptions)
    detail = f"{type(error).__name__}: {error}"
    detail = re.sub(r"(?i)\b(?:lnbc|lntb|lnbcrt)[a-z0-9]+\b", "[INVOICE]", detail)
    detail = re.sub(r"\b[0-9a-fA-F]{64}\b", "[HEX_REDACTED]", detail)
    detail = re.sub(r"(?i)(L402\s+)[^\s\"']+:[^\s\"']+", r"\1[CREDENTIAL]", detail)
    detail = re.sub(r"(https?://[^\s?\"']+)\?[^\s\"']+", r"\1?[QUERY_REDACTED]", detail)
    return detail


def lnd_pay_invoice(challenge: L402Challenge) -> str:
    """Real LND REST adapter. Wallet keys are read only when explicitly invoked."""
    url, macaroon = (
        os.environ.get("LND_REST_URL", ""),
        os.environ.get("LND_MACAROON_HEX", ""),
    )
    if not url.startswith("https://") or not re.fullmatch(r"[0-9a-fA-F]+", macaroon):
        raise ValueError(
            "Configure an HTTPS LND_REST_URL and LND_MACAROON_HEX securely"
        )
    verify = ssl.create_default_context(cafile=os.environ.get("LND_TLS_CERT") or None)
    with httpx.Client(timeout=30, verify=verify, follow_redirects=False) as wallet:
        response = wallet.post(
            url.rstrip("/") + "/v1/channels/transactions",
            headers={"Grpc-Metadata-macaroon": macaroon},
            json={"payment_request": challenge.invoice, "fee_limit": {"fixed": "5"}},
        )
        response.raise_for_status()
        result = response.json()
    if result.get("payment_error"):
        raise RuntimeError("LND could not settle the invoice")
    return base64.b64decode(result["payment_preimage"], validate=True).hex()


def add_cli_arguments(parser: argparse.ArgumentParser):
    parser.add_argument(
        "--url", default=MCP_URL, help="Remote Streamable HTTP MCP endpoint"
    )
    parser.add_argument(
        "--timeout", type=float, default=20.0, help="HTTP timeout in seconds"
    )
    parser.add_argument(
        "--max-sats", type=int, default=250, help="Maximum sats per invoice"
    )
    parser.add_argument(
        "--budget-sats", type=int, default=1000, help="Maximum invoice sats per run"
    )
    parser.add_argument(
        "--pay-hook",
        help="Explicit wallet callback module:function (never enabled by default)",
    )


def client_from_args(args) -> BitcoinStratigraphyClient:
    return BitcoinStratigraphyClient(
        args.url,
        load_payment_hook(args.pay_hook),
        args.max_sats,
        args.timeout,
        budget_sats=args.budget_sats,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_cli_arguments(parser)
    parser.add_argument("--tool", default="payment.get_info")
    parser.add_argument(
        "--arguments", default="{}", help="JSON object of tool arguments"
    )
    args = parser.parse_args()
    arguments = json.loads(args.arguments)
    if not isinstance(arguments, dict):
        parser.error("--arguments must contain a JSON object")
    with client_from_args(args) as client:
        print(json.dumps(client.call_tool(args.tool, arguments), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, ImportError, httpx.HTTPError) as exc:
        raise SystemExit(f"Error: {error_detail(exc)}") from None
