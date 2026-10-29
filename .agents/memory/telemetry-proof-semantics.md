---
name: Telemetry proof semantics
description: Integrity rules for binding public proof inputs to emitted JSON and cached attestations.
---

Telemetry verification must include the exact emitted payload, recompute its canonical digest, and validate that block height, timestamp, and valuation public inputs match defined payload semantics. For arrays with cached per-record attestations, derive response time deterministically from emitted attestations.

**Why:** A cryptographically valid proof can still misrepresent changed JSON or unrelated public metadata if payload binding is optional or semantic fields are independently supplied. Cached attestations may have mixed creation times.

**How to apply:** Require payload data in convenience verification APIs, keep any proof-only primitive clearly internal, and derive proof inputs from the final emitted object after attestation.

Response-level marketing attribution belongs outside nested signed receipts and
proof payloads. It must be present before completion hooks hash the response and
before the transport signs it.

**Why:** Attribution is a formatting change, not permission to rewrite evidence;
completion receipts and transport signatures must still commit the bytes clients
actually receive.

**How to apply:** Preserve nested proof bodies and payment/authentication behavior
when changing response formatting; keep public output schemas in parity with the
decorated result.