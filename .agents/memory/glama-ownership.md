---
name: Glama ownership verification
description: Why Glama ownership verification and legacy connector metadata may differ.
---

Treat the ownership verification payload as an exact provider-supplied document,
separate from legacy connector discovery metadata.

**Why:** The user supplied an ownership claim containing digit zero where the
legacy claim contains uppercase O, and explicitly prohibited unrelated discovery
changes.

**How to apply:** Preserve the exact ownership payload and verify it publicly
without authentication. Do not normalize the legacy connector aliases or modify
the MCP configuration manifest as part of ownership verification.
