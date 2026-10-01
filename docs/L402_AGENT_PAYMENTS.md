# Agent-owned L402 payments for Bitcoin Stratigraphy MCP

This guide describes an **opt-in, agent-side** Lightning payer for the Bitcoin
Stratigraphy MCP endpoint:

`https://bitcoin-stratigraphy-dashboard.replit.app/mcp`

It covers the payer's wallet connection and the safeguards required before an
agent spends. It does not enable payments on the server, configure the
operator's wallet, or cause a standard MCP client to pay automatically.

> **Do not confuse the two wallet roles.** The NWC URI in this guide belongs to
> the agent/operator running the payer and authorizes **outgoing** payments.
> The service operator separately controls its **inbound** wallet/provider
> credentials for creating and checking invoices. Those operator secrets are
> not agent credentials, must never be requested or copied into an agent, and
> are not needed to pay a challenge. Use only an agent-owned, dedicated payer
> connection. No live payments or secret reads are part of this guide.

This guide covers the MCP **Lightning L402** path only. MCP can also offer
Base USDC x402 when that settlement path is configured, but it uses a distinct
payment flow and is not implemented by the Lightning examples below. The
separate REST router may advertise `btc-lightning`, `l-btc`, or
`taproot-assets` according to configuration reported by `/api/v1/cost`; that
does not make those rails available in this MCP flow. Current MCP price
examples are 250 sats for most paid tools and 10 sats for `proof.list`; check
`payment.get_info` for authoritative live prices.

## What happens during an L402 call

1. An agent makes an ordinary MCP `tools/call` over Streamable HTTP.
2. If the requested tool is paid and no valid credential is supplied, the
   server returns HTTP `402` with an L402 challenge.
3. The agent validates the challenge, obtains explicit budget authorization,
   and asks its own wallet to pay the **exact BOLT11 invoice**.
4. The wallet returns the invoice's 32-byte payment preimage. The agent checks
   `SHA256(preimage) == payment_hash` before using it.
5. The agent retries the **same JSON-RPC call once** with
   `Authorization: L402 <macaroon>:<preimage>`.
6. The call either succeeds or fails. A second 402 is terminal for that
   attempt: do not pay again automatically.

MCP discovery, framework tool registration, and ordinary clients do not
themselves settle Lightning invoices. Automatic payment exists only if the
application explicitly wires in a payer and calls a payment-capable client
under a user-approved spending policy. Configure a hard per-payment and
aggregate budget before enabling that path.

