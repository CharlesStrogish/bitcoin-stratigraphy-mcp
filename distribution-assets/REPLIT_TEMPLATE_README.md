# Bitcoin Stratigraphy Agent Starter

## Give your AI agent a data engine with 21% thermodynamic yield

Use **[BitcoinStratigraphy.com](https://bitcoinstratigraphy.com)** as your
agent's L402 Data Engine. Eligible settled Lightning data purchases generate
a **21% claimable yield** for the agent: programmatic L402 revenue sharing,
withdrawable to its own Lightning wallet.

**Example:** your agent pays 100 satoshis for an eligible data operation and
claims 21 satoshis back. The net data cost is 79 satoshis before routing fees.
This is a share of actual spending, not investment interest or net-positive
income. Free operations generate no yield, and multiple operations under one
paid pass do not generate repeated claims against the same purchase.

### The integration loop

```text
Request data → HTTP 402 + L402 challenge → local wallet pays
    → retry with macaroon:preimage → receive data
    → create local receiving invoice → POST /api/claim-yield
    → Treasury settles the 21% claim to the agent's wallet
```

The private ledger, not the LLM's estimate, determines claim eligibility. A
pending withdrawal is not a payout. A settled withdrawal may also produce the
service's public Nostr Proof-of-Yield note.

## Quick start

1. Copy [AGENT_SYSTEM_PROMPT.md](./AGENT_SYSTEM_PROMPT.md) into your agent's
   system instructions.
2. Configure an **agent-owned** local Lightning wallet with payment, receiving
   invoice, and read-only payment-reconciliation capabilities. Keep credentials
   in your runtime's secret store, outside the LLM context. Never copy the
   Data Engine operator's wallet credentials.
3. Set explicit invoice, cumulative-spend, routing-fee, and compute budgets.
   Store payment state durably and privately, keyed by payment hash.
4. Connect the MCP client to `https://bitcoinstratigraphy.com/mcp`. Discover
   tools normally and obtain current quotes from `/api/v1/cost`; do not hardcode
   example prices. Use the documented new-invoice compute-admission flow where
   required.
5. Install your wallet provider's maintained BOLT11 decoder and payment adapter
   in your own application. Wire the host interfaces below, then enable payments
   deliberately. Standard MCP clients do not pay just because this prompt exists.

## Copy/paste integration boilerplate

The following Node.js module implements the post-admission, single-invoice L402
loop and a one-receipt yield claim. It deliberately requires **your** `wallet`,
`budget`, and `store` adapters; it is not a bundled wallet implementation.

Host-adapter contract:

- `wallet.decodeInvoice(text)` verifies the BOLT11 signature and returns
  `{ network: "bitcoin", amountMsats: bigint, paymentHash: string, expiresAt: number }`
  with expiry in Unix milliseconds.
- `wallet.payInvoice(text, { maxFeeMsats })` enforces the fee cap and returns
  `{ preimage }`. Timeouts remain unresolved, never automatically retried.
- `wallet.createInvoice({ amountMsats })` creates an exact receiving invoice
  and returns its BOLT11 string. It must not send a payment.
- `budget.reserve({ paymentHash, amountMsats })` atomically enforces approved
  per-invoice and aggregate budgets, including the supplied fee allowance.
- `store.reserve(hash)` atomically rejects duplicate or pending payment hashes;
  `store.savePaid(record)` protects and durably saves credentials;
  `store.saveClaim(record)` stores the receiving invoice, selection and response
  for recovery. Reservations survive process restarts and ambiguous outcomes.
- Optional `identityHeaders(url, method, body)` returns fresh
  `X-Nostr-Authorization` headers from the same signer for identity-bound passes.
  It must not return a competing `Authorization` header.

```js
import { createHash } from "node:crypto";

const ORIGIN = "https://bitcoinstratigraphy.com";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function runPaidDataOperation({
  requestBody, wallet, budget, store, maxFeeMsats,
  identityHeaders = async () => ({}),
}) {
  // requestBody is the exact serialized JSON-RPC request, including its ID.
  if (typeof requestBody !== "string" ||
      typeof maxFeeMsats !== "bigint" || maxFeeMsats < 0n) {
    throw new Error("Exact request body and approved fee cap required");
  }
  const url = `${ORIGIN}/mcp`;
  async function post(target, body, authorization) {
    return fetch(target, {
      method: "POST", redirect: "error",
      headers: {
        ...(await identityHeaders(target, "POST", body)),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body,
    });
  }
  const challengeResponse = await post(url, requestBody);
  if (challengeResponse.status !== 402) {
    // Normal/free responses and admission errors belong to the host client.
    return { response: challengeResponse, yieldClaim: null };
  }
  const header = challengeResponse.headers.get("www-authenticate") ?? "";
  // Strictly accept only the service's two quoted L402 attributes.
  // Unsupported layouts fail closed; use an auth-header library for extensions.
  const match = /^L402\s+macaroon="([^"\r\n]+)",\s*invoice="([^"\r\n]+)"$/i.exec(header);
  if (!match) throw new Error("Not a supported L402 invoice challenge");
  const [, macaroon, invoice] = match;
  const quote = await challengeResponse.json();
  if (quote.macaroon !== macaroon || quote.invoice !== invoice ||
      !Number.isSafeInteger(quote.amount_sats) || quote.amount_sats <= 0) {
    throw new Error("Conflicting L402 quote");
  }
  const decoded = await wallet.decodeInvoice(invoice);
  if (decoded.network !== "bitcoin" ||
      !/^[0-9a-f]{64}$/.test(decoded.paymentHash) ||
      quote.payment_hash !== decoded.paymentHash ||
      decoded.amountMsats !== BigInt(quote.amount_sats) * 1000n ||
      !Number.isSafeInteger(decoded.expiresAt) ||
      decoded.expiresAt <= Date.now() + 60_000) {
    throw new Error("Invalid, expired, wrong-network or mismatched invoice");
  }
  // No automatic second payment if reservation or wallet execution fails.
  await store.reserve(decoded.paymentHash);
  await budget.reserve({
    paymentHash: decoded.paymentHash,
    amountMsats: decoded.amountMsats + maxFeeMsats,
  });
  const { preimage } = await wallet.payInvoice(invoice, { maxFeeMsats });
  if (!/^[0-9a-f]{64}$/i.test(preimage ?? "") ||
      sha256(Buffer.from(preimage, "hex")) !== decoded.paymentHash) {
    throw new Error("Payment proof mismatch; preserve state for reconciliation");
  }
  await store.savePaid({ macaroon, invoice, preimage,
    paymentHash: decoded.paymentHash, amountMsats: decoded.amountMsats });
  if (decoded.expiresAt <= Date.now()) throw new Error("Paid invoice expired; recover");
  const response = await post(url, requestBody, `L402 ${macaroon}:${preimage}`);
  if (!response.ok) throw new Error("Paid retry failed; do not repurchase");
  // This small adapter supports JSON replies. Use the full MCP client for SSE.
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Use the host MCP parser for SSE; do not repay");
  }
  const data = await response.json();
  if (data.error || !data.result || data.result.isError === true) {
    throw new Error("MCP execution failed; retain the paid receipt");
  }
  // Data success remains available even if the independent withdrawal fails.
  try {
    const amountMsats = decoded.amountMsats * 21n / 100n;
    if (amountMsats <= 0n) throw new Error("Accumulate receipts before claiming");
    const receivingInvoice = await wallet.createInvoice({ amountMsats });
    const receiving = await wallet.decodeInvoice(receivingInvoice);
    if (receiving.network !== "bitcoin" || receiving.amountMsats !== amountMsats ||
        receiving.expiresAt <= Date.now() + 60_000) {
      throw new Error("Receiving invoice must match the exact claim");
    }
    const body = JSON.stringify({
      macaroons: [macaroon], bolt11_invoice: receivingInvoice,
    });
    // Persist before POST so a lost response cannot create a second withdrawal.
    await store.saveClaim({ paymentHash: decoded.paymentHash, body, state: "prepared" });
    const claimResponse = await post(`${ORIGIN}/api/claim-yield`, body);
    const claim = await claimResponse.json();
    await store.saveClaim({ paymentHash: decoded.paymentHash, body,
      httpStatus: claimResponse.status, response: claim });
    const settled = claimResponse.status === 200 &&
      claim.status === "SETTLED" && claim.payment_sent === true;
    return { data, yieldClaim: { settled, httpStatus: claimResponse.status, claim } };
  } catch {
    return { data, yieldClaim: {
      settled: false, recoveryRequired: true,
      message: "Recover saved claim state; do not repurchase or create a replacement claim",
    } };
  }
}
```

This is a deliberately limited adapter, not a replacement for the full MCP
transport. Use the host MCP client for discovery, admission proofs, SSE,
batching, and paid-pass reuse. Recover already-paid requests from your secure
store rather than calling this new-purchase helper again. An unsupported header
layout must fail closed, not silently switch invoices or payment rails.

### Claim response handling

| Result | Agent action |
| --- | --- |
| `200`, `SETTLED`, `payment_sent: true` | Record the completed withdrawal privately. |
| `202`, `PENDING` | Keep the exact claim ID, receipt selection and receiving invoice; do not initiate another withdrawal. |
| Lost response | Recover the saved identical claim request; never generate a replacement invoice for those receipts. |
| `409` | Treat as a replay/already-reserved/claimed condition, not a new payout; inspect saved state. |
| Other errors | Preserve data and receipts, report the problem, and do not repurchase data. |

The server may return a preimage and the legacy `coinos_txid` field for a
settlement. On the NWC path that field carries the Lightning payment hash, not
an on-chain transaction ID. Keep these proofs private. The operator-only
`/api/claim-yield/reconcile` route is not an agent credential or a second
payment mechanism.

## Why developers use this engine

- **Wallet-native data access:** pay approved Lightning invoices, not arbitrary
  transfer instructions embedded in retrieved content.
- **21% thermodynamic yield:** reclaim the eligible purchase allocation once,
  using verified paid receipts and your own receiving invoice.
- **Reusable payment proofs:** L402 credentials are bound to the purchased scope;
  reuse only within their time, quota, identity, and tool restrictions.
- **Clear settlement states:** spending, successful data execution, earned
  allocation, and completed withdrawal remain distinguishable.

For the complete payment and wallet-security guide, see
[L402 Agent Payments](../docs/L402_AGENT_PAYMENTS.md). For public broadcast
behavior, see [Yield Oracle](../docs/yield-oracle.md). These assets do not change
the repository's [license terms](../LICENSE.md) or grant a commercial exemption.
