# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Native CrewAI tests: real BaseTool/MCP session, mocked HTTP, no funded wallet."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from typing import Any
from unittest.mock import patch

import httpx
from mcp.types import Tool
from pydantic import ValidationError

if importlib.util.find_spec("crewai") is None:
    raise unittest.SkipTest(
        "Install the optional crewai extra to run native CrewAI tests"
    )

from crewai.tools import BaseTool

from bitcoin_stratigraphy_mcp_client import L402Challenge, PaymentError
from bitcoin_stratigraphy_mcp_client.crewai import (
    CrewAIMCPTool,
    CrewAISwarmTools,
    CrewAIToolError,
)

# Public, unfunded fixture credentials only.
KEY = "00" * 31 + "01"
PREIMAGE = "ab" * 32
HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()
SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "height": {"type": "integer", "minimum": 1},
        "options": {
            "type": "object",
            "properties": {"mode": {"enum": ["compact", "full"]}},
            "required": ["mode"],
            "additionalProperties": False,
        },
    },
    "required": ["height"],
    "additionalProperties": False,
}


class Server(httpx.MockTransport):
    def __init__(
        self,
        *,
        paid: bool = False,
        error: bool = False,
        names: list[str] | None = None,
        repeat_cursor: bool = False,
    ) -> None:
        self.paid, self.error = paid, error
        self.names = names if names is not None else ["stratigraphy.get"]
        self.repeat_cursor = repeat_cursor
        self.requests: list[httpx.Request] = []
        self.executions: list[dict[str, Any]] = []
        self.closed = False
        super().__init__(self.respond)

    def respond(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        message = json.loads(request.content)
        if "id" not in message:
            return httpx.Response(202)
        method = message["method"]
        if method == "initialize":
            result: dict[str, Any] = {
                "protocolVersion": message["params"]["protocolVersion"],
                "serverInfo": {"name": "offline-crewai-fixture", "version": "1"},
                "capabilities": {"tools": {}},
            }
        elif method == "tools/list":
            result = {
                "tools": [
                    {
                        "name": name,
                        "description": "Fixture snapshot",
                        "inputSchema": SCHEMA,
                    }
                    for name in self.names
                ]
            }
            if self.repeat_cursor:
                result["nextCursor"] = "same-page"
        elif method == "tools/call":
            if self.paid and "authorization" not in request.headers:
                return httpx.Response(
                    402,
                    headers={
                        "WWW-Authenticate": 'L402 macaroon="fixture", invoice="lnbc-fixture"'
                    },
                    json={
                        "macaroon": "fixture",
                        "invoice": "lnbc-fixture",
                        "payment_hash": HASH,
                        "amount_sats": 24,
                    },
                )
            self.executions.append(message["params"])
            result = {
                "content": [{"type": "text", "text": "Fixture snapshot"}],
                "structuredContent": {
                    "height": message["params"]["arguments"]["height"]
                },
                "isError": self.error,
            }
        else:
            raise AssertionError(f"Unexpected MCP method {method}")
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": message["id"], "result": result}
        )

    async def aclose(self) -> None:
        self.closed = True
        await super().aclose()


async def no_payment(challenge: L402Challenge) -> str:
    raise AssertionError("No wallet payment expected")


