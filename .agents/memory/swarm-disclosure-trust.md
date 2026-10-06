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

Standalone enterprise cookbook work must preserve existing canonical MCP
tools, schemas and Express routes. Flight-recorder work also leaves the
B2B/Article 12 cookbook code intact.

**Why:** The user repeated this isolation guardrail in the enterprise cookbook
briefs.

**How to apply:** Reuse existing adapters/helpers without rewriting the engine
or earlier cookbooks. Compatible dependency security updates can maintain
the zero-vulnerability requirement without modifying endpoint contracts.
