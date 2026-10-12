# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Verify enterprise license signatures using the embedded issuer public key."""

import base64
import json
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization


PUBLIC_KEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMMwfSPCQgPG0HamuFsu+wi4lxQMq2bDLmtFeiXRaeZo=
-----END PUBLIC KEY-----
"""


def verify_license(license_path):
    public_key = serialization.load_pem_public_key(PUBLIC_KEY_PEM)

    with open(license_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    payload = data["payload"]
    signature = base64.b64decode(data["signature_ed25519"])
    canonical_bytes = json.dumps(
        payload, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")

    # Cryptographic signature check. Invalid signatures raise InvalidSignature.
    public_key.verify(signature, canonical_bytes)

    # Expiration check.
    expiry = datetime.strptime(
        payload["expires_utc"], "%Y-%m-%dT%H:%M:%SZ"
    ).replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) > expiry:
        print("License expired.")
        return False

    print(f"License authentic for {payload['client']}.")
    return True
