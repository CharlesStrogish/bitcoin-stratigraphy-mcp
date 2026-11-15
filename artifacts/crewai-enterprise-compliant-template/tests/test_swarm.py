import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from l402_interceptor import HALT_MESSAGE, SwarmHalted
from demo_services import local_demo
from swarm import AuditMCP, Settings, run_swarm


class SwarmTests(unittest.TestCase):
    def test_missing_macaroon_halts_langchain_tool_and_posts_exact_alert(self):
        for status in (401, 402):
            with self.subTest(status=status), local_demo(tool_status=status) as (url, webhook):
                output = io.StringIO()
                with contextlib.redirect_stdout(output), self.assertRaises(SwarmHalted) as caught:
                    run_swarm(Settings(url, webhook, demo=True))
                self.assertEqual(caught.exception.code, 1)
                self.assertEqual(caught.exception.status_code, status)
                text = output.getvalue()
                self.assertIn(HALT_MESSAGE, text)
                self.assertIn("LOCAL MOCK SLACK PAYLOAD", text)
                self.assertNotIn("MCP snapshot received", text)

    def test_successful_handshake_and_tool_run(self):
        with local_demo(tool_status=200) as (url, webhook):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                run_swarm(Settings(url, webhook, demo=True))
            self.assertIn("MCP snapshot received", output.getvalue())
            self.assertNotIn("Swarm Halted", output.getvalue())

    def test_failed_webhook_still_halts(self):
        with local_demo(webhook_status=500) as (url, webhook):
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(SwarmHalted):
                run_swarm(Settings(url, webhook, demo=True))
            self.assertIn("Webhook delivery failed", output.getvalue())

    def test_jsonrpc_error_is_not_success(self):
        with local_demo(tool_status=200) as (url, webhook):
            client = AuditMCP(Settings(url, webhook, demo=True))
            client.initialized = True
            with patch.object(client, "rpc", return_value={"isError": True}):
                with self.assertRaises(RuntimeError):
                    client.snapshot()

    def test_live_plaintext_endpoint_is_rejected(self):
        with self.assertRaises(ValueError):
            Settings("http://example.com/mcp", "https://hooks.test").validate()

    def test_live_missing_webhook_fails_before_network(self):
        result = subprocess.run(
            [sys.executable, "swarm.py"],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "SWARM_MODE": "live", "SWARM_WEBHOOK_URL": ""},
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("configuration or upstream failure", result.stdout)
        self.assertNotIn("Requesting stratigraphy", result.stdout)

    def test_default_demo_exits_cleanly_and_ignores_inherited_credentials(self):
        result = subprocess.run(
            [sys.executable, "swarm.py"],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "SWARM_MODE": "demo", "MCP_AUTHORIZATION": "private-sentinel"},
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("LOCAL MOCK SLACK PAYLOAD", result.stdout)
        self.assertNotIn("private-sentinel", result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
