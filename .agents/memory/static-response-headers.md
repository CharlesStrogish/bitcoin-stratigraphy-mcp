---
name: Static response headers
description: How the frontend static deployment gets security/CORS headers, and why validator acceptance proves nothing.
---

Static artifact deployments honor `[[services.production.responseHeaders]]` entries (`path`, `name`, `value`) in the artifact config. Confirmed on the live canonical domain on 2026-10-14: `/llms.txt` and `/llms-full.txt` returned nosniff, Referrer-Policy and `Access-Control-Allow-Origin: *` after a republish.

**Why:** The artifact config validator also accepted a deliberately bogus key, so a successful validation does not show that the platform reads a field. Only a live check after republishing proved the headers take effect. The user's fallback was to route the llms files through the API, which would have conflicted with the frontend owning those documents.

**How to apply:** Add headers for frontend-served files through this static config instead of moving the files to Express. After any new artifact-config key, verify it on the published domain before claiming it works.
