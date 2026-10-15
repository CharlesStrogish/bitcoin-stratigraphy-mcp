---
name: Static page rewrites
description: Why each prerendered dashboard page needs explicit deployment rewrites, and why canonical URLs end with a slash.
---

Every public page with its own prerendered `index.html` (enterprise,
whitepaper, compliance, simulator, standard) needs deployment rewrites for both
its bare and trailing-slash paths to that file. They must come before the `/*`
SPA catch-all. Canonical URLs, `og:url` and sitemap entries for these pages use
the trailing-slash form.

**Why:** In production, rewrites take precedence over static directory indexes.
Pages without their own rewrite fell through to `/*` and served the homepage
head; this was observed at `/simulator/` and `/standard/` on 2026-10-15.
Production also answers bare page paths with a 301 to the trailing-slash form,
so a bare canonical points at a redirect. The user requires the trailing-slash
sitemap entries.

**How to apply:** When adding a prerendered page, add both rewrites ahead of
the catch-all through the validated artifact configuration workflow. Build its
canonical with the shared page-URL helper and extend the rewrite-ordering
test. Check the production head at the trailing-slash URL after publishing.
Leave the license JSON-LD URL as it is unless the user asks.
