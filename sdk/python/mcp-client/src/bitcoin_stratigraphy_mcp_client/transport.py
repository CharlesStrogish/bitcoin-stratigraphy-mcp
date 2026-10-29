# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""HTTPX transport extension consumed by the official MCP Streamable HTTP client."""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .nip98 import Nip98Signer

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

DEFAULT_MCP_URL = "https://bitcoinstratigraphy.com/mcp"
_CHALLENGE = re.compile(
    r'L402\s+macaroon="([^"\r\n]+)",\s*invoice="([^"\r\n]+)"', re.IGNORECASE
)
_HEX = re.compile(r"[0-9a-fA-F]{64}")
_MAX_CHALLENGE_BYTES = 65_536


class PaymentError(RuntimeError):
    """A challenge or wallet proof was rejected; execution is not retried again."""


@dataclass(frozen=True)
class L402Challenge:
    """Untrusted invoice metadata for wallet-side approval and spend controls."""

    macaroon: str = field(repr=False)
    invoice: str = field(repr=False)
    payment_hash: str = field(repr=False)
    amount_sats: int | None = None


class WalletHandler(Protocol):
    def __call__(self, challenge: L402Challenge) -> Awaitable[str]:
        """Approve/pay the invoice and return its 32-byte preimage as hex."""
        ...


async def _challenge(response: httpx.Response) -> L402Challenge:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > _MAX_CHALLENGE_BYTES:
            raise PaymentError("L402 challenge exceeds the response size limit")
        chunks.append(chunk)
    match = _CHALLENGE.fullmatch(response.headers.get("www-authenticate", ""))
    if match is None:
        raise PaymentError("402 response does not contain an L402 challenge")
    try:
        import json

        data: object = json.loads(b"".join(chunks))
    except (ValueError, UnicodeDecodeError):
        raise PaymentError("Invalid L402 challenge JSON") from None
    if not isinstance(data, dict):
        raise PaymentError("Invalid L402 challenge object")
    payment_hash = data.get("payment_hash")
    amount = data.get("amount_sats")
    if (
        data.get("macaroon") != match[1]
        or data.get("invoice") != match[2]
        or not match[2].lower().startswith("ln")
        or not isinstance(payment_hash, str)
        or _HEX.fullmatch(payment_hash) is None
        or (amount is not None and (type(amount) is not int or amount <= 0))
    ):
        raise PaymentError("Missing or conflicting L402 challenge fields")
    return L402Challenge(match[1], match[2], payment_hash.lower(), amount)


class L402Nip98Transport(httpx.AsyncBaseTransport):
    """Extend the official MCP client's HTTPX transport, not the MCP wire format.

    Each request receives fresh NIP-98 authentication. Only an exact endpoint's
    L402 challenge can invoke the wallet, and only one paid retry is permitted.
    No automatic general-purpose retries, cross-request credentials or redirects.
    """

    def __init__(
        self,
        private_key: str,
        wallet_handler: WalletHandler,
        *,
        endpoint: str = DEFAULT_MCP_URL,
        wallet_timeout: float = 120.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._signer = Nip98Signer(private_key)
        self.endpoint = str(httpx.URL(endpoint))
        # Validate configuration before opening sockets or accepting work.
        self._signer.authorization("GET", self.endpoint)
        if wallet_timeout <= 0:
            raise ValueError("wallet_timeout must be positive")
        self._wallet = wallet_handler
        self._wallet_timeout = wallet_timeout
        self._transport = (
            transport if transport is not None else httpx.AsyncHTTPTransport()
        )
        self._payment_lock = asyncio.Lock()
        self._proofs: OrderedDict[tuple[str, str, str], str] = OrderedDict()

    async def _proof(self, challenge: L402Challenge) -> str:
        key = (challenge.payment_hash, challenge.macaroon, challenge.invoice)
        # Same-invoice concurrent responses cannot cause duplicate wallet calls.
        # Credentials are never reused for another request's different challenge.
        async with self._payment_lock:
            cached = self._proofs.get(key)
            if cached is not None:
                self._proofs.move_to_end(key)
                return cached
            preimage = await asyncio.wait_for(
                self._wallet(challenge), timeout=self._wallet_timeout
            )
            if (
                not isinstance(preimage, str)
                or _HEX.fullmatch(preimage) is None
                or hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
                != challenge.payment_hash
            ):
                raise PaymentError(
                    "Wallet preimage does not match the L402 payment hash"
                )
            self._proofs[key] = preimage.lower()
            if len(self._proofs) > 128:
                self._proofs.popitem(last=False)
            return preimage.lower()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if str(request.url) != self.endpoint:
            raise ValueError(
                "Transport refuses to sign or pay outside its exact MCP endpoint"
            )
        if (
            "authorization" in request.headers
            or "x-nostr-authorization" in request.headers
        ):
            raise ValueError("Transport owns NIP-98 and L402 authentication headers")
        body = await request.aread()
        request.headers["X-Nostr-Authorization"] = self._signer.authorization(
            request.method, str(request.url), body
        )
        response = await self._transport.handle_async_request(request)
        if response.status_code != 402:
            return response
        try:
            challenge = await _challenge(response)
        finally:
            await response.aclose()
        preimage = await self._proof(challenge)
        # Rebuild from exactly the signed bytes; do not replay an exhausted stream.
        headers = httpx.Headers(request.headers)
        headers["Authorization"] = f"L402 {challenge.macaroon}:{preimage}"
        headers["X-Nostr-Authorization"] = self._signer.authorization(
            request.method, str(request.url), body
        )
        retry = httpx.Request(
            request.method,
            request.url,
            headers=headers,
            content=body,
            extensions=dict(request.extensions),
        )
        paid_response = await self._transport.handle_async_request(retry)
        if paid_response.status_code == 402:
            await paid_response.aclose()
            raise PaymentError(
                "L402 retry rejected; wallet will not be charged again automatically"
            )
        return paid_response

    def http_client_factory(
        self,
        headers: Mapping[str, str] | None = None,
        timeout: httpx.Timeout | None = None,
        auth: httpx.Auth | None = None,
    ) -> httpx.AsyncClient:
        """Official MCP/LangChain factory hook; one transport per client lifetime."""
        if auth is not None:
            raise ValueError(
                "Do not combine L402/NIP-98 with another HTTP auth provider"
            )
        return httpx.AsyncClient(
            transport=self,
            headers=headers,
            timeout=timeout if timeout is not None else httpx.Timeout(30, read=300),
            follow_redirects=False,
        )

    @asynccontextmanager
    async def session(self) -> AsyncIterator[ClientSession]:
        """Yield an initialized official MCP ClientSession; caller owns tool calls."""
        async with self.http_client_factory() as client:
            async with streamable_http_client(self.endpoint, http_client=client) as (
                read,
                write,
                _,
            ):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    yield session

    @asynccontextmanager
    async def langchain_tools(self) -> AsyncIterator[list[BaseTool]]:
        """Load standard LangChain MCP tools while retaining the live session."""
        try:
            from langchain_mcp_adapters.tools import load_mcp_tools
        except ImportError:
            raise ImportError(
                "LangChain integration requires bitcoin-stratigraphy-mcp-client[langchain]"
            ) from None
        async with self.session() as session:
            yield await load_mcp_tools(session)

    async def aclose(self) -> None:
        self._proofs.clear()
        await self._transport.aclose()