Ask the service for current prices using free `payment.get_info` discovery
rather than treating a cached price list as authoritative. See
[CONNECT.md](../CONNECT.md#tool-catalog-and-pricing) for the endpoint, MCP
setup, and published tool catalog.

## Wallet connection: agent payer only

Create a separate NWC connection in a wallet you control for this agent or
workload. Prefer a connection that can be revoked independently, has a small
wallet-side spending limit and short lifetime, and cannot receive invoices or
perform unrelated wallet administration.

Grant only the capabilities required by the chosen implementation:

- `pay_invoice` to pay the fixed invoice returned in a validated challenge.
- `lookup_invoice` to reconcile a payment by its payment hash after a timeout.
- `list_transactions` only if the wallet/provider's reconciliation procedure
  needs it and its listing data is necessary to determine payment status.

Wallets differ in how they express these permissions and budgets. Check the
connection's advertised capabilities and its wallet-side authorization
settings; do not assume that every provider implements lookup/list methods.
If required reconciliation capability is unavailable, fail closed on an
ambiguous payment result. Do not broaden permissions simply to make an
unverified retry work.

Store the agent's NWC URI in the agent's own secret store, referenced by an
environment **placeholder** such as `AGENT_PAYER_NWC_URI`. Do not put a real
URI in source, logs, prompts, issue reports, MCP configuration, or this guide.
An NWC URI includes a client secret and is equivalent to a wallet credential.
Never load or use any service/operator inbound-wallet secret, such as a
server-side NWC URI, to pay an agent's invoice.

## NIP-47 `pay_invoice`: protocol result and preimage

NIP-47 specifies the encrypted `pay_invoice` request method with an invoice
parameter (and optional amount/metadata fields). A successful response has
`result_type: "pay_invoice"` and a `result` containing `preimage`; `fees_paid`
may also be returned. The NIP-47 response envelope has `error: null` on
success, or a non-null error with a code and human-readable message on
failure. The returned preimage is the payment proof needed by L402; a payment
transaction ID is not a substitute.

The wallet response does **not** mean the MCP call was retried or the result
was delivered. NWC payment and HTTP/MCP delivery are separate operations.
Persist only appropriately protected reconciliation state; never log the
preimage, full NWC URI, macaroon, or full Authorization header.

### Verified `@getalby/sdk` API example

In the **consuming agent project**, install the wallet SDK, not in this server's
workspace:

```sh
npm install @getalby/sdk
```

Use your project's normal lockfile and reviewed-version policy. Save the
following adapter in an agent-side TypeScript module. Supply
`AGENT_PAYER_NWC_URI` through your own protected runtime secret store; there is
no reason to request this service's wallet credentials.

The official Alby JavaScript SDK documents `NWCClient` from
`@getalby/sdk/nwc`, initialized with `nostrWalletConnectUrl`, and
`payInvoice({ invoice })` returning a response with a `preimage`. The project's
installed SDK declarations also type the returned NIP-47 payment response as
`{ preimage: string; fees_paid: number }`. This adapter is intentionally
inert at import time: it creates a client when explicitly requested, but only
the returned method sends a payment. It does not itself validate a 402
challenge, enforce budgets, or reconcile timeouts.

```ts
import { NWCClient } from "@getalby/sdk/nwc";

type NwcPaymentResponse = {
  preimage: string;
  fees_paid?: number;
};

export function createAgentNwcPayer() {
  const nwcUri = process.env.AGENT_PAYER_NWC_URI;
  if (!nwcUri) {
    throw new Error("Set AGENT_PAYER_NWC_URI in the agent's secret store");
  }

  const client = new NWCClient({ nostrWalletConnectUrl: nwcUri });

  return {
    async payInvoice(invoice: string): Promise<string> {
      // The caller must already have validated and approved this exact invoice.
      const result = await client.payInvoice({ invoice }) as NwcPaymentResponse;
      if (typeof result?.preimage !== "string" ||
          !/^[0-9a-fA-F]{64}$/.test(result.preimage)) {
        throw new Error("NWC did not return a 32-byte hex payment preimage");
      }
      return result.preimage.toLowerCase();
    },
    close(): void {
      client.close();
    },
  };
}

// No payment is made by importing this module or constructing the adapter.
// Invoke payInvoice only from an explicitly enabled, budgeted payment flow.
```

Do not blindly adopt wallet/API response types from a blog or old SDK sample.
Pin and review the SDK version you deploy, retain runtime validation, and
re-verify the provider's current permission and timeout semantics. When using
a different NWC library, implement the same typed adapter contract rather than
guessing its method names or return shape:

```ts
type AgentLightningPayer = {
  // Pays this exact, already-validated fixed-amount invoice once.
  payInvoice(invoice: string): Promise<string>; // 32-byte hex preimage
  // Reconcile an already-attempted payment; this must never initiate a payment.
  lookupPayment(paymentHash: string): Promise<
    | { state: "settled"; preimage: string }
    | { state: "pending" | "unpaid" | "failed" | "unknown" }
  >;
};
```

The adapter is a boundary, not the policy engine. The caller must validate the
preimage against the challenge's payment hash and must not treat an adapter's
claimed "success" as proof until that check passes.

## Validate the complete 402 before authorizing payment

Treat the challenge as untrusted input. Parse and validate it before calling
the wallet, and fail closed on missing, malformed, conflicting, or unexpected
fields. For the endpoint above, the L402 response is documented to include:

- `WWW-Authenticate: L402 macaroon="…", invoice="…"`
- A JSON body containing `macaroon`, `invoice`, `payment_hash`, and
  `amount_sats`.

Require all of the following:

1. The response is exactly HTTP `402` from the expected HTTPS `/mcp` endpoint;
   disallow redirects.
2. The header scheme and expected fields parse strictly. The body's `macaroon`
   and `invoice` must exactly equal their corresponding header values. Reject
   duplicate/ambiguous values, control characters, unexpected schemes, or
   missing body fields.
3. The invoice is a valid, fixed-amount BOLT11 invoice for the intended
   Lightning network. Decode it with a maintained BOLT11 implementation.
   Reject amountless invoices, wrong networks, malformed invoices, invoices
   whose encoded amount does not exactly equal `amount_sats` converted to
   millisatoshis, or invoices exceeding the configured per-call cap. Do not
   modify, regenerate, trim, or substitute an invoice.
4. `payment_hash` is exactly 32 bytes (64 hex characters), and agrees with the
   decoded BOLT11 invoice's payment hash. The challenged amount must also be
   consistent with the current tool price and local policy; if not, stop and
   inspect instead of paying.
5. The invoice has not expired and has adequate time remaining for payment,
   settlement, and the retry. Check its decoded creation time and expiry before
   payment and again before retry. If it expires, do not pay it; return to the
   caller and obtain a fresh challenge only through a deliberate new attempt.
6. Reserve the full authorized spend, including the maximum permitted wallet
   fee, against a durable budget before payment. If the policy cannot
   atomically reserve the amount or the reserve would exceed any cap, reject
   the call.

Amount units matter: NWC payment methods commonly express amounts/fees in
millisatoshis, while this challenge reports `amount_sats`. Convert with exact
integer arithmetic (`amount_sats * 1_000` msat); do not use floating-point
rounding. An invoice's payment amount and any fee are different budget items:
bound both.

## Verify the preimage and retry exactly once

For a normal Lightning preimage:

- Require exactly 32 bytes (64 hexadecimal characters).
- Compute SHA-256 over the **32 raw preimage bytes**, not the UTF-8 text of the
  hex string.
- Compare the digest to the validated challenge payment hash using a
  constant-time comparison where practical. Any mismatch is a hard failure:
  do not send the credential to the server and do not try another invoice.
- Retry the exact same JSON-RPC request body and request ID once, with
  `Authorization: L402 <challenge-macaroon>:<preimage>`. Do not retry with
  different tool arguments, a newly generated call, or different credentials.
- If the retry returns another `402`, stop. Do not pay again automatically.
  Surface the payment/call state for operator reconciliation.

The macaroon/preimage credential is scoped to the paid call and is single-use.
Do not cache it for another tool or request, share it between agents, or treat
`payment.get_info` settlement as a reusable access token. For parallel work,
coordinate duplicate calls and challenges before invoking a wallet.

### CoinOS internal-payment UUID is not a preimage

A CoinOS internal-payment UUID/reference is **not** a 32-byte Lightning
preimage. It cannot satisfy `SHA256(preimage) == payment_hash`. Do not hash the
UUID, reinterpret it as hex bytes, invent a conversion, or put it into a
preimage-only flow.

Some server-side CoinOS verification paths can reconcile a provider-specific
internal transfer by consulting both the issuer's incoming payment and the
payer's outgoing payment records. That is a distinct, provider-specific
verification flow; it is not a BOLT11 preimage, does not authorize weakening
the hash check, and does not turn the operator's inbound-wallet credentials
into agent credentials. If an agent wallet returns a UUID instead of the
actual preimage, this guide's standard L402 payer must stop and report that
the selected wallet mode is unsupported.

## Budgets, reservations, and concurrent agents

A wallet-side connection limit is useful, but does not replace the agent's
own policy. Enforce explicit limits such as maximum sats per call, maximum
wallet fee, daily/period budget, allowed tool names, and a maximum number of
concurrent payments.

Budget reservations and in-flight-call deduplication must be durable and
atomic across processes/agents:

- Deduplicate an identical in-flight RPC operation before paying. Bind the
  deduplication key to the endpoint, tool name, canonical arguments, and
  operation identity; do not reuse a paid credential across calls.
- Reserve funds atomically before invoking NWC. Concurrent callers must not
  each observe the same remaining balance and overspend it.
- Deduplicate payment attempts by the validated invoice/payment hash and
  retain a durable state such as `reserved`, `paying`, `settled`,
  `reconciled`, `failed`, or `indeterminate`.
- Release a reservation only after an authoritative outcome proves the
  payment did not settle, or after policy explicitly accounts for a settled
  payment. A client/network error alone is not proof of non-payment.
- Treat contention, storage errors, missing state, unsupported transaction
  semantics, and unknown wallet outcomes as **fail closed**. Do not pay if
  the reservation or deduplication store is unavailable.

Never let an old 402 overwrite a newer challenge or lead to a second payment.
Use one in-flight payment owner per challenge/payment hash and ensure other
workers wait for its durable result or fail safely.

## Timeouts and reconciliation: never blindly repay

A timeout can occur after the wallet paid but before the agent received the
NWC response. It can also occur after the service accepted payment but before
the MCP response reached the agent. Neither case is proof that payment failed.

On an ambiguous timeout:

1. Mark the attempt `indeterminate` and keep the budget reserved.
2. Reconcile by the original payment hash/invoice using the agent's own NWC
   `lookup_invoice` capability and, if the wallet requires it, restricted
   `list_transactions` access. Confirm the exact invoice, amount, payment
   status, and returned preimage where available.
3. If settled and a valid preimage is available, verify its SHA-256 binding;
   only then may the original same-call retry be attempted, and only while its
   challenge is still valid and the one-retry rule has not been used.
4. If the wallet confirms unpaid/failed and the invoice is still valid, apply
   a deliberate retry policy against that same attempt; do not create a second
   payment while status is unknown.
5. If reconciliation is unavailable or inconclusive, retain the
   `indeterminate` state and alert for manual review. Do not blindly repay,
   replace the invoice, or start another call that could duplicate the spend.

This conservative behavior favors preventing duplicate payments over
automatically recovering every interrupted request.

## Using the existing TypeScript MCP client

The actual MCP API in [`sdk/typescript/client.ts`](../sdk/typescript/client.ts)
is `BitcoinStratigraphyClient`, with `callTool(name, args)` and typed helpers
such as `getStratigraphyDigest(args)`. It does **not** export an
`invokeMcp` function. Its constructor accepts `(serverUrl?, wallet?,
fetcher?)`; the wallet callback receives an invoice string and must return a
preimage (or one of the documented object wrappers).

For example, a caller can wire a previously created payer into the SDK:

```ts
import { BitcoinStratigraphyClient } from
  "@bitcoin-stratigraphy/sdk/mcp";

const payer = createAgentNwcPayer(); // no payment is sent here
const client = new BitcoinStratigraphyClient(
  "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
  (invoice) => payer.payInvoice(invoice),
);

// This explicit paid-tool call may invoke the callback after a 402.
// Call it only inside the budget, validation, and reconciliation controls
// described above; this example intentionally does not execute a call.
// const digest = await client.getStratigraphyDigest({ target: "latest" });
// Close the payer's relay connection in your application's shutdown/finally path:
// payer.close();
```

The SDK is a useful one-shot transport/client, not a complete production
spending controller. Its current L402 flow validates the challenge header/body
fields and verifies a 64-hex preimage against the challenge hash, then retries
once and rejects a second 402. Its wallet callback receives only the invoice;
the SDK does not implement an agent's atomic budget reservation, invoice
expiry/network/amount policy, cross-process deduplication, or ambiguous-timeout
reconciliation. Build those controls around the payment path or use a
challenge-aware transport/policy layer. Do not assume current advertised
prices or the SDK's hash check enforce your complete spending policy.

See the [SDK client guide](../sdk/README.md) for the documented call surface
and wallet callback contract. It also warns against substituting transaction
IDs or UUIDs for preimages.

## Provider adapter outline: LND and Core Lightning

NWC is one way to reach the **agent's payer wallet**. A direct node adapter
must enforce the same policy and remain separate from the server's inbound
settlement/provider integration.

- **LND:** use a narrowly scoped macaroon (or a dedicated wallet-service
  connection) that permits paying invoices and reading payment status only.
  Decode/validate the challenge independently; submit the exact BOLT11 invoice
  once; obtain the preimage and payment hash/status from the wallet's payment
  result; reconcile by payment hash after timeout. Restrict TLS credentials,
  RPC access, and macaroon permissions. Never expose admin/macaroons to an
  agent model.
- **Core Lightning (CLN):** use an authenticated local RPC interface with
  least-privilege access to pay the exact invoice and query its payment state
  by hash. Preserve the node's returned preimage/payment hash and reconcile
  uncertain outcomes before any retry. Protect the RPC socket/credentials and
  keep policy outside model-controlled tool arguments.

These are adapter design outlines, not drop-in command examples. Node API
names and access controls vary by version and deployment; verify them against
the official documentation for the exact deployed release before wiring a
real wallet.

## Troubleshooting

| Symptom | Safe response |
| --- | --- |
| No L402 challenge or malformed header/body | Do not pay. Confirm endpoint, HTTP status, and exact header/body agreement. |
| Wallet says `UNAUTHORIZED` / method unsupported | Check the agent connection's `pay_invoice` permission and advertised NIP-47 capability. Do not use a server credential. |
| `INSUFFICIENT_BALANCE`, quota, or policy rejection | Stop and surface the wallet's error. Do not silently raise the cap or create another connection. |
| NWC timeout, relay disconnect, or no response | Mark payment indeterminate and reconcile by hash. Do not send another payment. |
| Expired or nearly expired invoice | Do not pay it. Request a fresh challenge only after the prior attempt is known not to have paid. |
| Invoice amount, hash, network, or tool price mismatch | Fail closed; do not call the wallet. Report the mismatch for investigation. |
| Preimage length or SHA-256 mismatch | Do not retry the MCP request or disclose the value. Treat as a wallet/response integrity failure. |
| Retry still receives HTTP 402 | Stop after the single retry. Keep outcome state and reconcile; never pay a second challenge automatically. |
| UUID returned instead of preimage | Unsupported for the ordinary preimage flow. Do not hash or convert it; use a wallet/API that returns the actual preimage. |
| MCP response is lost after confirmed payment | Reconcile and retry only the same call, using the original valid single-use credential once if permitted; otherwise surface for manual review. |

## Production controls intentionally left to the integrator

The examples here are educational, not a production autopay product. Before
deployment, implement and review: secure secret storage and rotation; audited
wallet-side permissions and spending limits; challenge-aware exact BOLT11
decoding; network and expiry checks; tool allowlists; fees and aggregate
budgets; durable atomic reservations; cross-process idempotency; state
recovery after crashes; rate limits; RPC response and content-type validation;
safe logging/redaction; alerting and manual reconciliation; cancellation and
revocation; dependency/version review; and adversarial/concurrency tests.
Require an explicit operator decision to enable unattended payments, and make
the default configuration non-paying.

Never expose payment credentials, preimages, macaroons, or NWC URIs to an LLM
prompt or tool result. Make the approval decision in trusted application code,
not in instructions supplied by the remote MCP server or the agent model.

## Sources

- [Claude Desktop setup](CLAUDE_DESKTOP_SETUP.md) — discovery-only desktop connection; no automatic payer.
- [LangChain and CrewAI integration](LANGCHAIN_CREWAI_GUIDE.md) — Python wrappers and the separate L402 transport boundary.
- [NIP-47: Nostr Wallet Connect (official NIPs repository)](https://github.com/nostr-protocol/nips/blob/master/47.md) — protocol requests, response envelope, connection URI, and error codes.
- [Alby JavaScript SDK NWC documentation](https://github.com/getAlby/js-sdk/blob/master/docs/nwc.md) — official `NWCClient` usage, `payInvoice({ invoice })`, and client setup.
- [Alby JavaScript SDK API reference](https://getalby.github.io/js-sdk/classes/nwc.NWCClient.html) — `NWCClient` methods.
- [Bitcoin Stratigraphy connection guide](../CONNECT.md) — MCP setup, discovery, pricing, and the L402 flow.
- [Bitcoin Stratigraphy MCP SDK guide](../sdk/README.md) — TypeScript/Python MCP client usage and callback requirements.
- [Bitcoin Stratigraphy TypeScript client source](../sdk/typescript/client.ts) — actual constructor, call methods, and current L402 handling.