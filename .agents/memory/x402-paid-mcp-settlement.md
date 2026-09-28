---
name: x402 paid MCP settlement
description: Settlement ordering and readiness policy for x402 on paid MCP tools.
---

For paid MCP tools, x402 must use an upfront payment flow and settle successfully before executing the tool. The user explicitly wants a dual-rail 402 quote even without facilitator credentials. Mark that fallback quote as settlement-unavailable; do not treat it as an active payment method or execute a signed request without a live facilitator. Keep free discovery and L402 working.

**Why:** Some MCP tools have side effects, so post-handler settlement could perform work before payment. The fallback quote exists for discovery, not authorization; pretending an unavailable facilitator can settle would mislead a paying agent.

**How to apply:** Preserve this ordering when adding paid tools or changing the facilitator, challenge format, or payment SDK. Distinguish quoted terms from settlement readiness, and test rejected and repeated settlement attempts before granting access.