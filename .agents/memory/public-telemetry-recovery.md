---
name: Public telemetry recovery
description: Shared database outages and the trust boundary for cached public homepage readings.
---

Keep public telemetry recovery separate from settlement, authentication and ledger recovery. Never seed missing readings with invented zeroes, a hardcoded root or a reconstructed financial record.

**Why:** An incident made six homepage feeds fail together because the database provider returned “The endpoint has been disabled.” The independent market toll quote still worked; all seven production reads subsequently recovered without changing their URLs. A frontend cache improves display resilience but cannot enable the database or prove that its infrastructure problem is permanently resolved.

**How to apply:** Diagnose correlated 503 responses through backend logs before changing URLs or CORS. Persist only validated, minimal public display fields and original observation timestamps, with expiry and explicit cached labels. Full genesis responses include a payment preimage and must never enter a persistent display cache. First-time visitors without a genuine saved response must remain in a truthful loading/reconnecting state. Recovery must not change financial state, payment authorization or MCP registration.
