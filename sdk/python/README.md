# Bitcoin Stratigraphy: MCP Client SDK 
**The Central Bank for the Autonomous AI Machine Economy.**

Bitcoin Stratigraphy is a production-ready, zero-latency data engine designed exclusively for autonomous AI swarms. This official Python SDK provides a frictionless, plug-and-play **L402 / NIP-98 Transport Adapter**, allowing multi-agent orchestration frameworks (CrewAI, LangChain) to natively interact with the Stratigraphy vault.

## The Mathematical Advantage (Why Orchestrators Route Through Us)
You are building autonomous agents. Do not waste engineering cycles building cryptographic data pipelines. 

By routing your AI swarms through the Bitcoin Stratigraphy infrastructure, you instantly upgrade your fleet with:
1. **Zero-Trust Security:** NIP-98 Schnorr signature authentication and SHA-256 Hashcash DDoS shielding natively handled by this SDK.
2. **Enterprise Compliance:** Compliant with EU AI Act Article 12 (Multi-Party Compute & Split-Key architecture).
3. **The 21% Algorithmic Yield:** Syndicate Orchestrators who route their users through our VIP Lightning tabs earn a programmatic 21% yield on all L402 micro-transactions. We pay you to use our infrastructure.

## ⚡ Frictionless Swarm Integration
We have completely abstracted the cryptographic friction. Connect your agents in 4 lines of code.

### Installation
pip install bitcoin-stratigraphy-mcp-client

### CrewAI Integration (Multi-Agent Fleets)
from stratigraphy.mcp import CrewAITransport

# The SDK automatically negotiates the L402 Lightning Macaroon and NIP-98 Headers
stratigraphy_tool = CrewAITransport(vip_key="YOUR_NIP98_PRIVATE_KEY")
my_agent = Agent(role='Data Analyst', tools=[stratigraphy_tool])

### LangChain Integration
from stratigraphy.mcp import LangChainTransport

# Instantly equip your LangChain agent with 16 Canonical MCP tools
stratigraphy_toolkit = LangChainTransport(vip_key="YOUR_NIP98_PRIVATE_KEY")
agent_executor = create_react_agent(llm, tools=stratigraphy_toolkit.get_tools())

## Enterprise Commercial Exemptions
The core engine is licensed strictly under **AGPLv3**. Fortune 500 risk teams and CISOs deploying proprietary, air-gapped AI swarms must secure a Commercial Enterprise Exemption to avoid open-source IP contamination. 

Contact us directly at https://bitcoinstratigraphy.com to secure your $250,000/year Enterprise License.
