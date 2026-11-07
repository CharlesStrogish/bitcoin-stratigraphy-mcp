"""Opt-in yield staking on the pinned public agent-yield SDK.

NIP-98 requests use Nostr BIP-340 signatures. Server payload attestations keep
their separate, independently pinned Ed25519 verification.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx
from bitcoinstratigraphy_agent_yield import (
    FiduciaryClient,
    FiduciaryError,
    TruthReceipt,
)
from bitcoinstratigraphy_agent_yield.protocol import PROTOCOL_VERSION, read_rpc
from bitcoinstratigraphy_agent_yield.provenance import verify_payload
from coincurve import PrivateKey

ESCROW_TOOL = "payment.get_escrow"


class Nip98Signer:
    """Sign each exact HTTP attempt without printing or persisting its key."""

    def __init__(self, private_key: str, *, clock=time.time):
        if not re.fullmatch(r"[0-9a-fA-F]{64}", private_key):
            raise ValueError(
                "STRATIGRAPHY_NOSTR_PRIVATE_KEY must be a 32-byte hex key."
            )
        try:
            self._key = PrivateKey(bytes.fromhex(private_key))
        except ValueError:
            raise ValueError("Invalid STRATIGRAPHY_NOSTR_PRIVATE_KEY.") from None
        self._clock = clock

    @property
    def public_key(self) -> str:
        return self._key.public_key.format(compressed=True)[1:].hex()

    def headers(self, url: str, method: str, body: bytes) -> dict[str, str]:
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            raise ValueError(
                "NIP-98 requires an HTTPS URL without credentials or fragment."
            )
        if not re.fullmatch(r"[A-Za-z]+", method):
            raise ValueError("Invalid NIP-98 HTTP method.")
        tags = [
            ["u", url],
            ["method", method.upper()],
            ["nonce", secrets.token_hex(16)],
        ]
        if body:
            tags.append(["payload", hashlib.sha256(body).hexdigest()])
        created_at = int(self._clock())
        unsigned = [0, self.public_key, created_at, 27235, tags, ""]
        digest = hashlib.sha256(
            json.dumps(unsigned, separators=(",", ":"), ensure_ascii=False).encode()
        ).digest()
        event = {
            "id": digest.hex(),
            "pubkey": self.public_key,
            "created_at": created_at,
            "kind": 27235,
            "tags": tags,
            "content": "",
            "sig": self._key.sign_schnorr(digest).hex(),
        }
        encoded = base64.b64encode(
            json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode()
        ).decode("ascii")
        return {"X-Nostr-Authorization": "Nostr " + encoded}


@dataclass(frozen=True)
class YieldSettings:
    mode: str = "withdraw"
    signer: Nip98Signer | None = field(default=None, repr=False)

    def __post_init__(self):
        if self.mode not in ("stake", "withdraw"):
            raise ValueError("STRATIGRAPHY_YIELD_MODE must be stake or withdraw.")
        if self.mode == "stake" and self.signer is None:
            raise ValueError("Set STRATIGRAPHY_NOSTR_PRIVATE_KEY before staking.")

    @classmethod
    def from_env(cls) -> YieldSettings:
        mode = os.getenv("STRATIGRAPHY_YIELD_MODE", "withdraw").strip()
        key = os.getenv("STRATIGRAPHY_NOSTR_PRIVATE_KEY", "").strip()
        signer = Nip98Signer(key) if key and not key.startswith("paste_") else None
        return cls(mode=mode, signer=signer)


class _StakingWallet:
    """Expose spending, but no receiving-invoice capability to the legacy SDK.

    Its supported optional-wallet contract skips withdrawal claims when
    make_invoice is absent. Staking must never request both a stake and a payout.
    """

    def __init__(self, wallet):
        self._wallet = wallet

    def pay_invoice(self, bolt11):
        return self._wallet.pay_invoice(bolt11)


class YieldStakingClient(FiduciaryClient):
    """Backward-compatible client plus an authenticated, never-paid lookup."""

    def __init__(self, *, yield_settings: YieldSettings | None = None, **options):
        self.yield_settings = yield_settings or YieldSettings.from_env()
        headers = httpx.Headers(options.pop("headers", None) or {})
        headers["X-Yield-Mode"] = self.yield_settings.mode
        options["headers"] = headers
        if self.yield_settings.signer:
            if options.get("identity_headers") is not None:
                raise ValueError("Configure one NIP-98 identity signer, not two.")
            options["identity_headers"] = self.yield_settings.signer.headers
        if self.yield_settings.mode == "stake" and options.get("wallet") is not None:
            options["wallet"] = _StakingWallet(options["wallet"])
        super().__init__(**options)

    def _send(self, url, body, headers):
        # Include the selection on discovery, admission retries, paid retries,
        # and legacy withdrawal claims, not just the initial MCP request.
        headers = httpx.Headers(headers)
        headers["X-Yield-Mode"] = self.yield_settings.mode
        return super()._send(url, body, headers)

    def list_tools(self):
        catalog = super().list_tools()
        if self.yield_settings.mode == "stake" and not any(
            tool["name"] == ESCROW_TOOL for tool in catalog
        ):
            # Older servers may ignore the new mode header. Never pay one
            # while silently assuming the received yield was staked.
            raise FiduciaryError("SERVER_DOES_NOT_SUPPORT_YIELD_STAKING")
        return catalog

    def get_escrow(self) -> dict:
        """MCP POST, empty arguments, fresh NIP-98; no wallet or budget debit.

        Use the pinned SDK's bounded transport and Ed25519 verifier, but not its
        automatic L402 payment path: this read-only utility must never buy access.
        """
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
        return super().call_tool(name, arguments)
