# @bitcoinstratigraphy/agent-yield

Node.js 22+ / TypeScript middleware for Bitcoin Stratigraphy's Central Bank.
The package ships the existing Fiduciary Router payment core, not a second
implementation: signed BOLT11 validation, durable invoice-bound tokens,
budget reservations, preimage verification and recoverable yield claims.
All local runtime sources are included in the npm package.

```sh
npm install @bitcoinstratigraphy/agent-yield
```

```ts
import { withFiduciaryYield } from "@bitcoinstratigraphy/agent-yield";
const agent = await withFiduciaryYield({ ...agent_config, fiduciary: { wallet, maxPaymentSats: 500, maxTotalSats: 5000 } });
```

`agent_config` is your existing agent configuration. `wallet` is your authorized
wallet adapter: `payInvoice(bolt11)` resolves to `{ preimage, fees_paid? }`;
fees are integer millisatoshis. Alternatively supply `nwcUri` or configure
`NWC_URI` in your secret manager. Never include wallet secrets in prompts,
source files or logs. No wallet is created or funded by installing the package.

The asynchronous factory automatically discovers the live MCP catalog,
preserves existing tools, and adds callable tools and `agent.fetch`. Pass the
returned configuration to your framework. This is not a global fetch patch
and does not retrofit private internals of an already-created agent.

## Frameworks

- **Custom:** default tools have `name`, `description`, `inputSchema` and
  `invoke(arguments)`. Or call `agent.fiduciary.callTool(name, arguments)`.
- **LangChain JS:** install `@langchain/core` 1.x and set
  `framework: "langchain"` in `agent_config`. The returned `tools` contains
  native LangChain tools; pass the configuration to `createAgent`.
- **AutoGen / OpenAI-compatible bridges:** set `framework: "openai"` for
  function-tool descriptors in `agent.tools`. Dispatch model-requested calls
  with `agent.fiduciary.executeTool(call.function.name,
  JSON.parse(call.function.arguments))`. The dispatcher maps safe function
  names back to canonical MCP names. Python AutoGen cannot import a Node
  module directly; use a Node bridge or the existing Python MCP SDK.

## Fiduciary Armor (0.2)

Set `fiduciary.max_spend_sats` (default **5000**, integer satoshis) alongside
the existing required `maxPaymentSats` and `maxTotalSats`. The new session
circuit breaker is an additional in-memory cap, not a replacement for durable
cross-process accounting. It reserves invoice principal plus `feeReserveSats`
before wallet access, then accounts for verified payments and reported routing
fees. Unreported fees retain their conservative allowance; unknown payment
outcomes remain reserved. A wallet must enforce its own fee ceiling. Unexpected
excess fees latch the session breaker and keep the existing durable block.

Once capacity is exhausted, tool calls/raw routed fetches throw
`CircuitBreakerError: Maximum authorized thermodynamic spend reached.`
without making another outbound routing request. When a price is not yet known,
one unpaid 402 quote may be needed; an oversized quote latches the breaker
**before payment or the authorized HTTP retry**. Subsequent calls stay blocked.
Public catalog discovery and recovery of existing yield claims remain available.
In-flight requests already admitted can finish within their reserved capacity.
Instantiate a new client to start a new session; **never delete durable wallet
state to reset spending authorization**.

All successful tool entry points, including framework tools, now return a
`TruthReceipt` rather than the bare result:

```ts
const receipt = await agent.fiduciary.callTool("proof.verify", args);
console.log(receipt.payload); // the previous return value
// receipt.thermodynamic_cost: exact decimal-string sats (invoice principal)
// receipt.timestamp: UTC client-observed settlement time
// receipt.cryptographic_proof: verified L402 payment preimage
```

`payment_hash` binds the preimage to its invoice, and `payload_sha256` is a local
digest of the SDK's JSON serialization of the returned payload. **L402 proves
payment, not payload integrity or Bitcoin anchoring.** `evidence_scope` explicitly
states `payment_only`; the local digest is not a signed server attestation.
Genesis/free calls have zero observed cost, a null proof, and
`payment_not_observed` scope; externally supplied credentials also have no new
SDK-observed payment. Their timestamp is receipt creation, not settlement.
Legacy paid records lacking a stored settlement time report `timestamp: null`
with `timestamp_kind: "unknown"` rather than inventing a time.

Treat receipts containing preimages as sensitive payment evidence, not public
telemetry or prompt content. Raw `agent.fetch` deliberately remains a native
HTTP `Response`; it enforces the breaker but does not change HTTP framing.
Yellow/green stderr receipts include remaining capacity and never print proofs.
This return-shape change is available in **0.2.0**. Building does not publish updates.

### Transport and settlement

Stateless MCP 2026-07-28 discovery, pagination, JSON/SSE responses and bounded
invoice-admission proof-of-work are handled internally. Paid calls receive
an invoice, validate it against the quote and limits, pay through your wallet,
then retry the identical request with its L402 credential. Tokens are scoped to
the exact invoice/request, not reused across unrelated tools or calls.
Existing Authorization credentials are never overwritten or automatically repaid.
This package uses Lightning L402, not x402 or custodial NWC_LOOKUP settlement.

Set `identityHeaders(url, method, body)` to your fresh NIP-98 signer when
authenticated attribution is needed. It runs for the initial MCP request and
again for the paid retry. Do not return stale fixed NIP-98 events.

Limits are explicit integer satoshis. `feeReserveSats` defaults to 10 per
invoice, reserved inside the cumulative limit. Unknown payment outcomes remain
reserved: **do not delete the state directory or retry with a new directory**.
`stateDirectory` defaults to `.agent-yield-state`; put it on private persistent
storage, use a separate directory per wallet/policy, and exclude it from Git.
Budget reservations intentionally persist across process restarts; they are
not refunded merely because a request or claim failed.

Automatic yield claims retain the existing router behavior. A wallet with
`makeInvoice(amountMsats)` enables receiving invoices. Claims are best effort,
not guaranteed income; errors are reported to `onError`, not thrown into a
successful tool result. `await agent.fiduciary.drain()` waits for background
claims at shutdown. `recoverClaim(paymentHash)` replays only an already-prepared
claim body, never purchases another tool invoice.

## Terminal receipts

Successful paid execution prints a single-line yellow ANSI receipt when the
router calculates its 21% yield allocation. A green
`[Bitcoin Stratigraphy] ⚡ Thermodynamic Yield Earned: 21 Sats routed to agent wallet.`
receipt appears only after a confirmed settled claim. Allocation is not payment:
pending or failed claims never print an earned receipt. Amounts preserve
millisatoshi precision, and receipts contain no keys, invoices or payment proofs.

Receipts use stderr so stdout remains safe for MCP/JSON transports. Set
`QUIET_STRATIGRAPHY=true` to disable both receipts in production. This is checked
for each event, including background claims. Existing `onYieldClaim` and `onError`
callbacks still run, and logging failures cannot affect payments or tool results.

## Local development and release

```sh
pnpm --filter @bitcoinstratigraphy/agent-yield test
pnpm --filter @bitcoinstratigraphy/agent-yield typecheck
pnpm --filter @bitcoinstratigraphy/agent-yield pack --out generated-artifacts/agent-yield.tgz
```

The compiler extracts the existing router and admission solver into `dist`.
Consumers do not need this repository, a workspace link or a compiler.
The npm install command above is the intended public package name;
building/committing does not publish it. Registry publication is a separate
release step.
