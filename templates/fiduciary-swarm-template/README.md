# Article 12 Compliant AI Swarm (Zero-Trust L402)

**Fork the template. Connect your wallet. Give your agent a verifiable data boundary.**

Stop spending your first sprint wiring payment retries, MCP adapters and evidence
handling. This standalone Node.js starter combines a real LangChain autonomous
research agent with Bitcoin Stratigraphy's Central Bank through the published
`@bitcoinstratigraphy/agent-yield` SDK.

## The Mathematical Advantage

Build toward an agent that **mathematically eliminates hallucinations via
Thermodynamic State-Anchoring**: replace unsupported data access with
cryptographically verified evidence at the tool boundary, then require your agent
to cite the records it actually received. Do not ask a model to certify itself.

The distinction is operational: the SDK verifies server-signed payload bytes
against your independently pinned public key before returning a tool receipt.
Missing or tampered signatures fail closed instead of becoming model context.
The agent is instructed to stop guessing when evidence is unavailable.

**Zero bespoke integration. Four lines to connect your agent to the engine.**

```js
const connected = await withFiduciaryYield({
  ...agentConfig,
  fiduciary: { ...BUDGET, nwcUri, serverPublicKey, stateDirectory, mcpUrl: MCP_URL },
});
```

`MCP_URL` is fixed to **https://bitcoinstratigraphy.com/mcp**. The wrapper discovers
the current MCP catalog, supplies native LangChain tools, handles authorized
Lightning L402 payments and verifies signed responses. No private monorepo imports,
custom backend, TypeScript compiler or local database is required.

## Fork to First Run

**Prerequisites:** Node.js 22.9+, pnpm 10+, model-provider access, a restricted
Alby/NWC payer wallet and an independently trusted server Ed25519 public-key pin.
Installing a package does not create or fund a wallet.

Copy or fork **this directory** as its own project, or run it in place:

```sh
cd templates/fiduciary-swarm-template
pnpm install --frozen-lockfile
cp .env.example .env
```

Configure these three values in your private `.env` or secret manager:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Authorizes model inference; billed separately from Lightning. |
| `NWC_URI` | Authorizes L402 invoice payments from your limited payer wallet. |
| `FIDUCIARY_SERVER_PUBLIC_KEY` | Pins the server's Ed25519 SPKI **public** key. |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4.1-mini`. |

For the public-key PEM, use one quoted value with `\n` between its lines. Obtain
the pin through an independently trusted operator channel. Never automatically
trust a key fetched from the same response you are trying to verify. This
template does not generate, replace or rotate anyone's cryptographic keys.

The wallet integration point in `index.js` is marked explicitly:

```js
// TODO: Insert your Alby / NWC Lightning credentials here to authorize L402 payments
```

Keep credentials in configuration, not in that comment, source code or prompts.
Use a separate payer wallet with a small spending allowance and a restrictive fee
policy. A merchant trying to pay its own invoices is not a valid payer setup.

Validate configuration without a network request or payment:

```sh
pnpm start -- --check
```

Then launch the agent:

```sh
pnpm start -- "Inspect the catalog, summarize one available record, and cite its date."
```

LangChain runs the model/tool loop autonomously, with a ten-step recursion limit
and a two-minute invocation deadline. The SDK performs bounded MCP discovery and
routes paid calls through the existing L402 implementation. Model output goes to
stdout; the SDK's yield diagnostics remain on stderr.

## Guardrails That Ship With the Agent

- **Pinned-key verification:** unsigned or tampered tool responses are refused.
- **Read-only by default:** only the five stratigraphy read tools and
  `payment.get_info` are exposed. Clearing, settlement, proof-writing and trading
  actions are not available to the model.
- **Bounded Lightning authorization:** `config.js` defaults to 50 sats per
  invoice, 250 sats durable total authorization, a 250-sat session ceiling and a
  one-sat fee reservation. The wallet must also enforce its own limits.
- **Private payment evidence:** model-facing tools omit payment preimages and
  other private receipt credentials. The model receives the verified payload and
  selected receipt metadata, not the raw payment receipt.
- **Persistent recovery:** `.fiduciary-state/` retains the SDK's durable payment
  and recovery state. Keep it private and persistent between runs. Never delete
  it to bypass a spend cap or retry an unknown payment outcome.
- **No secret-bearing errors:** the CLI does not print raw provider exceptions,
  wallet URIs, authorization headers or payment proofs.
- **Developer-defined risk gate:** prompts involving PII, financial execution or
  code deployment stop before wallet connection, MCP discovery or model creation.
  The message instructs the caller to request and settle a dynamic server-issued
  L402 invoice via the approved MCP tool to clear the gate. This is an application
  policy, not a statutory Article 12 payment requirement or a legal assessment.
- **Paid, bounded delegation:** complex tasks may invoke
  `spawn_fiduciary_sub_agent(sub_task)`. Every child requires a fresh paid admission,
  shares the parent's SDK connection and cumulative Lightning limits, and receives
  only read-only tools. Two sequential child attempts maximum; children cannot
  spawn other children.

The SDK supports the engine's conditional programmatic L402 revenue sharing.
Allocations and successful outgoing withdrawals are different events; free
discovery, unconfirmed payments and pending claims are not paid yield.

## Risk Gate and Dynamic Paid Authorization

