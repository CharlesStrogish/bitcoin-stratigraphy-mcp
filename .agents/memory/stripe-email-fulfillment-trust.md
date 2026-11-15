---
name: Stripe email fulfillment trust
description: Scope and trust boundaries for Stripe purchases followed by transactional credential email.
---

Stripe checkout completion is not evidence that the existing Lightning-backed scanner capability has been funded. Reuse the established mint and its dedicated payer, budget, mode checks and merchant settlement evidence before disclosing a usable credential.

**Why:** The user explicitly prohibited changes to checkout links, pricing, the interceptor, core macaroon minting and NIP-98 validation. Treating Stripe as a new settlement provider inside the verifier would violate that boundary.

**How to apply:** Fulfillment may bind the original Checkout Session to an application order, but must not replace the purchase, bypass funding controls, or claim the scanner block grants arbitrary MCP access. Preserve unknown payment outcomes for reconciliation without another payment.

The user required exact transactional email copy, including wording about automatic resumption, while freezing the interceptor. That copy is not authorization to introduce automatic client restart or expand scanner scope.

**Why:** The current distribution deliberately halts on authorization failure and distinguishes viewer scanner credentials from paid MCP authorization.

**How to apply:** Keep implementation and operational documentation accurate about manual credential configuration and restart. Do not represent the requested email wording as proof that automatic resume or regulatory compliance has been implemented.

Managed Brevo delivery must work without a raw `BREVO_API_KEY`. Keep direct-key support for explicit deployments, but use the authenticated connector proxy for the connected-account path.

**Why:** Managed credentials remain behind the proxy. Gating the webhook on a raw-key environment variable silently skipped the connected integration.

**How to apply:** Keep the official Brevo SDK with authentication disabled only inside the constrained proxy transport; the proxy supplies authentication. Brevo proxy paths are relative to its `/v3` base. Never retry an uncertain credential-email submission through another transport.

The Brevo API key is intentionally restricted to "Send Only" (Transactional Email). HTTP 403 on sender-list requests is expected. The user manually confirmed that `licensing@bitcoinstratigraphy.com` is an authorized, fully verified sender on this account.

**Why:** The user requires least-privilege enterprise security and explicitly overrode the sender-list verification blocker.

**How to apply:** Do not broaden permissions, repeat sender-list checks, or treat lack of sender-list read access as an email-delivery blocker. Preserve Send Only access and the confirmed sender.
