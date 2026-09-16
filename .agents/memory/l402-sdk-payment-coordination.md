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