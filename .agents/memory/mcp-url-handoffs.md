---
name: URL checkout handoff boundaries
description: User-required separation between MCP checkout consent, payment initiation and paid-tool authorization.
---

Requesting or opening a URL-mode checkout handoff must never create a Stripe session, create a waiver quote, or derive/increment a BIP-84 deposit index. Only explicit human browser action may initiate the existing checkout flow.

**Why:** The user requires zero gap-limit exhaustion and no payment side effects from agent elicitation.

**How to apply:** Keep checkout handoffs capability-gated and separate from canonical paid tools. Opaque handoff/retry identifiers are correlation, never owner proof or payment authorization. Preserve owner verification, strict expiry and server-verified settlement binding; finite HTTP clients must poll and retry rather than wait for server push.
