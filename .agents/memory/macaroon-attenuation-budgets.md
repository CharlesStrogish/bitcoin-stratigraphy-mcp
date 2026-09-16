---
name: Macaroon attenuation budgets
description: Security rule for enforcing request limits across recursively attenuated L402 subscription tokens.
---

Every request made with an attenuated macaroon must consume all `max_requests` budgets inherited along its signature chain.

**Why:** Counting only the final child signature lets a holder create many children and reset or bypass an ancestor's metered cap.

**How to apply:** Derive a stable usage scope at each request-limit caveat, preserve all scopes during further attenuation, and reserve every applicable counter atomically before returning data.