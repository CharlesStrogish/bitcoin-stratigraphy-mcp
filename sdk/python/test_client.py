"""Payment-path and HTTP transport checks without a live wallet or external server."""

import hashlib
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sdk.python.client import BitcoinStratigraphyClient


PREIMAGE = "11" * 32
HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()
MACAROON = "bound-macaroon"
INVOICE = "lnbc123test"
HEADER = f'L402 macaroon="{MACAROON}", invoice="{INVOICE}"'
CHALLENGE = json.dumps({
    "macaroon": MACAROON, "invoice": INVOICE,
    "payment_hash": HASH, "amount_sats": 250,
}).encode()


class ClientTests(unittest.TestCase):
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
                    data = json.dumps({
                        "jsonrpc": "2.0", "id": 1,
                        "result": {"structuredContent": {"records": []}},
                    }).encode()
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
                wallet=lambda invoice: payments.append(invoice) or {"preimage": PREIMAGE},
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
        client = BitcoinStratigraphyClient(wallet=lambda invoice: payments.append(invoice) or PREIMAGE)
        client._send = lambda _data, authorization=None: (402, {}, CHALLENGE)
        with self.assertRaisesRegex(ValueError, "WWW-Authenticate"):
            client.get_telemetry()
        self.assertEqual(payments, [])

    def test_second_402_does_not_trigger_second_payment(self):
        payments = []
        client = BitcoinStratigraphyClient(wallet=lambda invoice: payments.append(invoice) or PREIMAGE)
        client._send = lambda _data, authorization=None: (
            402, {"WWW-Authenticate": HEADER}, CHALLENGE
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
        self.assertEqual([name for name, _ in seen], [
            "stratigraphy.get", "stratigraphy.list", "proof.verify",
            "proof.get_status", "proof.list", "proof.submit", "proof.ground",
            "proof.issue_receipt", "mesh.get_status", "mesh.broadcast",
        ])
        self.assertEqual(seen[7][1], {
            "cid": "bafy-example", "nostrEventId": "ab" * 32,
            "context": {"source": "test"},
        })
        self.assertEqual(seen[-1][1], {
            "signalType": "telemetry_snapshot", "payload": {"date": "2026-09-09"},
        })

    def test_proof_status_accepts_receipt_hash_as_a_selector(self):
        seen = []
        client = BitcoinStratigraphyClient()
        client.call_tool = lambda name, arguments: seen.append((name, arguments)) or {
            "status": "verified",
        }

        self.assertEqual(
            client.get_proof_status(receipt_hash="cd" * 32),
            {"status": "verified"},
        )
        self.assertEqual(seen, [
            ("proof.get_status", {"receiptHash": "cd" * 32}),
        ])


if __name__ == "__main__":
    unittest.main()