For example, this prompt halts locally without requesting a model or payment:

```sh
pnpm start -- "Explain handling PII in a research workflow."
```

The halt message explicitly instructs the agent to **request a dynamic L402 invoice
from the server via the approved MCP tool** and settle it through the shared SDK.
An operator may authorize that step:

```sh
pnpm start -- --authorize-risk "Explain handling PII in a research workflow."
```

`--authorize-risk` is permission to attempt the paid step, **not** proof of payment
and not a bypass. Before creating the model, the template calls the discovered
native adapter for `stratigraphy.get` with `{ days: 1, limit: 1 }`. This is an
existing paid grounding-data product: its HTTP 402 challenge supplies the actual
invoice and price, and the unmodified SDK handles payment and the authenticated
retry. The returned record becomes grounding data for the research task.

The gate clears only if the SDK returns a verified response with fresh, positive
settlement evidence and a valid payment-hash/preimage binding. A free response,
replayed payment, failed signature, application error, invoice above the shared
limits, or uncertain wallet result does not clear it. There is **no** fabricated
50-sat tariff, special compliance invoice endpoint, ZK-indemnity receipt or
government-issued approval. Payment never enables trading or code execution:
the tool allowlist remains read-only.

The existing **50-sat per-invoice and 250-sat cumulative caps remain unchanged**.
These are authorization ceilings, not quoted prices. If the server's dynamic
quote exceeds a cap, execution stops; the template never increases the cap or
splits a charge to evade it. Do not automatically repay after an uncertain
outcome. An already settled invoice is not automatically refunded if later
verification, model execution or delegation fails.

Risk screening uses conservative local keyword and identifier patterns. It may
flag harmless educational questions and miss contextual or obfuscated risks; it
is not exhaustive PII detection or a substitute for production policy controls.
Do not send sensitive records to a model solely because this check passed.

## Temporary Sub-Agents, Not Uncontrolled Replication

For a complex task, the main agent can choose its registered
`spawn_fiduciary_sub_agent` tool. A suitable request is:

```sh
pnpm start -- "Multi-step research: inspect the catalog, then compare available records, next check their provenance, finally summarize the evidence and its limitations."
```

The instance-scoped function is created by `createDelegationController` in
`delegation.js`. Its sequence is:

1. Require a nonempty subtask of at most 4,000 characters, a complex parent task,
   and a shorter estimated input text. Apply the risk gate again; a model cannot
   grant itself the operator's `--authorize-risk` permission.
2. Reserve one of **two total child attempts** before any asynchronous work.
   Parallel spawning is refused; failed attempts do not replenish the allowance.
3. Request the same server-priced grounding product through the **same SDK
   connection**, and require fresh settled payment evidence before constructing
   a child model. The parent gate and all children share one admission authority:
   one invoice cannot authorize two children or both a gate and a child.
4. Run an in-process temporary LangChain agent with a 600-output-token ceiling,
   six-step recursion limit and the parent's two-minute deadline. Child tools do
   not include the spawning function, so maximum delegation depth is **one**.
5. Return its answer, model-safe funding evidence and the cost estimate to the
   parent. Never pass payment preimages, macaroons or raw wallet errors to a model.
   Settlement or child-execution failure stops the run, rather than prompting an
   automatic replacement payment.

Normal single-step research does not acquire an extra admission invoice and does
not expose the spawning tool. Children may make additional paid data requests,
but those consume the same SDK spend circuit and durable total—not a fresh
per-child budget. No daemon, file replication, process spawning or persistent
sub-agent service is created.

**Cost heuristic, not an optimality proof:** approximate input-text tokens as
`ceil(character_count / 4)`. Delegation is eligible only when
`estimated_parent_input_tokens - estimated_subtask_input_tokens > 0`. This estimate
excludes system prompts, grounding records, outputs, network overhead, model fees
and Lightning charges. It does not prove lower total compute or financial cost;
the agent can solve the problem inline instead.

## Make It Your Swarm

Change `SYSTEM_PROMPT`, the default research request or your model selection.
Expand the explicit tool allowlist only after reviewing a tool's side effects
and input schema. The starter deliberately does not turn a model into a trader,
settlement operator or legal-compliance decision maker.

Run the local, wallet-free verification suite:

```sh
pnpm check
pnpm test
pnpm audit
```

Tests use synthetic data and a local model double. They do not contact the
production MCP endpoint, a model provider or a live Lightning wallet.
Paid-path tests exercise the published SDK's real 402 challenge/retry flow using
locally signed synthetic BOLT11 invoices, an intercepted wallet and disposable
in-memory server keys. They cover variable prices, shared limits, rejected proofs,
tampered responses, cancellation, bounded spawning and the main/child LangChain loop.

## Evidence, Not Another Promise

The title describes the Article 12-oriented architecture. A payload signature
proves which trusted server returned particular bytes; L402 proves payment.
Neither alone proves factual accuracy, Bitcoin anchoring, legal indemnity or
the faithfulness of a model's later narrative. Thermodynamic State-Anchoring
does not make every generated sentence mathematically hallucination-free.
Production compliance depends on your complete deployment and operating process.

**Deploy Fiduciary Flight Recorders to your swarm today.**

[Explore the Enterprise License and Contact Sales](https://bitcoinstratigraphy.com/enterprise)
for commercial licensing, private infrastructure and enterprise sizing.
