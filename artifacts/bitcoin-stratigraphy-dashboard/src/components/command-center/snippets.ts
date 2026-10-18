// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
/**
 * Condensed from the public cookbooks served under /cookbooks/. Status wording
 * follows cookbooks/README.md and cookbooks/frameworks/README.md; do not claim
 * an install path or execution mode those documents do not support.
 */

export type FrameworkId = "langchain" | "llamaindex" | "crewai" | "autogen";

export interface FrameworkAdapter {
  id: FrameworkId;
  label: string;
  mode: string;
  status: { tone: "ready" | "paused"; label: string };
  summary: string;
  /** Present only when the framework cannot currently be installed or run. */
  statusNote?: string;
  file: string;
  snippet: string;
  /** Paths relative to the site root; rendered under the app's base URL. */
  links: readonly { label: string; path: string }[];
}

const MACRO_MACAROON_SETUP = {
  label: "Macro-Macaroon setup",
  path: "cookbooks/frameworks/README.md",
};
const L402_CLIENT = {
  label: "Shared L402 client",
  path: "cookbooks/l402_client.py",
};

const LANGCHAIN_SNIPPET = `import os

from fastmcp.client import Client
from fastmcp.client.transports import StreamableHttpTransport
from langchain.mcp import MCPAdapter

MCP_URL = "https://bitcoinstratigraphy.com/mcp"
# Prepaid, tool-scoped Macro-Macaroon from your secret store, never a prompt.
HEADERS = {
    "X-L402-Batch-Size": "100",
    "Authorization": os.environ["L402_AUTHORIZATION"],  # L402 <macaroon>:<preimage>
}


async def main() -> None:
    transport = StreamableHttpTransport(url=MCP_URL, headers=HEADERS)
    client = Client(transport, mode="legacy", timeout=30)
    async with MCPAdapter(client) as adapter:
        tools = await adapter.list_tools()  # all 16 canonical tools
        # Least privilege: the credential's tool plus free discovery.
        allowed = {"proof.notarize", "stratigraphy.list"}
        agent_tools = [
            tool.model_copy(update={"name": tool.name.replace(".", "_")})
            for tool in tools
            if tool.name in allowed
        ]`;

const LLAMAINDEX_SNIPPET = `import os

from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

MCP_URL = "https://bitcoinstratigraphy.com/mcp"
# Prepaid, tool-scoped Macro-Macaroon from your secret store, never a prompt.
HEADERS = {
    "X-L402-Batch-Size": "100",
    "Authorization": os.environ["L402_AUTHORIZATION"],  # L402 <macaroon>:<preimage>
}


async def main() -> None:
    client = BasicMCPClient(MCP_URL, headers=HEADERS, timeout=30, sse_read_timeout=60)
    try:
        tools = await McpToolSpec(client=client).to_tool_list_async()
        allowed = {"proof.notarize", "stratigraphy.list"}
        agent_tools = [tool for tool in tools if tool.metadata.name in allowed]
        for tool in agent_tools:
            # Provider-safe name; the closure still calls the dotted MCP tool.
            tool.metadata.name = tool.metadata.name.replace(".", "_")
    finally:
        await client.http_client.aclose()`;

const CREWAI_SNIPPET = `from crewai import Agent
from crewai.mcp import MCPServerHTTP
from crewai.mcp.filters import create_static_tool_filter

MCP_URL = "https://bitcoinstratigraphy.com/mcp"

# Native remote MCP, restricted to free catalog discovery.
discoverer = Agent(
    role="Bitcoin stratigraphy catalog discoverer",
    goal="Discover available stratigraphy data without requesting paid data.",
    backstory="A careful assistant limited to free catalog discovery.",
    max_iter=4,
    mcps=[
        MCPServerHTTP(
            url=MCP_URL,
            streamable=True,
            cache_tools_list=True,
            tool_filter=create_static_tool_filter(
                allowed_tool_names=["stratigraphy.list"],
            ),
        )
    ],
)
# Paid calls use BaseTool wrappers around BitcoinStratigraphyClient
# (l402_client.py), which settles each L402 challenge via your wallet hook.`;

