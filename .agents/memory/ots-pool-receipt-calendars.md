---
name: OTS pool receipt calendars
description: Why stamp submission endpoints and the pending-calendar URLs embedded in receipts differ.
---

OpenTimestamps public pool endpoints may return genuine receipts whose pending attestations refer to underlying calendars rather than the pool endpoint used for stamping. Do not validate a serialized receipt by comparing its pending URLs only against submitted pool URLs.

**Why:** Pools relay stamps to child calendars. An allowlist containing only pool endpoints rejected genuine receipts. A pending calendar receipt still does not prove Bitcoin block inclusion.

**How to apply:** When changing providers or receipt validation, account for the actual underlying calendar hosts as well as the submission pools. Keep digest binding and independently verified Bitcoin status separate from calendar acceptance.