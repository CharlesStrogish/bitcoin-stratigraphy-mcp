---
name: Flight recorder viewer scope
description: Distribution goal, paid-access requirement, and entitlement boundaries for the standalone viewer.
---

The user wants the Article 12 Flight Recorder Viewer to be a free, open-source local dashboard, prepared for a later standalone GitHub release, requiring the $500 Enterprise API Block for production use. Phase 1 proof and payment telemetry is mock data.

**Why:** The user defined this as Phase 1 of Bitcoin Stratigraphy's distribution plan; a polished preview must not be mistaken for operating payment or proof infrastructure.

**How to apply:** Keep the viewer independently installable and keep sample telemetry unmistakably separate from production data. Preparing a GitHub-ready package is not authorization to create or push a new public repository.

The server-only `BITCOIN_STRATIGRAPHY_API_KEY` name is an alias for the existing funded scanner capability, not a newly introduced universal MCP key.

**Why:** The issuer currently authenticates that paid product with a macaroon; inventing a static-key verifier or treating arbitrary configured text as payment evidence would bypass the actual entitlement boundary. The permanent Stripe link itself is not fulfillment evidence.

**How to apply:** Confirm entitlement with the existing issuer contract without spending scanner credits or creating payments. Live swarm ingestion and automated Stripe provisioning remain separate future work; neither follows from a verified demo connection.
