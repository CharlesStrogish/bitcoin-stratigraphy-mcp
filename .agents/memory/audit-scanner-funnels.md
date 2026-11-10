---
name: Audit scanner funnels
description: Separate developer and enterprise funnels and the paid heuristic scanner's trust boundaries.
---

Keep `/developers` focused on M2M integrations and `/audit` on the human enterprise kiosk. Preserve the existing L402 core payment flow when extending either funnel.

The credit-card bridge must use real Stripe-hosted Checkout, not a fake mock UI. The user has moved from the initial test-mode request to production-facing checkout with live Stripe credentials.

**Why:** The user initially required genuine test Checkout, then reported configuring live keys and requested removing frontend test-mode labels.

**How to apply:** Preserve genuine provider-hosted checkout and verified server-side payment evidence. Configuring live credentials alone does not prove that checkout and fulfillment support live payments. Test charges transfer no fiat; never infer authorization to enable mainnet treasury spending merely from connecting Stripe.

**Why:** The user explicitly requested isolated SEO funnels and authorized a new paid heuristic scanner service, not changes to core payment logic.

**How to apply:** Reuse existing merchant-side settlement verification with the original invoice/capability; pending verification must never trigger replacement payment. Bind scanner capabilities to the exact submitted prompt. The Compliance Hash simulates a receipt using SHA-256; never describe it as a real ZK proof, Bitcoin timestamp or legal compliance certification.

The retail scanner costs a fixed 5,000 sats. The Developer SaaS product costs
100,000 sats for 100 scanner calls across different prompts, without a new
invoice per call.

**Why:** The user replaced testing fees with enterprise pricing and authorized
prepaid credits without replacing the core L402 architecture.

**How to apply:** Keep retail grants prompt-bound and single-use. Prepaid grants
are scanner-scoped instead; enforce the immutable signed credit allocation with
the shared atomic usage store. Mint confirmations return the original capability
without renewing its expiry or replenishing credits. Credits currently last
30 days from issuance, separately from the 15-minute funding invoice.

Keep the existing `macaroon_request_usage` table and its data intact; implement
scanner credits using its existing schema, never a drop-and-recreate migration.

**Why:** The user explicitly prohibited dropping this production table. A
missing development copy caused Publish to propose `DROP TABLE ... CASCADE`
even though no destructive migration file existed in the repository.

**How to apply:** Keep shared quota tables represented in the schema source and
development database. Inspect the actual development-to-production schema diff
before declaring a migration safe; preserving source code alone is insufficient.
Never approve a table drop, reset existing quota rows, or bypass managed
production migrations to introduce scanner credits.

The `/developers` B2B portal reveals the funded Macaroon only in the current
page's success state, with the user's explicit one-time-copy warning.

**Why:** The user requires one-time credential disclosure after settlement,
not stored credentials or a second invoice for an interrupted purchase.

**How to apply:** Never put capabilities in browser storage, analytics or URLs.
Retain the original invoice on verification errors, allow explicit payment
recovery after automatic polling pauses, and discard the display on leaving.
The advertised `Macaroon <token>` syntax is a prepaid-scanner-only alias for
the existing merchant-verified L402 flow, not authorization for other MCP tools.

Do not deploy financial architecture with failing legacy tests. Maintain a strictly green build pipeline.

**Why:** The user explicitly required updating or removing obsolete architecture assertions and running the full suite before committing, pushing or publishing the approved funnels.

**How to apply:** Repair real coverage and security gaps instead of deleting useful tests. Test discovery must include every workspace package containing tests; optional generated local artifacts must not be prerequisites for routine unit tests.

Keep build-time crawler content free of payment-client imports, CSS imports and browser dependencies.

**Why:** Vite's configuration bundler executes SEO renderers outside the app pipeline: CSS imports fail, workspace TypeScript payment-client imports resolve as external Node modules, and JSX requires an explicit React import in these renderers.

**How to apply:** Share pure content components with the interactive pages, pass explicit base paths, and load CSS/payment hooks only through the app entry.
