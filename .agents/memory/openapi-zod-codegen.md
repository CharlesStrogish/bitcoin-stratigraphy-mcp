---
name: OpenAPI Zod code generation
description: OpenAPI schema combinations that produce invalid Zod 3 validators through Orval.
---

Do not combine `const` string values with `format: uri` in schemas consumed by this workspace's Orval/Zod generator. Include explicit `items: {}` for arrays, including arrays inside object/array type unions.

**Why:** The generator emits a string-format method on a Zod literal and a zero-argument array constructor for these combinations; both fail compilation. An exact URL literal already constrains the value more tightly than a URI format.

**How to apply:** Keep the OpenAPI source accurate, regenerate consumers, and compile generated libraries. Do not repair generated validators by hand.

Use named component schemas for shared responses instead of references into another operation's response object.

**Why:** A valid reference into an operation's `200` response made Orval emit an unresolved `N200` TypeScript import.

**How to apply:** Validate the specification and compile its generated consumers; valid OpenAPI alone does not establish generator compatibility.

An Orval output operation transformer does not control the final request URL.

**Why:** Orval computes the full URL from the original path independently of the transformed operation's `route`. Changing that property left a duplicated `/api` prefix in generated code.

**How to apply:** Inspect generated URLs. When documenting a duplicate alias already reached by the canonical typed hook, exclude that duplicate from client generation only; retain it in the published contract.