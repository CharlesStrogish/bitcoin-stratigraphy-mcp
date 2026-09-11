---
name: Alby invoice funding
description: Get Alby invoice creation requires an enabled wallet funding source in addition to a valid API token.
---

Get Alby can accept a valid API token while rejecting invoice creation with a provider error requiring a configured funding source. A token refresh alone does not resolve this account-level wallet setup issue.

**Why:** The invoice endpoint returned a specific funding-source error after the token was updated and the API workflow restarted.

**How to apply:** When invoice creation fails with this provider response, have the owner configure the Alby wallet funding source before retesting or publishing; do not fabricate a 402 invoice.