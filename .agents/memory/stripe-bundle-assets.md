---
name: Stripe bundle assets
description: Why source-mode Stripe initialization can pass while a published JavaScript bundle silently skips its SQL migrations.
---

Treat native Stripe synchronization SQL files as required runtime assets in every bundled server distribution.

**Why:** The library discovers migrations relative to its own module path. Bundling relocates that path, and the migration runner silently skips a missing directory after creating the schema. Unbundled development checks still find the installed package's files, so successful local initialization and Stripe API reads do not validate the published bundle. The user confirmed that hosted Checkout loaded successfully after the bundled SQL asset fix.

**How to apply:** Verify the packaged migration files match the installed library byte-for-byte. Repair the build assets rather than resetting production schemas or changing financial settings without evidence. Keep production diagnostics limited to safe stage names, provider/database codes and request identifiers; never log complete Stripe errors, credential-bearing URLs or wallet configuration. Read-replica metadata alone does not establish the deployed process's actual database target.
