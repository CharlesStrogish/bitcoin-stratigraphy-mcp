# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Payment-path and HTTP transport checks without a live wallet or external server."""

import hashlib
import json
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sdk.python.client import BitcoinStratigraphyClient


PREIMAGE = "11" * 32
HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()
MACAROON = "bound-macaroon"
INVOICE = "lnbc123test"
HEADER = f'L402 macaroon="{MACAROON}", invoice="{INVOICE}"'
CHALLENGE = json.dumps(
    {
        "macaroon": MACAROON,
        "invoice": INVOICE,
        "payment_hash": HASH,
        "amount_sats": 250,
    }
).encode()


class ClientTests(unittest.TestCase):
    def test_hashcash_precedes_payment_and_retries_identical_request_once(self):
        challenge = {
            "algorithm": "sha256", "hash_input": "challenge:nonce",
            "difficulty": 2, "challenge": "server-issued-unique-challenge",
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat(),
        }
        requests = []
        wallet_calls = []
        client = BitcoinStratigraphyClient(
            "https://example.test/mcp", wallet=lambda invoice: wallet_calls.append(invoice) or PREIMAGE,
        )

        def send(body, authorization=None, proof_headers=None):
            requests.append((body, authorization, proof_headers))
            if len(requests) == 1:
                return 400, {}, json.dumps({"error": {"data": {"proof_of_work": challenge}}}).encode()
            if len(requests) == 2:
                self.assertIsNone(authorization)
                self.assertEqual(wallet_calls, [])
                nonce = proof_headers["X-L402-PoW-Nonce"]
                self.assertTrue(hashlib.sha256(f"{challenge['challenge']}:{nonce}".encode()).hexdigest().startswith("00"))
                return 402, {"WWW-Authenticate": HEADER}, CHALLENGE
            self.assertEqual(authorization, f"L402 {MACAROON}:{PREIMAGE}")
            self.assertIsNone(proof_headers, "paid verification requires no compute")
            return 200, {}, json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": {"ok": True}}}).encode()

        client._send = send
        self.assertEqual(client.call_tool("mesh.get_status", {}), {"ok": True})
        self.assertEqual(wallet_calls, [INVOICE])
        self.assertEqual(len({request[0] for request in requests}), 1)

    def test_hashcash_rejects_unbounded_and_expired_compute(self):
        for challenge in [
            {"algorithm": "sha256", "difficulty": 64, "challenge": "x", "hash_input": "challenge:nonce"},
            {"algorithm": "sha256", "difficulty": 2, "challenge": "x", "hash_input": "challenge:nonce", "expires_at": "2000-01-01T00:00:00Z"},
        ]:
            with self.assertRaises(ValueError):
                BitcoinStratigraphyClient._solve_invoice_pow(challenge)

    def test_paid_call_uses_real_http_402_header_and_retries_identical_body(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                requests.append((body, self.headers.get("Authorization")))
                if len(requests) == 1:
                    self.send_response(402)
                    self.send_header("WWW-Authenticate", HEADER)
                    data = CHALLENGE
                else:
                    self.send_response(200)
                    data = json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": 1,
                            "result": {"structuredContent": {"records": []}},
                        }
                    ).encode()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, _format, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        payments = []
        try:
            client = BitcoinStratigraphyClient(
                f"http://127.0.0.1:{server.server_port}/mcp",
                wallet=lambda invoice: (
                    payments.append(invoice) or {"preimage": PREIMAGE}
                ),
            )
            self.assertEqual(client.get_telemetry(days=1), {"records": []})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.assertEqual(payments, [INVOICE])
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0][0], requests[1][0])
        self.assertIsNone(requests[0][1])
        self.assertEqual(requests[1][1], f"L402 {MACAROON}:{PREIMAGE}")
        self.assertEqual(
            json.loads(requests[0][0])["params"],
            {"name": "stratigraphy.get", "arguments": {"days": 1}},
        )

    def test_wrong_preimage_is_never_sent(self):
        client = BitcoinStratigraphyClient(wallet=lambda _invoice: "22" * 32)
        sent = []
        client._send = lambda data, authorization=None: (
            sent.append(authorization) or (402, {"WWW-Authenticate": HEADER}, CHALLENGE)
        )
        with self.assertRaisesRegex(ValueError, "preimage does not match"):
            client.list_proofs()
        self.assertEqual(sent, [None])

    def test_missing_header_is_rejected_before_wallet_payment(self):
        payments = []
        client = BitcoinStratigraphyClient(
            wallet=lambda invoice: payments.append(invoice) or PREIMAGE
        )
        client._send = lambda _data, authorization=None: (402, {}, CHALLENGE)
        with self.assertRaisesRegex(ValueError, "WWW-Authenticate"):
            client.get_telemetry()
        self.assertEqual(payments, [])

    def test_second_402_does_not_trigger_second_payment(self):
        payments = []
        client = BitcoinStratigraphyClient(
            wallet=lambda invoice: payments.append(invoice) or PREIMAGE
        )
        client._send = lambda _data, authorization=None: (
            402,
            {"WWW-Authenticate": HEADER},
            CHALLENGE,
        )
        with self.assertRaisesRegex(RuntimeError, "not paying again"):
            client.list_stratigraphy()
        self.assertEqual(payments, [INVOICE])

    def test_all_ten_tools_are_available(self):
        seen = []
        client = BitcoinStratigraphyClient()
        client.call_tool = lambda name, arguments: seen.append((name, arguments)) or {}
        client.get_telemetry(days=1)
        client.list_stratigraphy()
        client.verify_proof("proof", {}, "key", {})
        client.get_proof_status(proof_hash="ab" * 32)
        client.list_proofs()
        client.submit_proof({}, ["1"] * 5)
        client.ground_proof("ab" * 32, "agent")
        client.issue_epistemic_receipt(
            "bafy-example", nostr_event_id="ab" * 32, context={"source": "test"}
        )
        client.get_mesh_status()
        client.broadcast_mesh_signal("2026-09-09")
        self.assertEqual(
            [name for name, _ in seen],
            [
                "stratigraphy.get",
                "stratigraphy.list",
                "proof.verify",
                "proof.get_status",
                "proof.list",
                "proof.submit",
                "proof.ground",
                "proof.issue_receipt",
                "mesh.get_status",
                "mesh.broadcast",
            ],
        )
        self.assertEqual(
            seen[7][1],
            {
                "cid": "bafy-example",
                "nostrEventId": "ab" * 32,
                "context": {"source": "test"},
            },
        )
        self.assertEqual(
            seen[-1][1],
            {
                "signalType": "telemetry_snapshot",
                "payload": {"date": "2026-09-09"},
            },
        )

    def test_proof_status_accepts_receipt_hash_as_a_selector(self):
        seen = []
        client = BitcoinStratigraphyClient()
        client.call_tool = lambda name, arguments: (
            seen.append((name, arguments))
            or {
                "status": "verified",
            }
        )

        self.assertEqual(
            client.get_proof_status(receipt_hash="cd" * 32),
            {"status": "verified"},
        )
        self.assertEqual(
            seen,
            [
                ("proof.get_status", {"receiptHash": "cd" * 32}),
            ],
        )


if __name__ == "__main__":
    unittest.main()
