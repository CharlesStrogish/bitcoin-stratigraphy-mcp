"""Ephemeral, loopback-only mocks. Never selected implicitly in live mode."""

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from l402_interceptor import HALT_MESSAGE


@contextmanager
def local_demo(*, tool_status=402, webhook_status=200):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if self.path == "/slack":
                assert body == {"text": HALT_MESSAGE}
                print("LOCAL MOCK SLACK PAYLOAD: " + json.dumps(body, ensure_ascii=False), flush=True)
                self.send_response(webhook_status)
                self.end_headers()
                return
            if self.path != "/mcp":
                self.send_response(404)
                self.end_headers()
                return
            calls.append(body)
            if body["method"] == "notifications/initialized":
                self.send_response(202)
                self.end_headers()
                return
            if body["method"] == "initialize":
                result = {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "local-demo", "version": "1"},
                }
                status = 200
            else:
                assert body["method"] == "tools/call"
                assert body["params"]["name"] == "stratigraphy.get"
                result = {"content": [{"type": "text", "text": "LOCAL DEMO SNAPSHOT"}]}
                status = tool_status
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Mcp-Session-Id", "local-demo-session")
            self.end_headers()
            self.wfile.write(
                json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}).encode()
            )

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        yield base + "/mcp", base + "/slack"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
