# Stripe Checkout → CoinOS → prepaid scanner Macaroon

This bridge uses real Stripe-hosted Checkout in **live or test mode**, not a mock UI. It sells
a fixed **$500 Enterprise API Block** with **100 scanner calls**, allocated
100,000 sats of Lightning funding and valid for 30 days. These fixed package
values are **not a USD/BTC exchange-rate equivalence**. Other MCP tools are not
included.

## Important financial boundary

A successful live Stripe charge collects real USD; a test charge transfers
**no fiat**. Enabling CoinOS funding in either mode spends **real mainnet sats**
from your separately budgeted payer account.
Nothing bypasses or “digitally clears” Lightning settlement. The payer pays
the exact merchant invoice; both outgoing payment evidence and incoming
merchant settlement must be confirmed before the Macaroon becomes claimable.
CoinOS may reject same-account self-payments. Use separate, funded payer and
merchant accounts; do not treat a wallet rejection as a successful transfer.

Treasury funding defaults **off**, with a zero spending cap. No existing
staking/yield treasury is automatically used or debited by this bridge.
Choose a genuinely separate payer account with only the authorized
budget. The app cannot establish that two NWC connections represent separate
underlying accounts; that isolation is the operator's responsibility.

## Server configuration

Use Replit Secrets or your deployment's secret manager for sensitive values.
Never put them in frontend environment variables, source code, URLs or chat.

| Setting                               | Purpose                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                   | Optional full secret (`sk_live_…` / `sk_test_…`) or restricted (`rk_live_…` / `rk_test_…`) API key. Overrides the connected Stripe proxy. Never use a publishable key here. |
| `STRIPE_WEBHOOK_SECRET`               | Optional endpoint signing secret. For manually managed webhooks, set the exact `whsec_…` secret. Otherwise the managed webhook secret is retrieved server-side. |
| `FIAT_MINT_STRIPE_PRICE_ID`           | Existing active, one-time USD 50,000-cent price ID in the **same mode and account** as the API key. A test price cannot be used with live keys. |
| `FIAT_MINT_PUBLIC_ORIGIN`             | Exact HTTPS browser origin used for Checkout success/cancel returns and CSRF validation                                                                         |
| `FIAT_MINT_WEBHOOK_ORIGIN`            | Public, published HTTPS origin for `/api/stripe/webhook`; not a private preview URL                                                                             |
| `FIAT_MINT_ALLOW_TREASURY`            | Must explicitly equal `true` to authorize real Lightning spending after **live** card payments. Defaults off. |
| `FIAT_MINT_TREASURY_BUDGET_SATS`      | Live-mode lifetime reservation cap in sats. Defaults `0`. One purchase reserves 100,000 sats; prior reservations across both modes count toward the cap. |
| `FIAT_MINT_ALLOW_TEST_TREASURY`       | Separate test-mode opt-in for real Lightning spending after test card charges. Does **not** authorize live-mode spending. |
| `FIAT_MINT_TEST_TREASURY_BUDGET_SATS` | Test-mode lifetime reservation cap. Defaults `0`; prior reservations across both modes count toward the cap. |
| `FIAT_MINT_PAYER_NWC_URI`             | **Secret:** separately budgeted outbound payer wallet                                                                                                           |
| `NWC_URI`                             | Existing **secret** CoinOS merchant wallet receiving the invoice payment                                                                                        |
| `SESSION_SECRET`                      | Existing **secret** Macaroon issuer key. Preserve it across restarts.                                                                                           |
| `DATABASE_URL`                        | Existing PostgreSQL database; never expose it to the browser                                                                                                    |

The official Stripe SDK uses `STRIPE_SECRET_KEY` when supplied. Otherwise it
uses the attached Replit Stripe connector through its authenticated proxy:
no raw provider credential is extracted. For explicit API keys, the backend
derives the required mode from the validated key prefix, without requiring
balance-read permission on a restricted key. Connector mode is discovered
through a server-side balance read. Prices, sessions, line items and signed
webhook events must match that mode.
`stripe-replit-sync` initializes its schema, configures a managed webhook if
needed, and backfills Stripe records. Stripe remains the source of truth
for products, prices and payments. `fiat_mint_orders` stores only application
fulfillment state. On a Replit managed database, Publish applies the new
application table from the development schema; never reset existing quota
or payment tables.

For a self-hosted test-key setup, seed the catalog with:

```bash
pnpm --filter @workspace/scripts exec tsx src/seed-fiat-mint.ts
```

Store the printed price ID as `FIAT_MINT_STRIPE_PRICE_ID`. The script creates
no checkout payment or Lightning transaction.

The seed script is deliberately test-key-only. For live mode, configure an
existing active one-time USD $500 price in your live Stripe account and use
its ID in the published environment. The live endpoint signing secret must
belong to the webhook registered in that same live account. Restricted keys
need the Checkout, product/price and sync/webhook API permissions used by this
integration; missing permissions fail closed.

The frontend uses a server-created hosted Checkout URL, not Stripe.js. No
browser-side publishable key is required. Never expose a secret/restricted
API key in a `VITE_` variable.

