---
name: Static response headers
description: How the frontend static deployment gets security/CORS headers, and why validator acceptance proves nothing.
---

Static artifact deployments honor `[[services.production.responseHeaders]]` entries (`path`, `name`, `value`) in the artifact config. Confirmed on the live canonical domain on 2026-10-14: `/llms.txt` and `/llms-full.txt` returned nosniff, Referrer-Policy and `Access-Control-Allow-Origin: *` after a republish.

**Why:** The artifact config validator also accepted a deliberately bogus key, so a successful validation does not show that the platform reads a field. Only a live check after republishing proved the headers take effect. The user's fallback was to route the llms files through the API, which would have conflicted with the frontend owning those documents.

**How to apply:** Keep frontend header declarations in artifact configuration rather than moving frontend content into the API. After any new artifact-config key, verify it on the published domain before claiming it works.

The frontend now uses server-backed hosting for host-dependent 301 redirects.
Keep the artifact response-header declarations as the source for the frontend
server's own header application; do not assume static-host header processing
still applies.

**Why:** The user approved the hosting change to enforce canonical-domain
redirects without moving frontend content into the API.

**How to apply:** Preserve the headers for actual static responses, and verify
them after publishing any frontend serving changes.