class CrewAITests(unittest.TestCase):
    def test_native_base_tool_and_agent_acceptance(self) -> None:
        from crewai import Agent, BaseLLM

        class OfflineLLM(BaseLLM):
            def call(self, *args: Any, **kwargs: Any) -> str:
                return "Offline fixture"

        server = Server()
        with patch.dict(os.environ, {"OTEL_SDK_DISABLED": "true"}):
            with CrewAISwarmTools(KEY, no_payment, transport=server) as tools:
                self.assertIsInstance(tools[0], BaseTool)
                self.assertEqual(tools[0].name, "stratigraphy_get")
                self.assertEqual(tools[0].args_schema.model_json_schema(), SCHEMA)
                self.assertIn('"minimum": 1', tools[0].description)
                agent = Agent(
                    role="Treasury auditor",
                    goal="Inspect snapshots",
                    backstory="Offline test auditor",
                    tools=tools,
                    llm=OfflineLLM(model="offline-fixture"),
                    allow_delegation=False,
                )
                self.assertIs(agent.tools[0], tools[0])
                self.assertFalse(tools[0].cache_function({}, {}))
        self.assertTrue(server.closed)

    def test_sync_paid_execution_reuses_existing_signer_and_wallet_flow(self) -> None:
        server = Server(paid=True)
        invoices: list[L402Challenge] = []

        async def wallet(challenge: L402Challenge) -> str:
            invoices.append(challenge)
            return PREIMAGE

        with CrewAISwarmTools(KEY, wallet, transport=server) as tools:
            result = json.loads(
                tools[0].to_structured_tool().invoke({"height": 840000})
            )
            self.assertEqual(result["structuredContent"], {"height": 840000})
            self.assertEqual(result["content"][0]["text"], "Fixture snapshot")
        self.assertEqual(len(invoices), 1)
        self.assertEqual(invoices[0].invoice, "lnbc-fixture")
        self.assertEqual(invoices[0].macaroon, "fixture")
        self.assertEqual(invoices[0].amount_sats, 24)
        self.assertEqual(server.executions[0]["name"], "stratigraphy.get")
        calls = [
            r
            for r in server.requests
            if json.loads(r.content)["method"] == "tools/call"
        ]
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].content, calls[1].content)
        self.assertEqual(calls[1].headers["authorization"], f"L402 fixture:{PREIMAGE}")
        events = [
            json.loads(base64.b64decode(r.headers["x-nostr-authorization"][6:]))
            for r in calls
        ]
        self.assertNotEqual(events[0]["id"], events[1]["id"])
        for event in events:
            self.assertEqual(
                dict(event["tags"])["payload"],
                hashlib.sha256(calls[0].content).hexdigest(),
            )

    def test_invalid_nested_required_and_extra_arguments_never_reach_mcp(self) -> None:
        server = Server()
        with CrewAISwarmTools(KEY, no_payment, transport=server) as tools:
            for invalid in (
                {},
                {"height": 0},
                {"height": 1, "extra": True},
                {"height": 1, "options": {"mode": "invalid"}},
            ):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    tools[0].to_structured_tool().invoke(invalid)
        self.assertEqual(server.executions, [])

    def test_local_schema_references_are_preserved_and_validated(self) -> None:
        schema = {
            "type": "object",
            "$defs": {"height": {"type": "integer", "minimum": 1}},
            "properties": {"height": {"$ref": "#/$defs/height"}},
            "required": ["height"],
        }
        tool = CrewAIMCPTool(
            Tool(name="fixture.read", inputSchema=schema),
            lambda arguments: json.dumps(arguments),
        )
        self.assertEqual(tool.args_schema.model_json_schema(), schema)
        self.assertEqual(json.loads(tool._run(height=3)), {"height": 3})
        with self.assertRaises(ValidationError):
            tool._run(height=0)

    def test_external_schema_references_are_rejected_without_network(self) -> None:
        with self.assertRaisesRegex(ValueError, "local JSON Schema"):
            CrewAIMCPTool(
                Tool(
                    name="fixture.read",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "value": {"$ref": "https://example.invalid/schema"}
                        },
                    },
                ),
                lambda arguments: "",
            )

    def test_error_result_is_not_success_and_context_closes(self) -> None:
        server = Server(error=True)
        with CrewAISwarmTools(KEY, no_payment, transport=server) as tools:
            with self.assertRaises(CrewAIToolError):
                tools[0]._run(height=1)
        self.assertTrue(server.closed)

    def test_tools_cannot_execute_after_context_or_context_reenter(self) -> None:
        server = Server()
        context = CrewAISwarmTools(KEY, no_payment, transport=server)
        with context as tools:
            tools[0]._run(height=1)
        count = len(server.requests)
        with self.assertRaisesRegex(RuntimeError, "active swarm context"):
            tools[0]._run(height=2)
        with self.assertRaisesRegex(RuntimeError, "new CrewAISwarmTools"):
            context.__enter__()
        self.assertEqual(len(server.requests), count)
        self.assertTrue(server.closed)

    def test_every_invocation_remains_live_not_cached(self) -> None:
        server = Server()
        with CrewAISwarmTools(KEY, no_payment, transport=server) as tools:
            tools[0]._run(height=1)
            tools[0]._run(height=1)
        self.assertEqual(len(server.executions), 2)

    def test_wallet_decline_and_invalid_proof_never_execute(self) -> None:
        async def decline(challenge: L402Challenge) -> str:
            raise PermissionError("Fixture budget denied")

        async def wrong(challenge: L402Challenge) -> str:
            return "cd" * 32

        for wallet, expected in ((decline, PermissionError), (wrong, PaymentError)):
            server = Server(paid=True)
            with CrewAISwarmTools(KEY, wallet, transport=server) as tools:
                with self.assertRaises(expected):
                    tools[0]._run(height=1)
            self.assertEqual(server.executions, [])
            self.assertTrue(server.closed)

    def test_failed_discovery_closes_session(self) -> None:
        for server in (Server(names=["a.b", "a_b"]), Server(repeat_cursor=True)):
            with self.assertRaises(Exception):
                with CrewAISwarmTools(KEY, no_payment, transport=server):
                    self.fail("Invalid discovery must not return tools")
            self.assertTrue(server.closed)

    def test_unrelated_exception_does_not_leak_background_session(self) -> None:
        server = Server()
        with self.assertRaises(Exception):
            with CrewAISwarmTools(KEY, no_payment, transport=server):
                raise ValueError("Caller failure")
        self.assertTrue(server.closed)

    def test_core_sdk_does_not_import_crewai(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; import bitcoin_stratigraphy_mcp_client; "
                "assert 'crewai' not in sys.modules",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class CrewAIAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_and_concurrent_native_calls_share_live_session(self) -> None:
        server = Server()
        with CrewAISwarmTools(KEY, no_payment, transport=server) as tools:
            results = await asyncio.gather(
                tools[0]._arun(height=1),
                tools[0]._arun(height=2),
                tools[0].to_structured_tool().ainvoke({"height": 3}),
            )
            self.assertEqual(
                sorted(json.loads(r)["structuredContent"]["height"] for r in results),
                [1, 2, 3],
            )
        self.assertEqual(len(server.executions), 3)
        self.assertTrue(server.closed)


if __name__ == "__main__":
    unittest.main()
