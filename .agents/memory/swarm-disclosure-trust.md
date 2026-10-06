---
name: Swarm selective-disclosure boundaries
description: Privacy and trust requirements for rolling enterprise telemetry roots and offline audit paths.
---

Selective-disclosure Merkle paths must not be marketed as zero-knowledge
proofs. Undisclosed low-entropy traces need fresh private leaf blinding.

**Why:** Sibling leaf hashes without unpredictable private salts can enable
dictionary attacks against corporate decisions or identifiers. A Merkle path
reveals the selected trace, position, size and sibling commitments; it is not
a ZK protocol.

**How to apply:** Export only the selected trace's blinding material. Keep
other trace plaintext and salts private. Preserve clear structural-metadata
and authenticated-source/completeness limitations.

Local Merkle membership, recorder authority, and Bitcoin confirmation are
separate trust findings.

**Why:** A sealed local root can establish membership before any Bitcoin
anchor exists, and a self-declared recorder key cannot establish corporate
authority. A pending calendar is not Bitcoin inclusion.

**How to apply:** Pin independently enrolled recorder keys and use independently
validated mainnet evidence for Bitcoin confirmation. Do not turn a successful
Merkle check into a blanket anchored/enterprise-authorized verdict.

Enterprise SDK and simulator work must preserve the 15 canonical MCP tools,
schemas and live API contracts. The user authorized migrating enterprise
cookbooks into a distributable package while preserving legacy behavior.

**Why:** The user repeated the core-contract guardrail and specifically requested
SDK packaging without breaking the existing cookbook tests.

**How to apply:** Keep old imports/CLI paths compatible during packaging changes.
Do not rewrite engine tool definitions or routes to support the simulator.
Maintain the zero-vulnerability dependency baseline.

The public Swarm Flight Simulator is a browser-only demonstration for enterprise
CISOs, with real Merkle hashing but simulated financial/OTS events.

**Why:** The user requested a visual mock of the swarm and batch anchor.

**How to apply:** Do not introduce live payments or calendar submissions without
explicit authorization. Keep genuine membership, simulated anchoring and Bitcoin
confirmation distinct.
