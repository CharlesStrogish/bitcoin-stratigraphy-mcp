Please create/update `README.md` in the project root with the following comprehensive, mobile-optimized documentation. Use clean bulleted definition lists for the tool directory rather than multi-column tables to avoid text overlap on mobile renders.

---

# Bitcoin Stratigraphy MCP Server

[![Glama TDQS](https://img.shields.io/badge/Glama-Grade%20A%20%284.4%2F5.0%29-emerald)](https://glama.ai/mcp/connectors)
[![Smithery Rating](https://img.shields.io/badge/Smithery-100%2F100-brightgreen)](https://smithery.ai)
[![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2024--11--25-orange)](https://modelcontextprotocol.io)
[![L402 Enabled](https://img.shields.io/badge/Monetization-L402%20Lightning-yellow)](https://l402.org)

Enterprise L402 data vending engine serving real-time thermodynamic Bitcoin telemetry, Groth16 ZK-SNARK verification, Nostr P2P mesh consensus, and agent context state grounding to autonomous AI swarms and LLM pipelines across **14 production tools**.

---

## Architecture Overview

```text
===================================================================================================
                       AUTONOMOUS AI SWARMS & LLM AGENT CLIENTS
            (Claude, GPT-4, Perplexity, Autonomous Swarms, Custom MCP Runners)
===================================================================================================
                                         │
                     1. Protocol Discovery & L402 Handshake
                     (Streamable HTTP / /.well-known/mcp.json)
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              L402 API GATEWAY & MACAROON ENGINE                                 │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│  • Pricing Discovery (/api/v1/cost)         • Caveat Scoping Evaluator (TTL, Rate-Limits)      │
│  • Lightning LSAT Invoice Generator         • Preimage & Cryptographic Verification            │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              MCP TOOL ROUTER (14 Verified Tools)                                │
├──────────────────────────┬──────────────────────────┬──────────────────────┬────────────────────┤
│     stratigraphy.*       │         proof.*          │        mesh.*        │     payment.*      │
├──────────────────────────┼──────────────────────────┼──────────────────────┼────────────────────┤
│ • get_latest             │ • verify_zk_proof        │ • get_topology       │ • get_cost         │
│ • get_range              │ • verify_ots_receipt     │ • verify_quorum      │ • mint_macaroon    │
│ • get_diff               │ • ground_agent_context   │ • publish_telemetry  │ • attenuate_caveat │
│ • query_strata_digest    │ • verify_drift_proof     │ • get_provenance     │                    │
└──────────────────────────┴──────────────────────────┴──────────────────────┴────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              CRYPTOGRAPHIC & TELEMETRY SUBSYSTEMS                               │
├──────────────────────────┬──────────────────────────┬───────────────────────────────────────────┤
│    422 Strata DB Store   │    Groth16 BN254 Engine  │        Nostr P2P Relay Network            │
├──────────────────────────┼──────────────────────────┼───────────────────────────────────────────┤
│ • Thermodynamic Signal   │ • Poseidon Circuits      │ • NIP-01 Event Telemetry Broadcasting      │
│ • Strata Delta Engine    │ • Zero-Knowledge Drift   │ • NIP-78 Peer Topology Storage            │
│ • LLM Context Compression│ • Context State Hash     │ • Multi-Node Consensus Quorum Tracking    │
└──────────────────────────┴──────────────────────────┴───────────────────────────────────────────┤
                                         │
                                         ▼
===================================================================================================
                               BITCOIN SETTLEMENT & ANCHOR LAYER
     • Lightning Network (L402 Sat Micropayments)  • OpenTimestamps (Bitcoin Header Receipts)
===================================================================================================
