# Reddit announcement drafts

**Posting note — not part of any publishable body:** Check each community’s current rules and whether it has a designated showcase or project thread before posting. These drafts are not preapproved.

## r/Bitcoin

### TITLE

A Bitcoin MCP for indexed daily telemetry, with explicit proof and data limits

### BODY

Disclosure: I’m the developer and maintainer of this service. I’m looking for technical feedback, not presenting it as a Bitcoin source of truth.

It exposes historical Bitcoin telemetry through MCP at https://bitcoin-stratigraphy-dashboard.replit.app/mcp. The historical data is a deterministic daily block index, not a live-tip feed. The catalog has 14 canonical tools: 5 stratigraphy, 6 proof, 2 mesh, and 1 payment.

The Groth16/Poseidon BN254 path can prove a defined statement bound to the exact telemetry supplied for verification. That does not establish that the underlying source data is true, prove a model’s interpretation, or prevent every hallucination. `proof.ground` produces a Schnorr-signed, off-chain receipt tied to a Bitcoin-tip reference; it does not publish an on-chain transaction or prove Bitcoin proof-of-work validity. These cryptographic layers can help catch fabricated or mismatched data only when clients validate the proof and retain the original evidence.

What independent evidence or validation would you want to see before relying on an indexed historical telemetry record in a Bitcoin-facing agent?

## r/LocalLLaMA

### TITLE

Remote Bitcoin telemetry dataset over MCP for local-model agent experiments (no model hosted)

### BODY

Disclosure: I’m the developer and maintainer. This is a remote dataset/service for agents, not a locally hosted model, inference service, or bundled LLM.

I’ve made an MCP endpoint for historical Bitcoin telemetry and proof-related tools available at https://bitcoin-stratigraphy-dashboard.replit.app/mcp. It uses Streamable HTTP and exposes 14 canonical tools: 5 stratigraphy, 6 proof, 2 mesh, and 1 payment. Historical strata are a deterministic daily block index, not live-tip data. The repository includes Python integration examples that wrap the tools using the standard MCP SDK and their published input schemas.

I’m interested in evaluation rather than claiming proofs make model output true: Groth16/Poseidon BN254 verifies a defined statement bound to exact telemetry, but cannot establish the source data’s truth or the model’s interpretation, and does not eliminate all hallucinations. `proof.ground` is a Schnorr-signed off-chain Bitcoin-tip receipt, not an on-chain transaction or proof-of-work validity proof. These layers can reduce fabricated or mismatched data only if the client validates the evidence and keeps the original payloads.

Discovery is free; paid calls require separate payment authorization, and standard MCP clients do not pay automatically. MCP uses Lightning L402 and can offer Base USDC x402 only when configured. `payment.get_info` is the authoritative source for current prices.

What local-model task or evaluation would make this kind of tool-backed data useful to you without conflating a valid proof with a true input?

## r/MCP

### TITLE

Remote Bitcoin telemetry MCP: Streamable HTTP, 14 tools, and an explicit L402 payment flow

### BODY

Disclosure: I’m the developer and maintainer of this MCP server. I’d value implementation feedback from people building clients and tool integrations.

Endpoint: https://bitcoin-stratigraphy-dashboard.replit.app/mcp<br>
Transport: Streamable HTTP · MCP protocol: 2025-11-25<br>
Catalog: 14 canonical tools — 5 stratigraphy, 6 proof, 2 mesh, 1 payment.

For Cursor, use its native remote-server `url` field:

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "url": "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"
    }
  }
}
```

Start with `tools/list`, `stratigraphy.list`, or `payment.get_info` for free discovery and pricing. Paid calls are not silently settled by stock MCP clients. On the Lightning L402 path, an unauthenticated paid call receives HTTP 402 with an unpaid, invoice-bound macaroon and the invoice in the challenge. A wallet-enabled client must explicitly authorize and pay that exact invoice, verify that the returned 32-byte preimage hashes to the challenge payment hash, then retry the same call with `Authorization: L402 <macaroon>:<preimage>`. Do not reuse the credential or blindly repay after a failed retry. MCP can offer Base USDC x402 as a separate path when configured.

Most paid tools are 250 sats in current examples; `proof.list` is 10 sats. Treat `payment.get_info` as authoritative for current prices; the product does not have sub-satoshi paid pricing.

The Groth16/Poseidon BN254 proof verifies a defined statement bound to exact telemetry; it cannot establish source-data truth or an LLM’s interpretation, nor eliminate all hallucinations. `proof.ground` returns a Schnorr-signed off-chain Bitcoin-tip receipt, not an on-chain transaction or proof-of-work validity proof. Cryptographic checks reduce fabricated or mismatched data only when the client validates them and retains the original evidence. The Glama catalog’s A (4.4/5) is a September 30 snapshot of tool-definition quality—not a grade for every individual tool or a security audit.

Which part of this 402/challenge-and-retry flow or its discoverability would you most want a remote MCP client to make clearer?

## Publisher capability reference — not part of the post bodies

- `proof.attenuate` narrows a parent L402 macaroon; ordinary MCP clients do not
  pay automatically. MCP supports Lightning L402 and conditionally Base USDC
  x402 when configured. Separately, the REST router offers `btc-lightning`,
  `l-btc`, and `taproot-assets` subject to its `/api/v1/cost` configuration.
- MCP `proof.verify` checks supplied Groth16 telemetry/drift proofs or supplied
  OTS receipts. `proof.ground` returns an off-chain Schnorr-signed Bitcoin-tip
  receipt, not an on-chain proof.
- Nostr mesh broadcasts target pinned peers; quorum is cross-validation, not
  source truth. `get_diff`/`get_digest` summarize indexed history, not live
  block provenance.
- `/api/v1/stratigraphy/stream` is paid REST SSE refreshed every 30 seconds,
  not MCP transport; do not promise Base x402 on SSE.
- Use `payment.get_info` for live MCP prices (most paid tools are 250 sats;
  `proof.list` is 10 sats). Glama A (4.4/5) is a dated tool-definition rating,
  not a security audit or a grade for every tool.

Check endpoint availability and each destination's rules before posting.