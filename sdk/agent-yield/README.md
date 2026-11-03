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

## Automatic connection and settlement

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
