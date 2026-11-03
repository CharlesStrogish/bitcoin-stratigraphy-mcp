---
name: L402 SDK payment coordination
description: Payment-integrity and concurrency rules for reusable L402 client SDKs.
---

Every wallet-returned preimage must hash to the payment hash in the selected challenge before the credential is cached or transmitted.

**Why:** Wallet adapters and challenge payloads are external inputs; accepting a mismatched proof can cache an unusable credential after payment.

**How to apply:** Validate challenge fields, compute SHA-256 over the 32-byte preimage, and require an exact lowercase hex match.

Associate each response with the Authorization credential that produced it. A delayed 402 must not clear or replace a newer cached credential, and concurrent first payments must be serialized.

**Why:** Two requests using one stale credential can receive 402 responses at different times. Without generation-aware handling, the later response can trigger a duplicate invoice payment.

**How to apply:** Before paying a 402, compare the current credential with the credential sent on that request. Retry a newer credential; only pay when no newer credential exists, and deduplicate in-flight payment work.

One-call agent onboarding simplifies connection, not spending authorization.
Keep explicit per-payment and cumulative limits and durable reservations across
worker restarts; do not replace the router's payment ledger with a convenience
client's in-memory token cache.

**Why:** An uncertain wallet operation can settle after the caller times out.
Resetting local state to make onboarding easier can spend twice or bypass the
previously authorized cumulative budget.

**How to apply:** Reuse the existing durable payment core in distributable agent
wrappers where the language permits. A standalone Python port must preserve the
same trust boundaries without requiring a Node bridge: signed invoice validation,
exact-request proof binding, persistent cross-process spending reservations, and
unknown outcomes held for deliberate recovery. Never silently retry a payment or
select a new state directory.

**Why a separate Python implementation:** The user requested a standalone PyPI
package for LangChain, CrewAI and AutoGen, rather than a bridge to the Node SDK.