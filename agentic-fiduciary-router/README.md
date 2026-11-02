# Autonomous Fiduciary Router

## Fiduciary Cost-Optimization Middleware for Autonomous Swarms

For **CTOs and Lead Architects** building LangChain, AutoGen, Eliza, or custom
Node.js agent runtimes: wrap outbound requests with `BitcoinStratigraphyRouter`
to automate approved Lightning L402 payments, deliver the purchased data, and
capture a **21% thermodynamic yield on eligible Bitcoin Stratigraphy L402 data
acquisition costs**.

The middleware pays an L402 challenge with the developer's own Nostr Wallet
Connect connection, retries the original request with its verified payment
proof, and asynchronously requests the eligible revenue share from
`https://bitcoinstratigraphy.com/api/claim-yield`.

**Economics:** a qualifying 100-satoshi purchase produces a 21-satoshi claim,
leaving a 79-satoshi net data cost before routing fees. This is programmatic
L402 revenue sharing, not investment interest or a profit on spending. Free
calls, unconfirmed payments, and reuse of the same paid purchase do not generate
additional yield. Only the server's private ledger determines claim eligibility.
The package name describes cost-management middleware, not a legal fiduciary
appointment, banking license, investment product, or custody service.

## Install

This source is npm-ready but is not published by creating these files. Install
from a local checkout now:

```sh
npm install ./agentic-fiduciary-router
```

After the package is published under its declared name, the registry command is
`npm install agentic-fiduciary-router`. Requires Node.js 22 or newer.

## Three-line integration

```js
import { BitcoinStratigraphyRouter } from "agentic-fiduciary-router";
const router = new BitcoinStratigraphyRouter({ nwcUri: process.env.AGENT_NWC_URI, maxPaymentSats: 1000, maxTotalSats: 10000, stateDirectory: "./.router-state" });
const agentFetch = router.fetch; // Inject this where your agent framework accepts a fetch implementation.
```

Store `AGENT_NWC_URI` in the host's secret store, never in agent prompts or source.
This connection belongs to the **developer's wallet**, not the Data Engine's
Treasury wallet. Grant `pay_invoice` and `make_invoice` plus any read-only wallet
methods your independent recovery procedures need. Set wallet-side spending,
expiry, and routing-fee restrictions. Your wallet must support exact
millisatoshi receiving invoices; otherwise yield preparation stops safely.

The router is opt-in: it neither installs a global fetch monkeypatch nor silently
redirects unrelated APIs to Bitcoin Stratigraphy. Node-based frameworks can
inject `agentFetch` at their HTTP-client boundary. Python AutoGen applications
need a Node bridge or equivalent Python adapter; importing this package directly
into Python is not supported.

## Example request

```js
const response = await agentFetch("https://bitcoinstratigraphy.com/mcp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "stratigraphy.get", arguments: { target: "latest" } },
  }),
});
// Consume the response using your existing MCP client / JSON / SSE parser.
await router.drain(); // Before an orderly worker shutdown; not on the request path.
```

The example assumes the host has completed any required MCP initialization and
new-invoice compute admission. This is payment middleware, not a full MCP client.
Responses without a valid L402 invoice—including admission or x402 challenges—
are returned to the host for handling, never treated as permission to pay.
Get live quotes from `/api/v1/cost` rather than assuming the example's budget is
the current price.

## Interception contract

1. Send the original HTTP request with redirects disabled.
2. Intercept only HTTP 402 on an explicitly allowed HTTPS origin. By default
   only `https://bitcoinstratigraphy.com` can trigger spending.
3. Parse the service's quoted `WWW-Authenticate: L402 macaroon="…", invoice="…"`
   header. Missing, duplicated, ambiguous, or unsupported parameters fail closed.
4. Decode the fixed-amount mainnet BOLT11 invoice; validate checksum, recoverable
   signature, amount, hash, and expiry. For Bitcoin Stratigraphy, require the JSON
   challenge to match the header and invoice exactly.
5. Atomically reserve the invoice principal plus the configured fee allowance
   in private durable state before NWC I/O. Enforce the configured principal and
   aggregate budgets, and prevent duplicate/concurrent payments by payment hash.
6. Pay once using NIP-47 `pay_invoice`; verify the returned preimage by hashing
   its **raw bytes**, and persist it before retrying.
7. Retry the same method, URL, body, and scope headers exactly once with
   `Authorization: L402 <macaroon>:<preimage>`. Return that response without
   waiting for a withdrawal. A second 402 never triggers another payment.