const AUTOGEN_SNIPPET = `import asyncio
import json

from autogen_agentchat.agents import AssistantAgent
from autogen_core.tools import FunctionTool
from autogen_ext.models.openai import OpenAIChatCompletionClient
from l402_client import BitcoinStratigraphyClient  # /cookbooks/l402_client.py

# pay_invoice is your wallet hook (L402Challenge -> preimage).
# max_sats caps each payment; budget_sats caps the whole session.
client = BitcoinStratigraphyClient(
    pay_invoice=pay_invoice, max_sats=250, budget_sats=1000
)


async def stratigraphy_get(days: int = 1) -> str:
    """Paid L402 REST call: GET /api/v1/stratigraphy?days=N."""
    response = await asyncio.to_thread(
        client.request, "GET", "/api/v1/stratigraphy", params={"days": days}
    )
    response.raise_for_status()
    return json.dumps(response.json(), ensure_ascii=False)


agent = AssistantAgent(
    name="bitcoin_stratigraphy",
    model_client=OpenAIChatCompletionClient(model="gpt-4.1-mini"),
    tools=[
        FunctionTool(
            stratigraphy_get,
            name="stratigraphy_get",
            description="Paid REST query of indexed telemetry.",
        )
    ],
    reflect_on_tool_use=True,
)`;

export const FRAMEWORK_ADAPTERS: readonly FrameworkAdapter[] = [
  {
    id: "langchain",
    label: "LangChain",
    mode: "Macro-Macaroon headers",
    status: { tone: "ready", label: "Supported quickstart" },
    summary:
      "LangChain's MCPAdapter over a FastMCP Streamable HTTP transport. The prepaid credential and batch header travel as HTTP headers on every MCP request.",
    file: "cookbooks/frameworks/langchain_agent.py",
    snippet: LANGCHAIN_SNIPPET,
    links: [
      {
        label: "Full cookbook",
        path: "cookbooks/frameworks/langchain_agent.py",
      },
      MACRO_MACAROON_SETUP,
    ],
  },
  {
    id: "llamaindex",
    label: "LlamaIndex",
    mode: "Macro-Macaroon headers",
    status: { tone: "paused", label: "Install paused" },
    summary:
      "LlamaIndex's BasicMCPClient and McpToolSpec, with the same headers injected through the client.",
    statusNote:
      "LlamaIndex currently requires NLTK, which is affected by advisory GHSA-8mgp-746c-j5xp with no patched release. The source is preserved; use the LangChain quickstart meanwhile.",
    file: "cookbooks/frameworks/llamaindex_agent.py",
    snippet: LLAMAINDEX_SNIPPET,
    links: [
      {
        label: "Full cookbook",
        path: "cookbooks/frameworks/llamaindex_agent.py",
      },
      MACRO_MACAROON_SETUP,
    ],
  },
  {
    id: "crewai",
    label: "CrewAI",
    mode: "Free discovery · per-call L402",
    status: { tone: "paused", label: "Execution paused" },
    summary:
      "A native MCPServerHTTP agent limited to free discovery. Paid tools are wrapped as BaseTools around the shared L402 client.",
    statusNote:
      "CrewAI's dependency chain brings in ChromaDB releases with unresolved critical vulnerabilities. The source and free-discovery mode remain available; native and paid execution need a future safe upstream release.",
    file: "cookbooks/crewai_example.py",
    snippet: CREWAI_SNIPPET,
    links: [
      { label: "Full cookbook", path: "cookbooks/crewai_example.py" },
      L402_CLIENT,
    ],
  },
  {
    id: "autogen",
    label: "AutoGen",
    mode: "Per-call L402 over REST",
    status: { tone: "ready", label: "Supported" },
    summary:
      "A modern AgentChat AssistantAgent with a FunctionTool. Each paid REST call is settled by the shared L402 client within explicit spending caps.",
    file: "cookbooks/autogen_example.py",
    snippet: AUTOGEN_SNIPPET,
    links: [
      { label: "Full cookbook", path: "cookbooks/autogen_example.py" },
      L402_CLIENT,
    ],
  },
];
