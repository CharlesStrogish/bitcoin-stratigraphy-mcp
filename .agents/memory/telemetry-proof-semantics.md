---
name: Telemetry proof semantics
description: Integrity rules for binding public proof inputs to emitted JSON and cached attestations.
---

Telemetry verification must include the exact emitted payload, recompute its canonical digest, and validate that block height, timestamp, and valuation public inputs match defined payload semantics. For arrays with cached per-record attestations, derive response time deterministically from emitted attestations.

**Why:** A cryptographically valid proof can still misrepresent changed JSON or unrelated public metadata if payload binding is optional or semantic fields are independently supplied. Cached attestations may have mixed creation times.

**How to apply:** Require payload data in convenience verification APIs, keep any proof-only primitive clearly internal, and derive proof inputs from the final emitted object after attestation.