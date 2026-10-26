# Atomic tool composability: the MCP pipeline transport extension

The catalog remains **16 Canonical Tools**. `tools/pipeline` and its alias
`tools/batch` are transport methods, not new tools. Single-tool calls and the
existing `X-L402-Batch-Size: 100` same-tool passes retain their existing behavior.

## Request and payment

POST the following JSON to `/mcp`:

```json
{
  "jsonrpc": "2.0",
  "id": "enterprise-sequence",
  "method": "tools/pipeline",
  "params": {
    "calls": [
      {
        "jsonrpc": "2.0",
        "id": "first",
        "method": "tools/call",
        "params": {"name": "mesh.get_status", "arguments": {}}
      },
      {
        "jsonrpc": "2.0",
        "id": "second",
        "method": "tools/call",
        "params": {"name": "proof.list", "arguments": {}}
      }
    ]
  }
}
```

The preflight validates the sequence and sums the existing per-tool prices,
including duplicate calls. The two free sandbox capabilities remain free.
All-free sequences require no invoice. A sequence with any paid steps returns
one HTTP 402 Lightning invoice for the sum, with an invoice-bound macaroon.
Pay that exact invoice, then retry the **identical request** with:

```text
Authorization: L402 <macaroon>:<preimage>
```

The credential is bound to the SHA-256 commitment of the entire request,
including order, ids, arguments and any references. It cannot pay for a different
sequence, a single-tool call or a second execution. Expiry, revocation, identity
binding and inherited quotas remain enforced. Tool/target-scoped descendants
cannot broaden themselves into pipeline credentials. No separate invoice is
created for individual pipeline steps. The existing 79% gross-margin / 21%
treasury policies are unchanged: there is no batch discount or additional reward
pool, and the normal settlement accounting sees the combined invoice once.

Do not send `X-L402-Batch-Size`, x402 payment headers, polling task parameters or
per-step `webhook_url` on pipelines. Up to 100 steps are supported, with a
4 MiB request limit and a five-minute execution deadline. Legacy MCP clients may
send a JSON-RPC array of `tools/call` requests. MCP 2026-07-28 continues to reject
raw JSON-RPC arrays: use the named method with its normal per-request metadata
and matching routing headers. Capability discovery advertises the extension as
`com.bitcoinstratigraphy/pipelines`.

## Explicit result references

Use `{"$ref":"0#/structuredContent/field"}` as an argument value to copy a field
from the first step's MCP result. The integer is a zero-based **step index**, not
a JSON-RPC id. The suffix is an RFC 6901 JSON pointer; `~0` and `~1` escape `~`
and `/`. Only earlier steps may be referenced. Missing fields, unsafe object
keys, forward references and cycles are refused. No JavaScript expressions,
interpolation or code evaluation is supported.

Literal arguments are checked before invoicing; reference-dependent argument
types and values are checked against the existing tool schema after resolution.
A missing field or incompatible output therefore fails that paid execution and
is recorded in its receipt. Full prior outputs are not implicitly injected into
unrelated tools.

## Unified flight recorder

The response contains ordered JSON-RPC step responses and a single signed batch
`receipt`. The receipt binds the request digest, invoice hash, exact summed
price, provider, timestamps, ordered tool names, and input/output commitments
for every attempted step. Each output hash commits to the step's `{result: ...}`
or `{error: ...}` object. The input hash commits to the resolved, validated
arguments. On failure before resolution it commits to the submitted arguments.

The issuer signs the canonical JSON payload (sorted object keys, preserved array
order), excluding `issuer_attestation`, with Ed25519 over:

```text
bitcoin-stratigraphy/mcp-pipeline/v1\n<canonical JSON>
```

The attestation version is `mcp-pipeline-ed25519-v1`. Use an independently pinned
issuer public key; never trust a key solely because a response provides it.
The issuer follows the existing Article 12 key selection policy.

Evidence is written to the existing PostgreSQL
`enterprise_affiliate_security` JSONB store under `mcp-pipeline:<payment-hash>`
(a fresh receipt id for free sequences). No tables, indexes, tools or payment
ratios are added or changed. The primary-key index supports receipt lookups.
Storage and signing readiness are required before invoicing; an invoice is
reserved durably before any step runs and step commitments are saved as work
progresses. Arguments and results can contain credentials, so the database
records commitments rather than their raw contents. Archive the response
separately if an auditor needs to recompute those commitments.

**Atomic settlement is not transactional rollback.** Steps execute sequentially,
stop on the first failure, and return the signed partial-execution receipt.
External notarizations, prior tool effects and Lightning payments cannot be
rolled back. Consumed invoices do not automatically rerun or refund after a
disconnect, storage failure or crash. A durable `running` journal can identify
an interrupted execution; do not blindly retry side effects with a new payment.

This is technical evidence for Article 12 record-keeping, not legal certification,
a guarantee about agent behavior, a Bitcoin inclusion proof or a substitute for
the enterprise's access controls, retention policy and independent audit.
