---
name: API artifact root routes
description: Replit proxy routing requirement for API endpoints outside the artifact's preview path.
---

Root-level endpoints served by an API artifact must be included in that artifact service's configured paths.

**Why:** Express can serve a route correctly on the service port while the shared Replit preview proxy still returns 404 if the path is absent from the artifact routing metadata.

**How to apply:** When adding a root endpoint outside `/api`, update the API artifact through the validated artifact configuration workflow, restart its managed workflow, and verify through the shared development domain.

Root discovery documents (`/openapi.json`, `/mcp`, `/.well-known/*`) also answer under `/api` through an alias rewrite that runs before every route (user requirement, 2026-10-15: every URL advertised in `/openapi.json` must return 200). A new root document needs both a service path and coverage by that alias. NIP-05 at `/.well-known/nostr.json` is an API service path, so the API serves it instead of the static dashboard. It always returns JSON with `Access-Control-Allow-Origin: *`, and an unserved name gets `{"names":{}}`, never a 404.

An explicit second Express route is not a substitute for central alias
normalization, even when both URLs already return HTTP 200.

**Why:** A public ledger's direct alias passed HTTP checks while the shared
OpenAPI routing contract failed because the alias rewriter left it unchanged.

**How to apply:** For new origin-level OpenAPI paths, verify both the central
rewrite contract and actual requests through the alias middleware. Preserve
the original request URL and exact path boundaries; do not weaken payment
checks or broaden the rewriter to arbitrary API paths.

The development hostname can redirect to the unchanged production site under
the existing canonical-domain policy. Inspect redirects before testing an
unpublished route; use the local preview proxy at `http://127.0.0.1:80` when
that hostname redirects.

**Why:** Following a development-host 301 reached the older production bundle
and produced a misleading 404 for a working unpublished route.

**How to apply:** Do not follow cross-host redirects during state-changing
development checks. Verify through the local shared preview proxy, not just
the API service port, and leave production untouched.