8. In the background, observe successful JSON or matching MCP SSE results.
   Errors, notifications, pending task handles, and HTTP 202 are not successful
   completion. Only then create an exact receiving invoice for
   `floor(paid_msats * 21 / 100)` and POST:

   ```json
   {
     "macaroons": ["<original-paid-macaroon>"],
     "bolt11_invoice": "<developer-wallet-receiving-invoice>"
   }
   ```

The receiving invoice is paid **by the service**, not by the middleware.
HTTP 200/`SETTLED`/`payment_sent: true` confirms payout. HTTP 202/`PENDING` remains
pending. Claim failure never discards a purchased response or sends another data
payment. Claim results and errors are observable without logging credentials:

```js
const router = new BitcoinStratigraphyRouter({
  nwcUri: process.env.AGENT_NWC_URI,
  maxPaymentSats: 1000,
  maxTotalSats: 10000,
  feeReserveSats: 10,
  stateDirectory: "./.router-state",
  onYieldClaim: ({ status, claimId, amountMsats }) => {
    // status: settled | pending | recovery_required
    yourPrivateMetrics.record({ status, claimId, amountMsats });
  },
  onError: ({ code }) => yourPrivateMetrics.record({ code }),
});
```

`identityHeaders(url, method, bodyBytes)` may return fresh
`X-Nostr-Authorization` headers for identity-bound passes. Use the same Nostr
signer as the initial purchase. This callback is trusted host code; keep its
signing key out of the LLM context. A pre-existing L402 credential is never
replaced with a newly purchased invoice.

## Spending, fees, and recovery

- `maxPaymentSats` and `maxTotalSats` are **required positive integer satoshi
  limits**. The former bounds each invoice's principal; the latter bounds
  cumulative reservations, including `feeReserveSats` (default: 10 sats).
- NIP-47's `pay_invoice` does not provide a portable caller-side fee ceiling.
  **The fee allowance is accounting, not an enforced routing-fee cap.** Configure
  the cap in your wallet. If reported `fees_paid` exceeds the allowance, new
  spending is blocked, but the already-paid data request is still redeemed.
- Reservations are deliberately conservative: they are not automatically
  released after wallet errors or unconfirmed timeouts. An uncertain payment
  remains reserved; the router never guesses that it failed or resends it.
- State files contain macaroons, preimages and receiving invoices. Keep the
  directory private, persistent, backed up, and excluded from Git, application
  logs and agent prompts. Newly created directories use mode `0700`, files `0600`.
  Do not precreate the directory with public permissions.
- All instances spending the same budget must use the same state directory on
  a filesystem with working exclusive locks, atomic rename, and fsync. A crashed
  lock fails closed. Stop all workers and reconcile wallet evidence before any
  manual lock or state repair. Do not delete state to bypass a spending limit.
- For multiple machines, provide an external coordinated payment service;
  copying this local directory between active hosts is not a distributed lock.
- After a lost withdrawal response, `await router.recoverClaim(paymentHash)`
  sends only the **already-saved identical claim body**, never another payment or
  replacement invoice. It does nothing for a known settled claim. Pending claims
  still require server-side operator reconciliation; this method does not obtain
  operator privileges or cause Treasury to pay a second time.
- If the process stopped before a receiving invoice was saved, inspect the
  private state and recover manually. The router does not invent replacement
  withdrawals. Background jobs are best effort; call `drain()` before shutdown.
- JSON/SSE observation is bounded to 1 MiB and `timeoutMs`; otherwise execution must
  be confirmed by your application before an operator recovers the claim.
  Async MCP Tasks require host-level completion handling; initial task handles
  do not trigger a claim.

`allowedOrigins` can explicitly opt additional HTTPS services into the payment
policy, but **automatic yield claims remain restricted to Bitcoin Stratigraphy**.
Third-party L402 payments do not earn a claim against its Treasury. Unsupported
header extensions fail closed. No wallet custody, cross-provider payment
rerouting, hidden transfers, or production ledger access is added.

## Development

```sh
cd agentic-fiduciary-router
pnpm install --frozen-lockfile
pnpm test
pnpm run check
```

The package has three focused dependencies: the existing Alby NWC SDK and the
small Scure/Noble encoding and signature libraries. It requires no LangChain,
AutoGen, Eliza, database, web server, build step, or framework dependency.
Tests use synthetic invoices, mocked HTTP, and mocked wallet methods; they never
load a real NWC connection, contact relays, spend funds, or post live claims.

## License

Dual-licensed under AGPLv3 or a separately executed commercial license, preserving
the parent project's terms. See [LICENSE.md](./LICENSE.md). API payment and yield
claims do not grant a commercial software exemption.
