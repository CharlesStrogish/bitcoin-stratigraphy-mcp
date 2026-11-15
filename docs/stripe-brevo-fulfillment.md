# Stripe → existing funded mint → Brevo fulfillment

## Scope and authentication

`POST /api/webhook/stripe` is a raw-body, signature-authenticated endpoint for
`checkout.session.completed`. Other **signed** event types are acknowledged
without fulfillment. Missing, forged, altered or stale signatures are rejected.
Verification uses the official Stripe SDK and `STRIPE_WEBHOOK_SECRET`, before
Stripe API requests or database work. HTTPS and secure handling of the endpoint
secret remain necessary; signature checking is not an absolute security guarantee.

The existing `/api/stripe/webhook` sync endpoint remains intact. It also invokes
the completion-only fulfillment service for supported purchases. Prefer that
already-registered endpoint when it is receiving your real events. This avoids
creating an additional Stripe endpoint with a different signing secret.

If using the new endpoint instead, register it in Stripe for
`checkout.session.completed` and configure **that endpoint's** signing secret.
Do not replace the existing secret with another endpoint's secret while the old
endpoint still uses it. Do not register both endpoints with different secrets
against this single-secret configuration.

No checkout URL, advertised price, interceptor, minting algorithm, NIP-98
validator, payment-verification rule or Treasury authorization rule is changed.

## Purchase eligibility

The server re-reads the Checkout Session from Stripe and requires:

- Expected Stripe account mode, payment mode, complete status, paid status,
  exactly **50000 USD cents**.
- Exactly one quantity-one line item with the existing configured
  `FIAT_MINT_STRIPE_PRICE_ID`, USD 500 one-time pricing, and matching account mode.
- Either an existing, correctly bound `scanner-100-v1` fiat order, or the
  unchanged Payment Link whose Stripe-reported URL is
  `https://buy.stripe.com/8x228q0IE9A40uHehz7ss00`.
- A valid customer email from Stripe's authoritative session.

Other purchases do not receive a credential. Delayed payment methods whose
completed event is still unpaid are not fulfilled by this completion-only hook.

For an existing Payment Link purchase, the application stores a durable order
binding and adds only fulfillment metadata to the Checkout Session. It never
creates a replacement Checkout Session or changes a link, product or price.
The existing mint revalidates this order using its unchanged checks.

## Required live configuration

- Existing Stripe connection or secret/restricted API key.
- `STRIPE_WEBHOOK_SECRET` for the receiving endpoint.
- `FIAT_MINT_STRIPE_PRICE_ID` matching the existing advertised link's actual price.
- Existing `FIAT_MINT_PUBLIC_ORIGIN` and `FIAT_MINT_WEBHOOK_ORIGIN` configuration.
- A connected Brevo integration, or an explicit server-side `BREVO_API_KEY`.
  The connected path uses Replit's authenticated proxy with the official Brevo
  SDK; no raw key is copied into the application. An explicit key takes precedence
  when provided. **licensing@bitcoinstratigraphy.com** must also be authenticated/
  verified as an allowed sender in that Brevo account.
- The existing dedicated fiat payer, merchant connection, mode-specific Treasury
  authorization and funding budget required by the current `FiatMint` flow.

Do not place any of these secrets in source, browser variables, URLs or logs.
Grant Stripe permission to read sessions/line items/Payment Links and update
session metadata, in addition to existing sync permissions. No real API key or
wallet payment is needed for the automated local tests.

The new `stripe_enterprise_deliveries` application table is declared in the
Drizzle schema and was created in development. Apply its production schema change
through the normal Publish schema review. No startup-time DDL or Stripe catalog
table mutation is added.

## Delivery, retries and recovery

1. A per-session PostgreSQL advisory lock prevents concurrent fulfillment.
2. The existing `FiatMint.acceptSession` / `fulfill` path creates the funded,
   uniquely signed credential. The new service does not mint an unfunded token.
3. While settlement is pending, the hook returns 503. Stripe retries the same
   event/session. The mint retains its existing funding reservations and
   reconciliation behavior; it does not pay the invoice again.
4. Only a ready, unexpired scanner credential is sent using the official Brevo
   SDK. Sender, reply address, subject and body follow the requested email copy.
5. Email state is committed as `sending` before outbound I/O, then `sent` with the
   provider message ID after acceptance. Replayed events do not send another email.

An uncertain email outcome (timeout, crash, provider error or missing acceptance)
intentionally remains `sending` and requires operator reconciliation. The SDK
does not blindly retry a credential-bearing email. Check Brevo's delivery records
for the session's idempotency reference before deciding whether to mark accepted
or retry. Never mint a replacement or ask the buyer to purchase again to resolve
delivery uncertainty. Provider acceptance is not proof that the mailbox received it.

## Credential and copy limitations

The issued key retains the existing **100-credit `/api/scanner` scope**. It is not
a universal MCP credential, and the email's exact requested wording does not
change that authorization boundary.

The requested email also says the dashboard/interceptor automatically resume.
That is not implemented by the existing clients: configure the server-side key,
verify the viewer entitlement, and restart a halted swarm with the appropriate
MCP authorization. The interceptor is deliberately unchanged. Viewer telemetry
remains a demo, and neither buying a block nor installing software establishes
EU AI Act compliance or proves Zero-Knowledge execution.

## Local regression proof

`artifacts/api-server/src/routes/stripe-enterprise.test.ts` is included in the
existing API test runner (`pnpm --filter @workspace/api-server test`) and in
`pnpm test`.

It uses official SDK-generated test signatures, real isolated PostgreSQL
transactions, the actual unchanged mint, **mocked** wallet/Stripe clients and a
mock fetch transport under the official Brevo SDK. Tests cover raw-body rejection,
the exact email, wrong purchases, unique scanner credentials, replay/concurrency,
pending settlement, and ambiguous email outcomes. No live Stripe API, Brevo send,
or real Lightning payout is performed.
