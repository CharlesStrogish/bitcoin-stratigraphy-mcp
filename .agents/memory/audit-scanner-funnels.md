---
name: Audit scanner funnels
description: Separate developer and enterprise funnels and the paid heuristic scanner's trust boundaries.
---

Keep `/developers` focused on M2M integrations and `/audit` on the human enterprise kiosk. Preserve the existing L402 core payment flow when extending either funnel.

**Why:** The user explicitly requested isolated SEO funnels and authorized a new paid heuristic scanner service, not changes to core payment logic.

**How to apply:** Reuse existing merchant-side settlement verification with the original invoice/capability; pending verification must never trigger replacement payment. Bind scanner capabilities to the exact submitted prompt. The Compliance Hash simulates a receipt using SHA-256; never describe it as a real ZK proof, Bitcoin timestamp or legal compliance certification.

Keep build-time crawler content free of payment-client imports, CSS imports and browser dependencies.

**Why:** Vite's configuration bundler executes SEO renderers outside the app pipeline: CSS imports fail, workspace TypeScript payment-client imports resolve as external Node modules, and JSX requires an explicit React import in these renderers.

**How to apply:** Share pure content components with the interactive pages, pass explicit base paths, and load CSS/payment hooks only through the app entry.
