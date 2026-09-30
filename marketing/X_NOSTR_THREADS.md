# Bitcoin Stratigraphy Data Engine: X + Nostr Launch Threads

## X thread

Publish one paragraph per post, in order.

```text
Bitcoin Stratigraphy Data Engine: 14 MCP tools, catalog rated Glama A (4.4/5). Indexed telemetry, L402 Lightning payments, Groth16/Poseidon BN254 verification. Try free stratigraphy.list + payment.get_info: https://bitcoin-stratigraphy-dashboard.replit.app/mcp

Bitcoin Stratigraphy MCP exposes stratigraphy.{list,get,get_digest,get_diff,get_range}: discover bounds; read indexed records, compact digests, differences, and bounded ranges. Start free with stratigraphy.list: https://bitcoin-stratigraphy-dashboard.replit.app/mcp

Bitcoin Stratigraphy MCP proof tools: proof.{attenuate,verify,get_by_hash,list,submit,ground}. Groth16/Poseidon BN254 verification checks a submitted proof against its statement and snapshot; it cannot establish source accuracy or an LLM's interpretation.

Bitcoin Stratigraphy MCP uses HTTP 402 L402: an agent reviews and pays the exact Lightning invoice, verifies its preimage, then retries the scoped call. proof.ground returns a signed off-chain Bitcoin-tip receipt, not a Groth16 proof, PoW proof, or on-chain transaction.

Bitcoin Stratigraphy MCP: mesh.{get_status,broadcast} checks peer/quorum health and distributes a stored snapshot; payment.get_info queries prices. Published example: most paid tools 250 sats; proof.list 10 sats. Check live prices; free discovery: https://bitcoin-stratigraphy-dashboard.replit.app/mcp
```

## Nostr thread

Publish one post per block, in order. No account handle is assumed.

### Post 1

```text
Bitcoin Stratigraphy Data Engine is an MCP notary hub for AI agents that combines indexed Bitcoin telemetry, cryptographic proof verification, signed tip-context receipts, and an optional Nostr mesh. The public interface is Streamable HTTP at https://bitcoin-stratigraphy-dashboard.replit.app/mcp (MCP 2025-11-25). Start with the free stratigraphy.list dataset discovery call or payment.get_info price query. Discovery does not give an agent a wallet or authorize spending.
```

### Post 2

```text
The Bitcoin Stratigraphy MCP catalog has 14 tools across four namespaces. Historical indexed data is in stratigraphy.list (bounds/metrics), stratigraphy.get (records), stratigraphy.get_digest (compact summary), stratigraphy.get_diff (differences), and stratigraphy.get_range (bounded compressed records). Mesh operations are mesh.get_status (peer/quorum health) and mesh.broadcast (sign and distribute a stored snapshot). The latter has side effects; inspect policy before allowing it.
```

### Post 3

```text
Bitcoin Stratigraphy proof tools are proof.attenuate, proof.verify, proof.get_by_hash, proof.list, proof.submit, and proof.ground. Telemetry Groth16 proofs use Poseidon over BN254. Verification concerns the exact submitted proof, public statement, and associated snapshot; it can reject invalid or mismatched submissions, but it cannot guarantee that source data is accurate or that an LLM interpreted it correctly. Attenuation narrows an existing credential; it does not pay an invoice.
```

### Post 4

```text
Bitcoin Stratigraphy paid MCP calls use L402: a call receives an HTTP 402 challenge with an invoice and scoped macaroon; an agent's separately authorized Lightning wallet pays that exact invoice, checks the preimage against its payment hash, and retries the same call. Client connection alone does not pay automatically. Published example pricing is 250 sats for most paid tools and 10 sats for proof.list; run free payment.get_info at https://bitcoin-stratigraphy-dashboard.replit.app/mcp for current prices before setting a budget. Lightning uses millisatoshi units internally; this product is not sub-sat priced.
```

### Post 5

```text
Bitcoin Stratigraphy proof.ground reads Bitcoin chain state and returns a signed, off-chain tip-context/dataset receipt. It is not a Groth16 proof, proof-of-work validity proof, or on-chain transaction, and a signature does not make caller-supplied claims true. Groth16 verification checks a cryptographic relation for an exact statement; it cannot promise zero hallucinations. The Glama A (4.4/5) figure is a tool-definition quality snapshot checked Sep 30, 2026, not an audit or a grade for every tool. Try free discovery at https://bitcoin-stratigraphy-dashboard.replit.app/mcp.
```

## Internal editor checklist — do not publish

- Do not claim first-of-kind or promise zero hallucinations. Proof verification can reject fabricated or mismatched submissions for the exact statement/snapshot; it cannot prove source accuracy or an LLM's interpretation.
- Keep `proof.ground` described as a signed, off-chain Bitcoin-tip receipt. It is not Groth16, a PoW proof, or an on-chain transaction.
- Name the proof system precisely: Groth16/Poseidon BN254.
- Glama A (4.4/5) is a tool-definition quality snapshot checked September 30, 2026; it is not a security audit and does not mean every tool received an A.
- Recheck that the live MCP endpoint is available before publishing: https://bitcoin-stratigraphy-dashboard.replit.app/mcp. The free discovery CTA is `stratigraphy.list` plus `payment.get_info`.
- Recheck live prices with `payment.get_info` immediately before publication/use. Current documented examples: most paid tools 250 sats; `proof.list` 10 sats. Lightning supports millisatoshi units, but the product is not sub-sat priced.