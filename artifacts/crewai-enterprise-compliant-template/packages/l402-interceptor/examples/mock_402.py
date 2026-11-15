"""Local proof: mock MCP 402 -> real loopback webhook POST -> clean halt."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from l402_interceptor import HALT_MESSAGE, L402Interceptor, SwarmHalted

payloads = []


class MockServer(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/mcp":
            self.send_response(402)
            self.end_headers()
            self.wfile.write(b'{"error":"Payment Required"}')
        elif self.path == "/slack":
            payload = json.loads(body)
            payloads.append(payload)
            print("Captured Slack webhook payload:")
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_args):
        pass


def main():
    payloads.clear()
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    interceptor = L402Interceptor(base + "/slack", allow_local_http=True)
    try:
        try:
            interceptor.request("POST", base + "/mcp", json={"method": "tools/call"})
        except SwarmHalted as halted:
            assert halted.status_code == 402
            assert halted.code == 1
        else:
            raise AssertionError("The mock 402 did not halt the swarm")
        assert payloads == [{"text": HALT_MESSAGE}]
        assert interceptor.notification_sent
        print("PASS: mock 402 caught; exact Slack payload delivered; swarm halted.")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
