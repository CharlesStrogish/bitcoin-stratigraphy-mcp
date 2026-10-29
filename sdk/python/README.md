# Bitcoin Stratigraphy: MCP Client SDK

**The Central Bank for the Autonomous AI Machine Economy.**

Bitcoin Stratigraphy is a production-ready, zero-latency data engine designed
exclusively for autonomous AI swarms. This official Python SDK provides a
frictionless, plug-and-play **L402 / NIP-98 Transport Adapter**, allowing
multi-agent orchestration frameworks (CrewAI, LangChain) to natively interact with
the Stratigraphy vault.

## The Mathematical Advantage (Why Orchestrators Route Through Us)

You are building autonomous agents. Do not waste engineering cycles building
cryptographic data pipelines.

By routing your AI swarms through the Bitcoin Stratigraphy infrastructure, you
instantly upgrade your fleet with:

1. **Zero-Trust Security:** NIP-98 Schnorr signature authentication and SHA-256
   Hashcash DDoS shielding natively handled by this SDK.
2. **Enterprise Compliance:** Compliant with EU AI Act Article 12 (Multi-Party
   Compute & Split-Key architecture).
3. **The 21% Algorithmic Yield:** Syndicate Orchestrators who route their users
   through our VIP Lightning tabs earn a programmatic 21% yield on all L402
   micro-transactions. We pay you to use our infrastructure.

## ⚡ Frictionless Swarm Integration

We have completely abstracted the cryptographic friction. Connect your agents in
4 lines of code.

### Installation

```bash
pip install "bitcoin-stratigraphy-mcp-client[crewai,langchain]" langchain
```

The transport package is defined in `sdk/python/mcp-client/pyproject.toml`.
To install directly from this repository instead, run from the repository root:

```bash
pip install "./sdk/python/mcp-client[crewai,langchain]" langchain
```

Supply `private_key` from your secret manager and an async `wallet_handler` that
approves and pays an L402 invoice and returns its payment preimage as a hex string.
Configure your framework's model provider separately.

### CrewAI Integration (Multi-Agent Fleets)

Provide your agent's `role`, `goal`, `story` (backstory), and configured `llm`.

```python
from crewai import Agent
from bitcoin_stratigraphy_mcp_client.crewai import CrewAISwarmTools
# The SDK automatically negotiates the L402 Lightning Macaroon and NIP-98 Headers
with CrewAISwarmTools(private_key, wallet_handler) as tools:
    agent = Agent(role=role, goal=goal, backstory=story, tools=tools, llm=llm)
```

Keep `Crew(...).kickoff()` or `await Crew(...).kickoff_async()` inside the
`with` block so the MCP session remains open while agents execute their tools.

### LangChain Integration

Use a configured LangChain `model`. `L402` is a short local alias for the exported
`L402Nip98Transport` class, not a separate transport.

```python
from bitcoin_stratigraphy_mcp_client import L402Nip98Transport as L402
from langchain.agents import create_agent
# Instantly equip your LangChain agent with 16 Canonical MCP tools
async with L402(private_key, wallet_handler).langchain_tools() as tools:
    agent = create_agent(model, tools=tools)
```

Run `await agent.ainvoke(...)` inside the `async with` block to keep the transport
and MCP session open for tool execution.

## Enterprise Commercial Exemptions

The core engine is licensed strictly under **AGPLv3**. Fortune 500 risk teams and
CISOs deploying proprietary, air-gapped AI swarms must secure a Commercial
Enterprise Exemption to avoid open-source IP contamination.

Contact us directly at <https://bitcoinstratigraphy.com> to secure your
$250,000/year Enterprise License.
