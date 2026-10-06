---
name: Independent audit evidence
description: Trust boundaries for free Article 12 audit receipt verification.
---

The callback's default `audit_trail.jsonl` is the canonical target for
independent Article 12 audit verification.

**Why:** The user clarified that an external journal path is not needed.

**How to apply:** Keep audit examples and verification commands directed at
the callback's default journal unless the user supplies a different target.

Article 12 audit verification must not call the app's MCP server or use L402.
It may contact public OpenTimestamps calendars and independent Bitcoin
sources. Do not call a receipt Bitcoin-verified merely because it contains
a pending calendar or an unverified Bitcoin-block attestation.

**Why:** The user wants a free, standalone chain-of-custody check that
regulators can repeat without trusting the service that produced the receipt.
Even two agreeing public Bitcoin sources plus proof-of-work on a header do not
fully validate the canonical chain; an auditor's own fully validating node
is the stronger option. A receipt also cannot prove that a producer logged
every event, and a mutable hash-chained file cannot prove it was never
truncated or wholly rewritten.

**How to apply:** Keep pending and unavailable states distinct from a
cryptographic mismatch. Verify the exact trace digest and OTS Merkle path
against independently obtained Bitcoin evidence before saying VERIFIED;
disclose whether the check used corroborated public headers or an auditor's
own mainnet node. Preserve the original JSONL and encourage externally
retained journal checkpoints for completeness claims.

Public HTTP audit uploads must remain in memory, including under cancellation
and hard worker termination.

**Why:** A bounded worker can be killed before Python temporary-directory
finalizers run, leaving confidential plaintext uploads on disk even when the
normal success path cleans up.

**How to apply:** Reuse the verifier's in-memory parsing path for web uploads,
avoid temporary journal files, and bound worker output without retaining payloads.

Browser submission must preserve original bytes and raw JSON text; do not
parse and stringify submissions before sending them to the strict verifier.

**Why:** JavaScript round-tripping silently removes duplicate keys and changes
numeric spellings such as 1.0, defeating strict input checks or changing the
Python-defined canonical trace digest.

**How to apply:** Send file bytes unchanged. Parsing for content-type detection
must not replace the original body; perform authoritative validation server-side.
