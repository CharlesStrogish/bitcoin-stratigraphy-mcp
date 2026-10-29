# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Isolated, offline NIP-98 tests; no server, wallet or database dependency."""

from __future__ import annotations

import base64
import hashlib
import json
import unittest

from coincurve import PublicKeyXOnly

from bitcoin_stratigraphy_mcp_client import Nip98Signer

# Public test vector, never a real account key.
KEY = "00" * 31 + "01"
URL = "https://bitcoinstratigraphy.com/mcp?scope=swarm"


class Nip98Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.signer = Nip98Signer(KEY, clock=lambda: 1_800_000_000.0)

    def event(self, method: str = "POST", body: bytes = b'{"jsonrpc":"2.0"}') -> dict:
        header = self.signer.authorization(method, URL, body)
        self.assertTrue(header.startswith("Nostr "))
        return json.loads(base64.b64decode(header[6:], validate=True))

    def test_signature_verifies_against_canonical_nip01_event(self) -> None:
        event = self.event()
        canonical = [
            0,
            event["pubkey"],
            event["created_at"],
            event["kind"],
            event["tags"],
            event["content"],
        ]
        digest = hashlib.sha256(
            json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode()
        ).digest()
        self.assertEqual(event["id"], digest.hex())
        self.assertEqual(event["created_at"], 1_800_000_000)
        self.assertEqual(event["kind"], 27235)
        self.assertEqual(event["content"], "")
        self.assertEqual(
            event["pubkey"],
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        )
        self.assertTrue(
            PublicKeyXOnly(bytes.fromhex(event["pubkey"])).verify(
                bytes.fromhex(event["sig"]), digest
            )
        )

    def test_exact_method_url_query_and_raw_body_are_bound(self) -> None:
        body = '{"label":"財務","n": 1}\n'.encode()
        event = self.event("post", body)
        tags = dict(event["tags"])
        self.assertEqual(tags["u"], URL)
        self.assertEqual(tags["method"], "POST")
        self.assertEqual(tags["payload"], hashlib.sha256(body).hexdigest())
        self.assertNotEqual(tags["payload"], hashlib.sha256(body.strip()).hexdigest())

    def test_bodyless_get_and_delete_omit_payload_tag(self) -> None:
        for method in ("GET", "DELETE"):
            self.assertNotIn("payload", dict(self.event(method, b"")["tags"]))

    def test_identical_requests_in_same_second_have_distinct_event_ids(self) -> None:
        first, second = self.event(), self.event()
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(dict(first["tags"])["nonce"], dict(second["tags"])["nonce"])

    def test_tampering_invalidates_signature(self) -> None:
        event = self.event()
        altered_digest = hashlib.sha256(b"different request").digest()
        self.assertFalse(
            PublicKeyXOnly(bytes.fromhex(event["pubkey"])).verify(
                bytes.fromhex(event["sig"]), altered_digest
            )
        )

    def test_invalid_private_keys_rejected(self) -> None:
        for key in ("", "ab", "z" * 64, "00" * 32, "ff" * 32):
            with self.subTest(key=key), self.assertRaises(ValueError):
                Nip98Signer(key)

    def test_rejects_credential_urls_fragments_and_insecure_origins(self) -> None:
        for url in (
            "http://bitcoinstratigraphy.com/mcp",
            "/mcp",
            "https://user:password@bitcoinstratigraphy.com/mcp",
            "https://bitcoinstratigraphy.com/mcp#fragment",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.signer.authorization("POST", url)

    def test_secret_not_serialized_in_header(self) -> None:
        self.assertNotIn(KEY, json.dumps(self.event()))
        self.assertNotIn(KEY, repr(self.signer))


if __name__ == "__main__":
    unittest.main()
