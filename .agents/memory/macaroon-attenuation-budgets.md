---
name: Macaroon attenuation budgets
description: Security rule for enforcing request limits across recursively attenuated L402 subscription tokens.
---

Every request made with an attenuated macaroon must consume all `max_requests` budgets inherited along its signature chain.

**Why:** Counting only the final child signature lets a holder create many children and reset or bypass an ancestor's metered cap.

**How to apply:** Derive a stable usage scope at each request-limit caveat, preserve all scopes during further attenuation, and reserve every applicable counter atomically before returning data.

Sibling capabilities must diverge before their own single-call quota caveat
(for example, distinct ephemeral delegate keys, then `max_requests=1`).
Adding uniqueness after a shared quota caveat cannot create an independent budget.

**Why:** Otherwise siblings intentionally share the same quota-bearing signature
prefix; a regression fixture that expects separate budgets would incorrectly fail.

**How to apply:** Order descriptor examples and tests with delegate/tool/deadline
restrictions before the leaf request limit. Never reset an inherited quota to
make such a fixture pass.