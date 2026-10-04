"""Offline quickstart checks; no optional frameworks, models or wallet needed."""

import asyncio
import contextlib
import importlib.util
import io
import os
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent
NAMES = [
    "stratigraphy.get", "stratigraphy.get_digest", "stratigraphy.get_diff",
    "stratigraphy.get_range", "stratigraphy.list", "proof.attenuate",
    "proof.verify", "proof.get_by_hash", "proof.list", "proof.submit",
    "proof.ground", "payment.get_info", "mesh.get_status", "mesh.broadcast",
    "proof.notarize",
]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stubs():
    state = SimpleNamespace(headers=None, calls=[], closed=False, models=0)

    class Tool:
        def __init__(self, name):
            self.name = name
            self.remote_name = name
            self.metadata = SimpleNamespace(name=name)

        def model_copy(self, update):
            result = Tool(self.remote_name)
            result.name = update["name"]
            return result

    class Transport:
        def __init__(self, url, headers):
            state.headers = headers
            state.url = url

    class Client:
        def __init__(self, transport, mode, timeout):
            assert mode == "legacy"

    class Adapter:
        def __init__(self, client):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def list_tools(self):
            return [Tool(name) for name in NAMES]

    class HTTPClient:
        async def aclose(self):
            state.closed = True

    class BasicClient:
        def __init__(self, url, headers, timeout, sse_read_timeout):
            state.url, state.headers = url, headers
            self.http_client = HTTPClient()

    class Spec:
        def __init__(self, client):
            pass

        async def to_tool_list_async(self):
            return [Tool(name) for name in NAMES]

    class Model:
        def __init__(self, model, temperature):
            state.models += 1

    class Agent:
        def __init__(self, tools, **kwargs):
            assert {getattr(t, "name") if "model" in kwargs else t.metadata.name
                    for t in tools} == {"proof_notarize", "stratigraphy_list"}
            self.tools = tools

        async def ainvoke(self, messages, config):
            assert config["recursion_limit"] == 12
            state.calls.extend(t.remote_name for t in self.tools)
            return {"messages": [SimpleNamespace(content="tool-confirmed result")]}

        async def run(self, user_msg):
            assert "Notarize this data hash" in user_msg
            state.calls.extend(t.remote_name for t in self.tools)
            return "tool-confirmed result"

    modules = {}
    for name, symbols in {
        "fastmcp.client": {"Client": Client},
        "fastmcp.client.transports": {"StreamableHttpTransport": Transport},
        "langchain.mcp": {"MCPAdapter": Adapter},
        "langchain.agents": {"create_agent": lambda **kw: Agent(**kw)},
        "langchain_openai": {"ChatOpenAI": Model},
        "llama_index.tools.mcp": {"BasicMCPClient": BasicClient, "McpToolSpec": Spec},
        "llama_index.core.agent.workflow": {"ReActAgent": Agent},
        "llama_index.llms.openai": {"OpenAI": Model},
    }.items():
        modules[name] = ModuleType(name)
        modules[name].__dict__.update(symbols)
    return state, modules


class AgentQuickstartTests(unittest.TestCase):
    def execute(self, name, args=(), env=None):
        state, modules = stubs()
        module = load(name)
        with patch.dict(os.environ, env or {}, clear=True), \
                patch.dict("sys.modules", modules), \
                patch("sys.argv", [name, *args]), \
                contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(module.main())
        return state

    def test_default_discovery_never_runs_models_or_paid_tools(self):
        for name in ("langchain_agent", "llamaindex_agent"):
            with self.subTest(name=name):
                state = self.execute(name)
                self.assertEqual(state.models, 0)
                self.assertEqual(state.calls, [])
                self.assertNotIn("Authorization", state.headers)
                if name == "llamaindex_agent":
                    self.assertTrue(state.closed)

    def test_prepaid_header_and_original_remote_names(self):
        credential = "L402 test-macaroon:" + "01" * 32
        for name in ("langchain_agent", "llamaindex_agent"):
            with self.subTest(name=name):
                state = self.execute(name, ["--run"], {
                    "L402_AUTHORIZATION": credential, "OPENAI_API_KEY": "offline-test",
                })
                self.assertEqual(state.headers["Authorization"], credential)
                self.assertEqual(state.headers["X-L402-Batch-Size"], "100")
                self.assertEqual(set(state.calls), {"proof.notarize", "stratigraphy.list"})

    def test_local_proxy_without_forwarding_direct_credentials(self):
        for name in ("langchain_agent", "llamaindex_agent"):
            with self.subTest(name=name):
                state = self.execute(name, ["--proxy-url", "http://127.0.0.1:8000/mcp"])
                self.assertEqual(state.url, "http://127.0.0.1:8000/mcp")
                self.assertNotIn("Authorization", state.headers)

    def test_rejects_bad_hash_missing_payment_and_unsafe_urls(self):
        for name in ("langchain_agent", "llamaindex_agent"):
            for args in (["--hash", "bad"], ["--run"],
                         ["--url", "http://example.com/mcp"],
                         ["--proxy-url", "https://example.com/mcp"]):
                with self.subTest(name=name, args=args), \
                        contextlib.redirect_stderr(io.StringIO()), \
                        self.assertRaises(SystemExit):
                    self.execute(name, args)


if __name__ == "__main__":
    unittest.main()