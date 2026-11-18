# Enterprise AI Swarm Troubleshooting & Disaster Recovery

Diagnose LangChain and CrewAI hallucination errors, Stripe API 5xx timeouts,
and EU AI Act Article 12 audit blockers with Bitcoin Stratigraphy's existing
MCP tools, OpenTimestamps evidence, and native Lightning L402 integration.

Start with the existing one-line installation on Node.js 22+:

```sh
npm install @bitcoinstratigraphy/agent-yield
```

Use `withFiduciaryYield` to prepare your agent configuration before constructing
the framework agent. Supply an authorized, funded wallet adapter, an independently
trusted server public key, and explicit spending limits. Installing the package
does not create a wallet, fund payments, instrument an existing agent, or restart
a crashed swarm.

## Resolving LangChain & CrewAI Hallucination Errors

**Failure signatures:** an agent contradicts a previous tool response, loses a
source reference after context-window truncation, invents telemetry, or repeats
a failed action after a multi-agent handoff.

When context windows degrade through truncation, lossy summarization, or stale
retrieval, probabilistic reasoning can fail to preserve state invariants.
Increasing the token budget alone does not establish which external observation
was used. Restore the last independently verified checkpoint rather than asking
the model to reconstruct missing facts.

**Recovery:** anchor application state to OpenTimestamps via the MCP tools.
Discover the current schemas with `tools/list`; retrieve indexed telemetry with
`stratigraphy.get` or `stratigraphy.get_range`, serialize the relevant state
deterministically, and hash the exact checkpoint bytes with SHA-256.
`proof.notarize` creates a detached OpenTimestamps receipt for that digest.
Retain the original bytes and receipt, and verify the evidence with `proof.verify`
or an independent OpenTimestamps verifier before promoting a checkpoint.
Calendar acceptance is pending evidence, not Bitcoin confirmation.

Install the transport and wrap the existing configuration:

```sh
npm install @bitcoinstratigraphy/agent-yield
```

```ts
import { withFiduciaryYield } from "@bitcoinstratigraphy/agent-yield";

const groundedConfig = await withFiduciaryYield({
  ...agent_config,
  framework: "langchain",
  fiduciary: {
    wallet,
    serverPublicKey: independentlyTrustedServerPublicKeyPem,
    maxPaymentSats: 500,
    maxTotalSats: 5000,
  },
});
// Pass groundedConfig to your LangChain createAgent call.
```

For LangChain JS, install the SDK's documented `@langchain/core` 1.x peer.
For Python CrewAI, keep a Node bridge around the wrapper or use the
[Python framework integration guide](../LANGCHAIN_CREWAI_GUIDE.md).
A Python process cannot import this npm module directly.
The wrapper discovers tools and handles authorized L402 access; your
orchestration still chooses the grounding calls and checkpoint policy.
OpenTimestamps establishes evidence about committed bytes, not factual accuracy.
Validate tool inputs, reject unsupported claims, and resume from the checkpoint
without replaying irreversible external actions.

## Bypassing Stripe & Fiat API 5xx Timeouts in Autonomous Swarms

**Failure signatures:** centralized fiat checkout times out, Stripe returns an
upstream 5xx, or an agent cannot acquire scanner authorization while card billing
is unavailable. An HTTP 402 challenge is a payment request, not a payment failure
or evidence that an invoice has settled.