Live keys alone do **not** enable Lightning spending. New live Checkouts are
blocked if the payer/merchant is unconfigured, live spending is disabled, or
the configured cap has insufficient unreserved capacity. This check is not a
wallet balance guarantee or a reservation against concurrent unpaid Checkouts.
Configure the separate payer, merchant, explicit live opt-in and live budget
before accepting real customer purchases. If funding later becomes unavailable,
paid orders remain pending until funding is verified. No treasury flag or
spending cap is automatically enabled by a code update.

### Webhook reachability

Use the verified published origin, currently `https://bitcoinstratigraphy.com`,
with endpoint `https://bitcoinstratigraphy.com/api/stripe/webhook`.
The deployment is public. The new route is **not live until this code is
published**. A private preview cannot receive unauthenticated Stripe webhooks.
While developing, authenticated browser status recovery rechecks the exact
session through the Stripe API, so delayed webhook delivery does not require
a new checkout.

For manually managed webhooks, subscribe to `checkout.session.completed` and
`checkout.session.async_payment_succeeded` and use that endpoint's signing
secret. Do not reuse a Stripe CLI forwarding secret for a different endpoint.
Manual endpoint setup is needed when supplying your own webhook secret;
the app does not create a duplicate endpoint in that case.

## Flow and security

1. `POST /api/fiat-mint` creates or resumes an idempotent real Checkout session.
   Package price and credit amount are server-owned. Unknown request fields,
   cross-origin browser requests and cross-mode prices/sessions are rejected.
2. A 256-bit opaque HttpOnly, Secure, SameSite=Lax cookie binds the browser
   to the order. Only a SHA-256 ownership hash is kept in PostgreSQL. Session
   IDs in webhook events are **not** authorization to retrieve credentials.
3. `/api/stripe/webhook` receives a bounded raw body before JSON parsing.
   The official SDK verifies its signature and timestamp, and the sync
   event and embedded session must match the configured mode before the sync
   library processes the verified event.
4. The backend re-fetches the session and its line items. It requires
   `paid`, `complete`, the configured mode, exact amount/currency, one configured price,
   quantity one, the correct product marker and exact application order ID.
5. Verified purchases are durably marked `paid`. Before initial funding the
   worker revalidates the exact session and price, so historical test purchases
   cannot draw on a live-mode budget after a key change. An enabled worker reserves
   the fixed 100,000 sats under a global database lock, creates the CoinOS
   invoice, validates amount/hash and persists the original invoice and
   scoped Macaroon **before** attempting payment.
6. The order transitions to `paying` before any outbound wallet call.
   Inconclusive outcomes remain reserved. Subsequent processing only looks
   up that original payment; it **never sends `pay_invoice` again**.
7. Exact outgoing and incoming settlement confirmation changes it to `ready`.
   The existing issuer format, scanner quota enforcement, expiry,
   NIP-98 behavior and L402 merchant verification remain unchanged.
8. `POST /api/fiat-mint/status` reports state without returning a token.
   `POST /api/fiat-mint/claim` atomically changes `ready` to `delivered` and
   discloses the Macaroon once to the owning browser.

The UI retains the credential in component memory only. It never goes into
local/session storage, URLs, analytics or cookies. Copy it immediately to
your secret manager. Leaving the page discards its display.

## Recovery, limits and operations

- Keep browser cookies: losing the ownership cookie requires operator-assisted
  recovery, not another purchase.
- Do not pay both the original Lightning checkout and the card checkout for
  the same intended purchase. The UI disables card initiation while a
  Lightning invoice is retained.
- Worker retries are serialized by per-order PostgreSQL advisory locks.
  A 30-second scan processes at most 10 pending orders sequentially.
- Budget reservations are never automatically refunded, including confirmed
  failures, abandoned invoice creation or ambiguous wallet outcomes. Increasing
  the lifetime cap is an operator spending authorization, not a refund.
- A crash after `paying` is persisted but before the wallet receives the request
  intentionally requires manual reconciliation. Safety takes precedence over
  automatic re-payment.
- An unpersisted Checkout creation attempt older than 23 hours requires operator
  reconciliation because Stripe's idempotency retention is finite.
- Existing expired Checkout sessions are not automatically replaced.
- A lost one-time credential response cannot safely be redisplayed through this
  API. Reconcile with the operator; do not start a replacement charge.
- No automatic fiat refunds, dispute handling, debt collection or currency
  conversion is implemented.
- Monitor `paid` (funding disabled/cap exhausted), `paying` (uncertain settlement)
  and `failed` states. Reconcile Stripe and both wallets before any manual action.
- Protect database backups: persisted Macaroons are bearer credentials even
  though they are not yet returned by the API.

## Verification without spending

The regression suite uses signed synthetic Stripe events, isolated PostgreSQL
fixtures and synthetic NWC evidence. No real treasury transfer is needed.
Test-mode Checkout can open while treasury funding remains disabled. Live-mode
Checkout refuses known-unfundable purchases before creating a session.
End-to-end mainnet funding needs a separately authorized budget and deliberately
configured wallets; synthetic test success does not establish live wallet readiness.
