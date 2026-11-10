---
name: Settlement failover invariants
description: Correctness rules for redundant L402 settlement providers and challenge caching.
---

Settlement failover must abort and close a timed-out provider client, allow only one primary half-open probe, and verify payment against both configured providers when necessary.

**Why:** Inferring the attempted provider from mutable circuit state can reject valid invoices during concurrent recovery, and uncancelled timed-out clients leak resources.

**How to apply:** Carry provider identity explicitly, pass an abort signal through the provider boundary, skip non-owner half-open probes, and try the alternate provider after invalid or unavailable verification.

When invoice creation fails over after a cache scope was predicted, persist the same challenge under both the predicted and actual-provider scopes.

**Why:** Concurrent cross-instance requests can retain a stale primary scope while waiting on the shared caller lock; without an alias they create duplicate fallback invoices and consume quota.

**How to apply:** Resolve the final scope from the returned invoice provider and atomically store predicted and final aliases for the same challenge.

Log the sanitized primary invoice failure before fallback selection; an
unconfigured optional fallback is not evidence that the primary wallet needs
another environment variable.

**Why:** A wallet's `UNAUTHORIZED: unknown connection` rejection was obscured
by the final optional-Alby configuration error. Nostr signing-key format and
wallet-connect authorization are separate concerns.

**How to apply:** Retain provider error codes and nested reasons, never raw
connection URIs or signing secrets. Confirm the primary connection with an
unpaid invoice request; never send a payment as a readiness check.