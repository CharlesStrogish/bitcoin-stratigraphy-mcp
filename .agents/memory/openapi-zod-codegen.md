---
name: OpenAPI Zod code generation
description: OpenAPI schema combinations that produce invalid Zod 3 validators through Orval.
---

Do not combine `const` string values with `format: uri` in schemas consumed by this workspace's Orval/Zod generator. Include explicit `items: {}` for arrays, including arrays inside object/array type unions.

**Why:** The generator emits a string-format method on a Zod literal and a zero-argument array constructor for these combinations; both fail compilation. An exact URL literal already constrains the value more tightly than a URI format.

**How to apply:** Keep the OpenAPI source accurate, regenerate consumers, and compile generated libraries. Do not repair generated validators by hand.