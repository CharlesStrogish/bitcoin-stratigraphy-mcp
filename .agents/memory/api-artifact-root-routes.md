---
name: API artifact root routes
description: Replit proxy routing requirement for API endpoints outside the artifact's preview path.
---

Root-level endpoints served by an API artifact must be included in that artifact service's configured paths.

**Why:** Express can serve a route correctly on the service port while the shared Replit preview proxy still returns 404 if the path is absent from the artifact routing metadata.

**How to apply:** When adding a root endpoint outside `/api`, update the API artifact through the validated artifact configuration workflow, restart its managed workflow, and verify through the shared development domain.