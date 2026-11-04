"""Exact HTTP-byte attestations; public keys are independently pinned by callers."""

import base64
import hashlib
import re

from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .errors import FiduciaryTamperingError


def verify_payload(response, request, public_key):
    try:
        signature = response.headers.get("X-Stratigraphy-Signature", "")
        if not public_key or not re.fullmatch(r"v1,[A-Za-z0-9+/]{86}==", signature):
            raise ValueError()
        key = load_pem_public_key(
            public_key.encode() if isinstance(public_key, str) else public_key
        )
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError()
        prefix = (
            "bitcoinstratigraphy/payload/v1\n"
            + hashlib.sha256(request).hexdigest()
            + "\n"
        ).encode()
        key.verify(
            base64.b64decode(signature[3:], validate=True), prefix + response.content
        )
    except Exception:
        raise FiduciaryTamperingError() from None
