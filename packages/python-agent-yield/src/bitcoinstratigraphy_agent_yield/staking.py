"""Yield selection and Nostr BIP-340 identity, separate from Ed25519 receipts."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

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
