---
name: Public OpenAPI contract policy
description: Preserve the full public API contract when changing enterprise discovery metadata.
---

Do not replace or downgrade the full API contract. Preserve all existing endpoints and document read-only discovery endpoints alongside them.

**Why:** The user explicitly authorized updating the existing contract instead of adding a shadowed static file. The API already owns `/openapi.json`; a dashboard public file would not replace what clients receive.

**How to apply:** Update the canonical specification and its existing generation path. Keep the public OpenAPI contract version independent of the engine release version when the user requests a specific specification version. Keep existing operational and payment-verification detail in vendor extensions when exact replacement metadata is required. Do not change payment gates, Treasury enforcement, or the core regression files for metadata-only work.
