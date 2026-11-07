"""HTTPX MCP client with exact-request, bounded, durable L402 settlement."""

import asyncio
import hashlib
import json
import re
import time
import uuid
from collections.abc import Callable, Mapping
from urllib.parse import urlsplit

import httpx

from .errors import FiduciaryError
from .invoices import decode_invoice, verify_preimage
from .protocol import (
    MAX_BYTES,
    PROTOCOL_VERSION,
    error_data,
    read_rpc,
    solve_pow,
    sse_complete,
)
from .receipts import terminal_receipt
from .state import PaymentState
from .armor import SpendCircuit, TruthReceipt
from .provenance import verify_payload
from .staking import ESCROW_TOOL, YieldSettings

DEFAULT_MCP_URL = "https://bitcoinstratigraphy.com/mcp"


class FiduciaryClient:
    def __init__(
        self,
        *,
        wallet=None,
        max_payment_sats: int = 0,
        max_total_sats: int = 0,
        max_spend_sats: int = 5000,
        fee_reserve_sats: int = 10,
        state_directory: str = ".agent-yield-state",
        mcp_url: str = DEFAULT_MCP_URL,
        timeout: float = 20,
        http_client: httpx.Client | None = None,
        identity_headers: Callable | None = None,
        headers: Mapping | None = None,
        on_error: Callable | None = None,
        on_yield_claim: Callable | None = None,
        server_public_key: str | bytes | None = None,
        yield_settings: YieldSettings | None = None,
    ):
        self.yield_settings = yield_settings or YieldSettings.from_env()
        if self.yield_settings.signer is not None:
            if identity_headers is not None:
                raise ValueError("Configure one NIP-98 identity signer, not two.")
            identity_headers = self.yield_settings.signer.headers
        parts = urlsplit(mcp_url)
        if (
            parts.scheme != "https"
            or not parts.netloc
            or parts.username
            or parts.password
            or parts.fragment
            or parts.query
        ):
            raise FiduciaryError("HTTPS_MCP_URL_REQUIRED")
        for value in (max_payment_sats, max_total_sats, fee_reserve_sats):
            if type(value) is not int or not 0 <= value <= (2**53 - 1) // 1000:
                raise FiduciaryError("INVALID_SPENDING_LIMIT")
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not 0 < timeout <= 300
        ):
            raise FiduciaryError("INVALID_TIMEOUT")
        self.url = mcp_url
        self.server_public_key = server_public_key
        self.circuit = SpendCircuit(max_spend_sats)
        self.claim_url = f"{parts.scheme}://{parts.netloc}/api/claim-yield"
        self.wallet, self.timeout = wallet, timeout
        self.limit, self.total, self.fee = (
            max_payment_sats * 1000,
            max_total_sats * 1000,
            fee_reserve_sats * 1000,
        )
        self.state = PaymentState(state_directory, mcp_url)
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client(
            timeout=timeout, follow_redirects=False
        )
        self._identity = identity_headers
        self._headers = httpx.Headers(headers or {})
        self._headers["X-Yield-Mode"] = self.yield_settings.mode
        self.on_error, self.on_yield_claim = on_error, on_yield_claim
        self._catalog = None

    @staticmethod
    def _notify(callback, value):
        if callback:
            try:
                callback(value)
            except Exception:
                pass

    def close(self):
        if self._owns_http:
            self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _send(self, url, body, headers):
        # Claims, discovery and every invoice/admission retry carry the mode.
        headers = httpx.Headers(headers)
        headers["X-Yield-Mode"] = self.yield_settings.mode
        deadline = time.monotonic() + self.timeout
        request_id = json.loads(body).get("id") if url == self.url else None
        try:
            with self._http.stream(
                "POST",
                url,
                content=body,
                headers=headers,
                timeout=self.timeout,
                follow_redirects=False,
            ) as response:
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_BYTES or time.monotonic() >= deadline:
                        raise FiduciaryError("MCP_RESPONSE_LIMIT_EXCEEDED")
                    if (
                        request_id
                        and "text/event-stream"
                        in response.headers.get("content-type", "")
                        and sse_complete(data, request_id)
                        and headers.get("Mcp-Method") != "tools/call"
                    ):
                        break
                # Do not follow redirects with credentials, invoices or proofs.
                if 300 <= response.status_code < 400:
                    raise FiduciaryError("MCP_REDIRECT_REFUSED")
                return httpx.Response(
                    response.status_code,
                    headers=response.headers,
                    content=bytes(data),
                    request=response.request,
                )
        except httpx.HTTPError:
            raise FiduciaryError("MCP_HTTP_TRANSPORT_FAILED") from None

    def _identity_headers(self, body, base):
        headers = httpx.Headers(base)
        if self._identity:
            fresh = httpx.Headers(self._identity(self.url, "POST", body))
            if any(
                name not in ("authorization", "x-nostr-authorization") for name in fresh
            ):
                raise FiduciaryError("IDENTITY_SIGNER_MUST_RETURN_NIP98_ONLY")
            if any(not value.lower().startswith("nostr ") for value in fresh.values()):
                raise FiduciaryError("IDENTITY_SIGNER_MUST_RETURN_NIP98_ONLY")
            authorization = headers.get("authorization", "")
            if authorization and not authorization.lower().startswith("nostr "):
                # A signer may add attribution, never replace caller credentials.
                nostr = fresh.pop("authorization", None)
                if nostr:
                    fresh["X-Nostr-Authorization"] = nostr
            headers.update(fresh)
        return headers

    def _admitted(self, body, base):
        headers = self._identity_headers(body, base)
        response = self._send(self.url, body, headers)
        if response.status_code == 400:
            details = error_data(response)
            if isinstance(details, dict) and details.get("proof_of_work"):
                headers.update(solve_pow(details["proof_of_work"]))
                headers = self._identity_headers(body, headers)
                response = self._send(self.url, body, headers)
        return response, headers

    def _payment(self, response, body, base):
        header = response.headers.get("www-authenticate", "")
        if len(header) > 24_000 or re.search(r"[\x00-\x1f\x7f]", header):
            raise FiduciaryError("INVALID_L402_HEADER")
        challenge = re.fullmatch(
            r'L402\s+macaroon="([^"\\]+)",\s*invoice="([^"\\]+)"', header, re.IGNORECASE
        )
        if not challenge:
            raise FiduciaryError("UNSUPPORTED_L402_CHALLENGE")
        macaroon, bolt11 = challenge.groups()
        invoice = decode_invoice(bolt11)
        quote = error_data(response)
        if (
            not isinstance(quote, dict)
            or quote.get("macaroon") != macaroon
            or quote.get("invoice") != bolt11
            or quote.get("payment_hash") != invoice.payment_hash
            or type(quote.get("amount_sats")) is not int
            or quote["amount_sats"] * 1000 != invoice.amount_msats
        ):
            raise FiduciaryError("QUOTE_MISMATCH")
        if invoice.expires_at <= time.time() + self.timeout + 5:
            raise FiduciaryError("INVOICE_EXPIRED_OR_TOO_CLOSE")
        if self.wallet is None or not callable(
            getattr(self.wallet, "pay_invoice", None)
        ):
            raise FiduciaryError("AUTHORIZED_WALLET_REQUIRED")
        binding_headers = sorted(
            (k, v)
            for k, v in base.multi_items()
            if k not in ("authorization", "x-nostr-authorization")
        )
        binding = hashlib.sha256(
            f"POST\n{self.url}\n".encode() + body + json.dumps(binding_headers).encode()
        ).hexdigest()
        release = self.circuit.reserve(
            invoice.payment_hash, invoice.amount_msats + self.fee
        )
        try:
            record = self.state.reserve(
                invoice.payment_hash,
                binding,
                bolt11,
                macaroon,
                invoice.amount_msats,
                self.fee,
                self.limit,
                self.total,
            )
        except BaseException:
            if release:
                release()  # No wallet operation has started.
            raise
        if record:
            if release:
                release()
            preimage = record["preimage"]
        else:
            try:
                payment = self.wallet.pay_invoice(bolt11)
            except Exception:
                raise FiduciaryError("PAYMENT_UNCERTAIN_DO_NOT_REPAY") from None
            preimage = payment.get("preimage") if isinstance(payment, dict) else None
            if not verify_preimage(preimage, invoice.payment_hash):
                raise FiduciaryError("PAYMENT_PROOF_INVALID_DO_NOT_REPAY")
            self.state.paid(
                invoice.payment_hash,
                preimage.lower(),
                payment.get("fees_paid"),
                self.fee,
            )
            fees = payment.get("fees_paid")
            if type(fees) is int and fees >= 0:
                self.circuit.settle(invoice.payment_hash, invoice.amount_msats + fees)
        if not verify_preimage(preimage, invoice.payment_hash):
            raise FiduciaryError("STORED_PROOF_INVALID")
        if invoice.expires_at <= time.time():
            raise FiduciaryError("PAID_INVOICE_EXPIRED_RECOVER_PROOF")
        # Fresh NIP-98 identity covers the identical body on every attempt.
        headers = self._identity_headers(body, base)
        if headers.get("authorization", "").lower().startswith("nostr "):
            headers["X-Nostr-Authorization"] = headers["Authorization"]
        headers["Authorization"] = f"L402 {macaroon}:{preimage}"
        return self._send(self.url, body, headers), invoice.payment_hash

    def _rpc(self, method, params):
        if method == "tools/call":
            self.circuit.assert_capacity()
        request_id = uuid.uuid4().hex
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": {
                    **params,
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            },
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
        if len(body) > 1024 * 1024:
            raise FiduciaryError("MCP_REQUEST_TOO_LARGE")
        headers = httpx.Headers(self._headers)
        headers.update(
            {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": PROTOCOL_VERSION,
                "Mcp-Method": method,
            }
        )
        if method == "tools/call":
            headers["Mcp-Name"] = params["name"]
        response, headers = self._admitted(body, headers)
        payment_hash = None
        # Discovery cannot spend. Existing caller credentials must not be
        # replaced by a new invoice or disguised as a free-grant fallback.
        credential = headers.get("authorization", "")
        if (
            response.status_code == 402
            and method == "tools/call"
            and (not credential or credential.lower().startswith("nostr "))
            and not headers.get("PAYMENT-SIGNATURE")
            and not headers.get("X-Payment")
            and response.headers.get("www-authenticate", "").lower().startswith("l402 ")
        ):
            response, payment_hash = self._payment(response, body, headers)
        if method == "tools/call" and response.is_success:
            verify_payload(response, body, self.server_public_key)
        result = read_rpc(response, request_id)
        return result, payment_hash

    def list_tools(self):
        if self._catalog is not None:
            if self.yield_settings.mode == "stake" and not any(
                tool["name"] == ESCROW_TOOL for tool in self._catalog
            ):
                raise FiduciaryError("SERVER_DOES_NOT_SUPPORT_YIELD_STAKING")
            return [dict(tool) for tool in self._catalog]
        catalog, cursors, cursor = [], set(), None
        while True:
            page, _ = self._rpc("tools/list", {"cursor": cursor} if cursor else {})
            if not isinstance(page, dict) or not isinstance(page.get("tools"), list):
                raise FiduciaryError("MCP_INVALID_CATALOG")
            for tool in page["tools"]:
                if (
                    not isinstance(tool, dict)
                    or not isinstance(tool.get("name"), str)
                    or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", tool["name"])
                    or not isinstance(tool.get("inputSchema"), dict)
                    or not isinstance(tool.get("description", ""), str)
                    or any(t["name"] == tool["name"] for t in catalog)
                ):
                    raise FiduciaryError("MCP_INVALID_TOOL")
                catalog.append(dict(tool))
            cursor = page.get("nextCursor")
            if cursor is None:
                break
            if (
                not isinstance(cursor, str)
                or not cursor
                or cursor in cursors
                or len(cursors) >= 100
            ):
                raise FiduciaryError("MCP_INVALID_CURSOR")
            cursors.add(cursor)
        self._catalog = catalog
        return self.list_tools()

    def get_escrow(self) -> dict:
        """Authenticated MCP POST; never pays or consumes spending capacity."""
        signer = self.yield_settings.signer
        if signer is None:
            raise ValueError("Set STRATIGRAPHY_NOSTR_PRIVATE_KEY for escrow lookup.")
        request_id = uuid.uuid4().hex
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {
                    "name": ESCROW_TOOL,
                    "arguments": {},
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            },
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
        headers = httpx.Headers(self._headers)
        for credential in (
            "Authorization",
            "X-Nostr-Authorization",
            "PAYMENT-SIGNATURE",
            "X-Payment",
        ):
            headers.pop(credential, None)
        headers.update(
            {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "MCP-Protocol-Version": PROTOCOL_VERSION,
                "Mcp-Method": "tools/call",
                "Mcp-Name": ESCROW_TOOL,
            }
        )
        headers.update(signer.headers(self.url, "POST", body))
        # Deliberately bypass _rpc's automatic L402 payment and spend admission.
        response = self._send(self.url, body, headers)
        if response.status_code == 402:
            raise FiduciaryError("ESCROW_LOOKUP_MUST_NOT_REQUIRE_PAYMENT")
        if not response.is_success:
            raise FiduciaryError("ESCROW_LOOKUP_FAILED")
        verify_payload(response, body, self.server_public_key)
        result = read_rpc(response, request_id)
        if not isinstance(result, dict) or result.get("isError"):
            raise FiduciaryError("MCP_INVALID_ESCROW_RESULT")
        data = result.get("structuredContent")
        if (
            not isinstance(data, dict)
            or set(data) != {"pubkey", "staked_sats", "vip_status", "unlocked_features"}
            or data["pubkey"] != signer.public_key
            or type(data["staked_sats"]) is not int
            or not 0 <= data["staked_sats"] <= 2**53 - 1
            or type(data["vip_status"]) is not bool
            or data["vip_status"] != (data["staked_sats"] > 10000)
            or data["unlocked_features"] != ["zero_latency_routing"]
        ):
            raise FiduciaryError("MCP_INVALID_ESCROW_RESULT")
        return {**data, "unlocked_features": list(data["unlocked_features"])}

    def call_tool(self, name: str, arguments: dict | None = None):
        if name == ESCROW_TOOL:
            if arguments is not None and (not isinstance(arguments, dict) or arguments):
                raise FiduciaryError("ESCROW_ARGUMENTS_MUST_BE_EMPTY")
            return TruthReceipt(self.get_escrow(), provenance_verified=True)
        if name not in {tool["name"] for tool in self.list_tools()}:
            raise FiduciaryError("MCP_UNKNOWN_TOOL")
        if arguments is not None and not isinstance(arguments, dict):
            raise FiduciaryError("MCP_ARGUMENTS_MUST_BE_OBJECT")
        result, payment_hash = self._rpc(
            "tools/call", {"name": name, "arguments": arguments or {}}
        )
        if not isinstance(result, dict):
            raise FiduciaryError("MCP_INVALID_TOOL_RESULT")
        if result.get("isError"):
            raise FiduciaryError("MCP_TOOL_FAILED")
        if payment_hash:
            try:
                self._claim(payment_hash)
            except Exception:
                self._notify(self.on_error, {"code": "YIELD_CLAIM_RECOVERY_REQUIRED"})
        return TruthReceipt(
            result.get("structuredContent", result.get("content", result)),
            self.state.payment(payment_hash) if payment_hash else None,
            provenance_verified=True,
        )

    async def acall_tool(self, name, arguments=None):
        """Native async entry point; blocking wallet adapters stay off the event loop."""
        return await asyncio.to_thread(self.call_tool, name, arguments)

    def _claim(self, payment_hash):
        if self.yield_settings.mode == "stake":
            return  # The server reserves this yield; never request it a second time.
        if not callable(getattr(self.wallet, "make_invoice", None)):
            return
        record = self.state.begin_claim(payment_hash)
        if not record:
            return
        amount = record["amount"] * 21 // 100
        terminal_receipt("allocated", amount, self.circuit.remaining_msats)
        if amount <= 0:
            raise FiduciaryError("CLAIM_TOO_SMALL")
        made = self.wallet.make_invoice(amount)
        text = made.get("invoice") if isinstance(made, dict) else made
        receiving = decode_invoice(text)
        if receiving.amount_msats != amount or receiving.expires_at <= time.time() + 30:
            raise FiduciaryError("RECEIVING_INVOICE_MISMATCH")
        body = {"macaroons": [record["macaroon"]], "bolt11_invoice": text}
        self.state.prepare_claim(payment_hash, body)
        self._post_claim(payment_hash, body, amount)

    def _post_claim(self, payment_hash, body, amount):
        response = self._send(
            self.claim_url,
            json.dumps(body, separators=(",", ":")).encode(),
            {"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            claim = response.json()
        except ValueError:
            claim = {}
        settled = (
            response.status_code == 200
            and isinstance(claim, dict)
            and claim.get("status") == "SETTLED"
            and claim.get("payment_sent") is True
        )
        pending = (
            response.status_code == 202
            and isinstance(claim, dict)
            and claim.get("status") == "PENDING"
        )
        status = "settled" if settled else "pending" if pending else "recovery_required"
        changed = self.state.finish_claim(payment_hash, status)
        if not changed:
            return
        if settled:
            terminal_receipt("settled", amount, self.circuit.remaining_msats)
        self._notify(
            self.on_yield_claim, {"status": status, "amount_msats": str(amount)}
        )

    def recover_claim(self, payment_hash):
        """Replay only a persisted receiving invoice; never purchase a tool again."""
        if not isinstance(payment_hash, str) or not re.fullmatch(
            r"[0-9a-f]{64}", payment_hash
        ):
            raise FiduciaryError("INVALID_PAYMENT_HASH")
        record = self.state.claim(payment_hash)
        if record["claim_status"] != "settled":
            self._post_claim(
                payment_hash,
                json.loads(record["claim_body"]),
                record["amount"] * 21 // 100,
            )


class YieldStakingClient(FiduciaryClient):
    """Explicit staking-capable name; FiduciaryClient has the same native support."""
