---
name: Enterprise swarm traffic
description: The user's workload constraint behind paid MCP rate-limit exclusions.
---

Paid MCP tools and `proof.notarize` are intended for legitimate high-frequency
enterprise swarm batches. Do not add a blanket IP ceiling that restricts them.

**Why:** The user explicitly said legitimate enterprise swarms burn
high-frequency batches there natively and required these routes to stay exempt.

**How to apply:** Keep spam protection on free discovery and public HTTP traffic
separate from paid execution. Preserve payment, entitlement and credential
security checks rather than bypassing them to provide throughput.
