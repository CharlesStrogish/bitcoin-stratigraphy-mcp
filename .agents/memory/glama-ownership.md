---
name: Glama ownership verification
description: Exact ownership claims, legacy connector metadata, and Glama's recognized schema fields.
---

Treat the ownership verification payload as an exact provider-supplied document,
separate from legacy connector discovery metadata.

**Why:** The user supplied an ownership claim containing digit zero where the
legacy claim contains uppercase O, and explicitly prohibited unrelated discovery
changes.

**How to apply:** Preserve the exact ownership payload and verify it publicly
without authentication. Do not normalize the legacy connector aliases or modify
the MCP configuration manifest as part of ownership verification.

Do not assume that an extra publisher URL property in `glama.json` populates a
Glama profile field merely because JSON Schema accepts additional properties.
Check the current official schema before adding privacy or trust-center fields.

**Why:** The official server schema declared only `maintainers` when the privacy
notice was added. It allowed unspecified properties but defined no documentation,
trust-center, or privacy-policy URL fields.

**How to apply:** Preserve existing ownership/publisher metadata, expose factual
policy pages through the site and crawler links, and distinguish a ready page
from a confirmed update to the external directory profile.
