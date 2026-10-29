# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""NIP-01 serialization and BIP-340 signatures for NIP-98 HTTP authentication."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
from collections.abc import Callable
from urllib.parse import urlsplit

from coincurve import PrivateKey


class Nip98Signer:
    """Sign exact HTTP URLs and body bytes without exposing the private key."""

    def __init__(
        self, private_key: str, *, clock: Callable[[], float] = time.time
    ) -> None:
        if not re.fullmatch(r"[0-9a-fA-F]{64}", private_key):
            raise ValueError("A 32-byte Schnorr private key in hex is required")
        try:
            self._key = PrivateKey(bytes.fromhex(private_key))
        except ValueError:
            raise ValueError("Invalid secp256k1 private key") from None
        self._clock = clock

    @property
    def public_key(self) -> str:
        """Return the Nostr x-only public key, never the secret scalar."""
        return self._key.public_key.format(compressed=True)[1:].hex()

    def authorization(self, method: str, url: str, body: bytes = b"") -> str:
        """Return ``Nostr <base64-event>`` for one HTTP attempt.

        A random nonce tag makes event IDs unique even for identical requests
        in the same second, including retries consumed by replay-protected APIs.
        """
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
        ):
            raise ValueError(
                "NIP-98 requires an absolute HTTPS URL without credentials or fragment"
            )
        if not re.fullmatch(r"[A-Za-z]+", method):
            raise ValueError("Invalid HTTP method")
        tags = [
            ["u", url],
            ["method", method.upper()],
            ["nonce", secrets.token_hex(16)],
        ]
        if body:
            tags.append(["payload", hashlib.sha256(body).hexdigest()])
        created_at = int(self._clock())
        unsigned = [0, self.public_key, created_at, 27235, tags, ""]
        serialized = json.dumps(
            unsigned, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        digest = hashlib.sha256(serialized).digest()
        event = {
            "id": digest.hex(),
            "pubkey": self.public_key,
            "created_at": created_at,
            "kind": 27235,
            "tags": tags,
            "content": "",
            "sig": self._key.sign_schnorr(digest).hex(),
        }
        encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        return "Nostr " + base64.b64encode(encoded).decode("ascii")