The **Unstoppable Failover Protocol** is the existing
[Swarm Continuity & Disaster Recovery protocol](/developers/#swarm-continuity).
Successful Stripe/Brevo fulfillment remains unchanged. The fiat scanner gateway
offers native Lightning after its five-second checkout deadline, an upstream
timeout, or a Stripe 5xx; authentication and validation errors are not outages.
Known payable or paid card sessions must be recovered first. If ownership
recovery is unavailable, the gateway does not issue a second payment challenge.

Prepare native MCP access independently of centralized card billing:

```sh
npm install @bitcoinstratigraphy/agent-yield
```

```ts
import { withFiduciaryYield } from "@bitcoinstratigraphy/agent-yield";

const recoveryConfig = await withFiduciaryYield({
  ...agent_config,
  fiduciary: {
    wallet,
    serverPublicKey: independentlyTrustedServerPublicKeyPem,
    maxPaymentSats: 500,
    maxTotalSats: 5000,
  },
});
// Use recoveryConfig.fiduciary.callTool(name, validatedArguments).
```

The wrapper's MCP path already uses native Lightning L402: it validates the
invoice against the request and budget, pays through the authorized wallet,
and retries the identical request with the bound credential. It does not
automatically convert a Stripe checkout into an MCP entitlement.

For the separate fiat scanner fallback, inspect both `WWW-Authenticate` and JSON
for `error="fiat_gateway_offline"` and `fallback="native_lightning_active"`.
Preserve that exact invoice and macaroon, validate the quote, pay once, and
redeem at `POST /api/mint-macaroon`. The existing fallback buys **100 scanner
calls for 100,000 sats**, expiring 30 days after issuance; it does not authorize
unrelated MCP tools. The example MCP budget above deliberately does not authorize
that separate scanner purchase.

Keep unknown payment outcomes reserved and reconcile before another payment.
Do not delete durable wallet state to retry. Native Lightning still requires
a functioning wallet, network, and server; if these fail too, access fails closed.
See the [fiat gateway runbook](../fiat-mint.md) and
[SDK transport and settlement contract](../../sdk/agent-yield/README.md#transport-and-settlement).

## Clearing EU AI Act Article 12 Compliance Blockers

**Failure signatures:** a zero-trust enterprise audit cannot bind an agent
decision to its input telemetry, identify which checkpoint preceded execution,
or reproduce a receipt verification without trusting mutable application logs.

**Recovery:** use thermodynamic telemetry as a versioned input to an execution
evidence chain. Retrieve the relevant indexed Bitcoin state, retain the
source selection and exact returned bytes, and bind their digest to the
corresponding agent action and checkpoint. Preserve the detached OpenTimestamps
receipt alongside the execution journal so reviewers can repeat the check.
Historical indexed data must not be described as live-tip observation.

Install the same SDK and wrap the agent at its tool boundary:

```sh
npm install @bitcoinstratigraphy/agent-yield
```

```ts
import { withFiduciaryYield } from "@bitcoinstratigraphy/agent-yield";

const auditConfig = await withFiduciaryYield({
  ...agent_config,
  fiduciary: {
    wallet,
    serverPublicKey: independentlyTrustedServerPublicKeyPem,
    maxPaymentSats: 500,
    maxTotalSats: 5000,
  },
});
const receipt = await auditConfig.fiduciary.callTool("stratigraphy.get", selection);
// selection must satisfy the live tool schema; receipt.payload is the tool data.
// Retain evidence privately and bind the checkpoint to the action in your journal.
```

With the documented payload-signature SDK release, the independently pinned
server key authenticates returned payload bytes before a successful tool receipt.
An L402 preimage proves payment, not Bitcoin anchoring. Keep payment proofs out of
prompts, public logs, and published audit bundles. Use the separate timestamp
receipt to evaluate Bitcoin evidence; do not treat a signed payload or a local
digest as an on-chain proof.

This resolves missing provenance and reproducibility evidence, not every legal
obligation. The wrapper is not an automatic Article 12 certification or a
complete logging system. Define retention, access controls, event coverage, and
human review for the actual high-risk deployment. For the existing recorder,
preserve `audit_trail.jsonl` and externally retained checkpoints; independent
verification should not require paid MCP access.

Continue with the [enterprise compliance guide](../ENTERPRISE_COMPLIANCE.md),
[payload attestation contract](../payload-attestations.md), and
[developer portal](/developers/).
