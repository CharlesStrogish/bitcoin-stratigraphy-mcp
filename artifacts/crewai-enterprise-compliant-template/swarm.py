"""A LangChain tool-first swarm with a human authorization boundary."""

from __future__ import annotations

import argparse
import itertools
import json
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

from langchain_core.tools import tool
from l402_interceptor import L402Interceptor

from demo_services import local_demo

MCP_URL = "https://bitcoinstratigraphy.com/mcp"
PROTOCOL_VERSION = "2025-11-25"


@dataclass(frozen=True, repr=False)
class Settings:
    endpoint: str
    webhook: str
    authorization: str = ""
    demo: bool = False

    def validate(self) -> None:
        endpoint = urlsplit(self.endpoint)
        local = self.demo and endpoint.hostname == "127.0.0.1" and endpoint.scheme == "http"
        if (
            not endpoint.hostname
            or endpoint.username is not None
            or endpoint.password is not None
            or endpoint.fragment
            or (endpoint.scheme != "https" and not local)
        ):
            raise ValueError("Live MCP endpoint must be HTTPS without embedded credentials.")


class AuditMCP:
    """Small synchronous, handshake-compatible MCP client for this starter."""

    def __init__(self, settings: Settings):
        settings.validate()
        self.settings = settings
        self.gate = L402Interceptor(
            settings.webhook, allow_local_http=settings.demo, timeout=10
        )
        self.ids = itertools.count(1)
        self.headers = {
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }
        if settings.authorization:
            self.headers["Authorization"] = settings.authorization
        self.initialized = False

    def rpc(self, method: str, params: dict) -> dict:
        request_id = next(self.ids)
        response = self.gate.request(
            "POST",
            self.settings.endpoint,
            headers=self.headers,
            json={"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
        )
        headers = {key.lower(): value for key, value in response.headers.items()}
        session = headers.get("mcp-session-id")
        if session:
            self.headers["Mcp-Session-Id"] = session
        if headers.get("content-type", "").startswith("text/event-stream"):
            messages = []
            for event in response.text.replace("\r\n", "\n").split("\n\n"):
                data = "\n".join(
                    line[5:].lstrip() for line in event.splitlines() if line.startswith("data:")
                )
                if data:
                    messages.append(json.loads(data))
            message = next(
                (item for item in messages if isinstance(item, dict) and item.get("id") == request_id),
                None,
            )
        else:
            message = response.json()
        if (
            not isinstance(message, dict)
            or message.get("jsonrpc") != "2.0"
            or message.get("id") != request_id
        ):
            raise RuntimeError("Invalid or mismatched MCP JSON-RPC response.")
        if "error" in message:
            # Do not echo arbitrary upstream response bodies into logs or an LLM.
            raise RuntimeError("MCP returned a JSON-RPC error; inspect the server privately.")
        result = message.get("result")
        if not isinstance(result, dict):
            raise RuntimeError("MCP response lacks a structured result.")
        return result

    def initialize(self) -> None:
        if self.initialized:
            return
        result = self.rpc(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "enterprise-swarm-template", "version": "0.1.0"},
            },
        )
        version = result.get("protocolVersion")
        if version not in {"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}:
            raise RuntimeError("Unsupported negotiated MCP protocol.")
        self.headers["MCP-Protocol-Version"] = version
        self.gate.request(
            "POST",
            self.settings.endpoint,
            headers=self.headers,
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        )
        self.initialized = True

    def snapshot(self) -> dict:
        self.initialize()
        result = self.rpc(
            "tools/call",
            {"name": "stratigraphy.get", "arguments": {"days": 1, "limit": 1}},
        )
        if result.get("isError"):
            raise RuntimeError("MCP tool execution failed; no successful snapshot was produced.")
        return result


def run_swarm(settings: Settings, *, agent: bool = False) -> None:
    client = AuditMCP(settings)

    @tool
    def bitcoin_stratigraphy_snapshot() -> str:
        """Fetch the most recent Bitcoin Stratigraphy snapshot through the paid MCP boundary."""
        return json.dumps(client.snapshot())

    # Mandatory first task: cannot be skipped by an LLM or ordinary tool retries.
    print("Requesting stratigraphy.get through the L402 interceptor.", flush=True)
    snapshot = bitcoin_stratigraphy_snapshot.invoke({})
    print("MCP snapshot received. No credentials or snapshot body logged.", flush=True)
    if not agent:
        print("Tool-first run complete. Use --agent to extend into an LLM-driven workflow.")
        return

    if not os.environ.get("OPENAI_API_KEY"):
        raise ValueError("OPENAI_API_KEY must be configured for optional agent mode.")
    from langchain.agents import create_agent

    swarm = create_agent(
        model=os.environ.get("SWARM_MODEL", "openai:gpt-4.1-mini"),
        tools=[bitcoin_stratigraphy_snapshot],
        system_prompt=(
            "You are a human-supervised enterprise research agent. Summarize the supplied "
            "Bitcoin snapshot. Never claim legal compliance, guaranteed proof, or payment "
            "confirmation. Do not request another paid tool call unless the user asks."
        ),
    )
    swarm.invoke(
        {"messages": [{"role": "user", "content": f"Summarize this authorized snapshot: {snapshot}"}]},
        config={"recursion_limit": 6},
    )
    print("Agent task complete. Results were not copied into public logs.", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", action="store_true", help="Enable optional live LLM task.")
    args = parser.parse_args()
    mode = os.environ.get("SWARM_MODE", "demo")
    if mode == "demo":
        os.environ["LANGSMITH_TRACING"] = "false"
        os.environ["LANGCHAIN_TRACING_V2"] = "false"
        print("DEMO: local mock MCP and Slack only. No external calls.", flush=True)
        with local_demo() as (endpoint, webhook):
            run_swarm(Settings(endpoint, webhook, demo=True))
    elif mode == "live":
        webhook = os.environ.get("SWARM_WEBHOOK_URL", "").strip()
        if not webhook:
            raise ValueError("Live mode requires SWARM_WEBHOOK_URL; no request was sent.")
        run_swarm(
            Settings(
                os.environ.get("MCP_URL", MCP_URL),
                webhook,
                os.environ.get("MCP_AUTHORIZATION", ""),
            ),
            agent=args.agent,
        )
    else:
        raise ValueError("SWARM_MODE must be demo or live.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # SwarmHalted intentionally bypasses this ordinary exception handler.
        print("Swarm stopped: configuration or upstream failure. Check setup privately.", flush=True)
        raise SystemExit(1) from None
