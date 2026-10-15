---
name: API artifact root routes
description: Replit proxy routing requirement for API endpoints outside the artifact's preview path.
---

Root-level endpoints served by an API artifact must be included in that artifact service's configured paths.

**Why:** Express can serve a route correctly on the service port while the shared Replit preview proxy still returns 404 if the path is absent from the artifact routing metadata.

**How to apply:** When adding a root endpoint outside `/api`, update the API artifact through the validated artifact configuration workflow, restart its managed workflow, and verify through the shared development domain.

Root discovery documents (`/openapi.json`, `/mcp`, `/.well-known/*`) also answer under `/api` through an alias rewrite that runs before every route (user requirement, 2026-10-15: every URL advertised in `/openapi.json` must return 200). A new root document needs both a service path and coverage by that alias. NIP-05 at `/.well-known/nostr.json` is an API service path, so the API serves it instead of the static dashboard. It always returns JSON with `Access-Control-Allow-Origin: *`, and an unserved name gets `{"names":{}}`, never a 404.