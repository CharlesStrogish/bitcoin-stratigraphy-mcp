---
title: "Enterprise AI Swarm Troubleshooting & Disaster Recovery"
date: "2026-11-17"
slug: "enterprise-troubleshooting"
description: "Resolve LangChain and CrewAI hallucination errors, Stripe API 5xx timeouts, and Article 12 audit evidence blockers with MCP, OpenTimestamps, and Lightning L402."
---

When an autonomous swarm crashes, first separate **context corruption**,
**payment-provider unavailability**, and **missing audit evidence**. Retrying
the entire workflow can compound all three: fabricated state propagates,
uncertain invoices are paid twice, and the original execution trace is lost.
Bitcoin Stratigraphy's existing MCP tools provide telemetry, timestamp evidence,
and native Lightning access without replacing your orchestration framework.

This runbook uses the existing Node.js 22+ SDK. Code examples assume your existing
`agent_config`, an authorized `wallet` adapter whose `payInvoice(bolt11)` returns
`{ preimage, fees_paid? }`, and an independently trusted server public key.
Wallet routing fees are integer millisatoshis. Configure wallet secrets outside
source code, prompts, and logs. Installation alone does not fund a wallet or
restart an agent.

## Resolving LangChain & CrewAI Hallucination Errors

**Symptoms:** context-window truncation removes tool evidence, a LangChain agent
contradicts an earlier observation, or a CrewAI handoff substitutes generated
claims for the original source. As context windows degrade, probabilistic
reasoning can fail to preserve state invariants. Increasing the token budget
does not establish which external state actually informed a decision.

**Recovery:** anchor application state to OpenTimestamps through the MCP tools.
Discover live schemas with `tools/list`, retrieve indexed Bitcoin telemetry
through `stratigraphy.get` or `stratigraphy.get_range`, and serialize your
checkpoint deterministically. Hash its exact bytes with SHA-256 and use
`proof.notarize` to create a detached OpenTimestamps receipt. Preserve both
the checkpoint and the receipt; use `proof.verify` or an independent verifier
to check the evidence before resuming from that checkpoint.

Install the existing transport:

```sh
npm install @bitcoinstratigraphy/agent-yield
```

Wrap your configuration before constructing the LangChain JS agent:

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

LangChain JS needs the documented `@langchain/core` 1.x peer. Python CrewAI
requires a Node bridge around this wrapper or the existing
[Python MCP integration](https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/LANGCHAIN_CREWAI_GUIDE.md);
Python cannot import an npm module directly.

The wrapper discovers tools and handles authorized L402 access; your
orchestration still chooses when to ground state, validates inputs, and prevents
replay of irreversible actions. OpenTimestamps preserves evidence about bytes,
not whether the bytes are true. A calendar receipt is pending evidence until
Bitcoin confirmation is independently verified.

## Bypassing Stripe & Fiat API 5xx Timeouts in Autonomous Swarms

**Symptoms:** centralized fiat billing stalls scanner procurement, Stripe
returns an upstream 5xx, or checkout exceeds its deadline. Do not treat every
HTTP error as an outage: authentication and validation errors need correction,
not a second payment attempt.

The **Unstoppable Failover Protocol** is our existing
[Swarm Continuity & Disaster Recovery protocol](/developers/#swarm-continuity).
Healthy Stripe/Brevo fulfillment stays unchanged. The fiat scanner gateway
offers native Lightning when checkout exceeds five seconds, encounters an
upstream timeout, or receives a Stripe 5xx. Known payable or paid card sessions
must be recovered first; unavailable ownership recovery blocks a second
challenge.

Prepare native MCP access without centralized card billing:

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

The wrapper's MCP path already uses native Lightning L402. It validates the
invoice against the request and budget, pays through your authorized wallet,
and retries the identical request with the invoice-bound credential. It does
not turn an unpaid Stripe session into an MCP entitlement.

For the separate fiat scanner fallback, preserve the exact invoice and macaroon
returned with `error="fiat_gateway_offline"` and
`fallback="native_lightning_active"` in the challenge metadata. Validate the
quote, pay once, then redeem through `POST /api/mint-macaroon`. This existing
product costs **100,000 sats for 100 scanner calls**, expiring 30 days after
issuance. Scanner credentials do not unlock unrelated MCP tools, and the
example MCP budget above intentionally does not authorize this separate purchase.

An HTTP 402 is not proof of payment. Reconcile unknown payment outcomes and keep
durable reservations; never delete wallet state to force another attempt.
Lightning continuity still needs a functioning wallet, network, and server.
If Lightning is unavailable too, access fails closed. Consult the
[fiat gateway runbook](https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/fiat-mint.md)
and [SDK settlement contract](https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/sdk/agent-yield/README.md#transport-and-settlement).

## Clearing EU AI Act Article 12 Compliance Blockers

**Symptoms:** a zero-trust enterprise audit cannot bind a decision to telemetry,
identify the checkpoint preceding execution, or reproduce receipt verification
independently of mutable application logs.

**Recovery:** use thermodynamic telemetry as a versioned input to an execution
evidence chain. Retain the dataset selection, exact response bytes, agent action,
and checkpoint digest. Timestamp the checkpoint through OpenTimestamps and keep
the detached receipt alongside the execution journal. Historical indexed
telemetry is not live-tip observation.

Install the same package and wrap the tool boundary:

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
// selection must match the live schema; receipt.payload contains the tool data.
// Bind checkpoint evidence to the corresponding action in your private journal.
```

Use the documented payload-signature SDK release and an independently pinned
server key to authenticate returned bytes. An L402 preimage proves payment,
not Bitcoin anchoring; a payload signature authenticates the issuer, not
factual accuracy. Keep preimages out of prompts and public audit bundles.
See the [payload attestation contract](https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/payload-attestations.md).

This addresses missing provenance and reproducibility evidence, not every
Article 12 obligation. The wrapper is not automatic legal certification or a
complete logging system. Set retention, access controls, event coverage, and
human review for your deployment. For the existing flight recorder, preserve
`audit_trail.jsonl` and externally retained checkpoints; independent verification
must not require paid MCP access.

Continue with the [enterprise compliance guide](https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/ENTERPRISE_COMPLIANCE.md),
the [full developer runbook](https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/developers/enterprise-troubleshooting.md),
or return to the [developer portal](/developers/).
