# Autonomous Bitcoin Stratigraphy agent starter

This is a **single-worker reference implementation** using
`@bitcoin-stratigraphy/sdk` for the paid REST dataset and
`@bitcoin-stratigraphy/sdk/mcp` for proof verification and mesh broadcasts.
It does not use a mock proof or claim that an attestation catalog entry contains
proof bytes. The paid dataset supplies the exact `zkProof` and `data` that the
worker sends to `proof.verify`.

This starter uses a narrow split: REST L402 for the dataset and MCP L402 for
proof verification and mesh operations. It does not select the REST router's
optional `l-btc`/`taproot-assets` rails, use MCP Base USDC x402, or consume the
REST SSE stream. The broader REST router can support `btc-lightning`, `l-btc`,
and `taproot-assets` when configured (check `/api/v1/cost`); MCP supports
Lightning L402 and conditional Base USDC x402 only when configured. Proof
verification checks supplied evidence for its statement, not upstream source
truth. Mesh quorum is a cross-validation signal, not source truth, and
`proof.ground` receipts are off-chain Schnorr-signed attestations, not on-chain
proofs.

## Run on Replit

1. Copy or fork **this directory as the root of its own Repl**. Its versioned
   SDK package under `vendor/` is included, so `pnpm install` does not need
   this monorepo or a published SDK. Copy `.replit.example` to `.replit` and
   `replit.nix.example` to `replit.nix` in that new root for the provided Run
   and Reserved VM commands. (This repository keeps the active files as
   examples because its own root `.replit` runs the dashboard.)
2. Create a **separate payer wallet** with a limited NWC spending budget and
   `pay_invoice` permission. Add its `nostr+walletconnect://...` URI as the
   `NWC_PAIRING_SECRET` Replit Secret. Do not paste a filled-in `.env` file into
   the repo. If the payer and invoice issuer are the same wallet, some
   providers return a UUID instead of a Lightning preimage; the SDK correctly
   refuses that payment proof.
3. Click **Run**. The provided `.replit.example` command installs packages,
   builds the worker, and starts `pnpm start:seeder` with a 15-minute pause
   between completed cycles. A development run without a database keeps its
    checkpoint in `.autonomous-agent-state.json`. If PostgreSQL is configured
    but not initialized in development, the worker logs a warning and uses
    this local file instead. It is not a durable production store.
4. For 24/7 operation, add a Replit PostgreSQL database, then choose
   **Reserved VM** when publishing the fork. Reserved VM runs continuously;
   a Scheduled deployment does not. Replit injects `DATABASE_URL` for the
    database; production startup **fails closed** without an initialized
    database so a restart cannot silently replay paid actions. The worker creates a small
   `stratigraphy_agent_checkpoint` table. Add the NWC secret to the published
   app's secrets too. The sample `.replit` config uses `ignorePorts = true`
   because this is a background worker, not a web server. Publishing and a
   funded wallet can incur hosting and Lightning charges.

The `.env.example` lists `REPLIT_DB` because older Replit projects may have a
PostgreSQL connection URL under that name. It is an optional fallback; **new
Replit databases use `DATABASE_URL`**. Never set `REPLIT_DB` to an unrelated
key-value URL. `STRATIGRAPHY_SERVER_URL` defaults to the REST origin without
`/mcp`. The seeder always waits 900,000 ms (15 minutes) after each cycle;
`POLL_INTERVAL_MS` only controls the older `pnpm start` entry point. Set
optional values in Replit Secrets/settings rather than committing `.env`.

`LNURL_PAYMENT_KEY` can mean an LNbits Admin API key or an Alby wallet token.
Neither specifies the required provider endpoint or guarantees that an
invoice payment returns the preimage needed for L402. This reference worker
**requires `NWC_PAIRING_SECRET`**; if only `LNURL_PAYMENT_KEY` is set it fails
before making a payment. If both are set, NWC takes priority. Do not treat a
receiving-only LNURL-pay key as an invoice payer.

## What each cycle does

1. Retrieve the paid REST dataset using a one-day L402 subscription pass,
   log the most recent thermodynamic signal, and fingerprint stable research
   fields (not newly generated Nostr attestation timestamps).
2. For a **new dataset snapshot**, verify the exact proof returned with that
   dataset using the MCP `proof.verify` tool (250 sats). Save a checkpoint only
   after successful verification. The proof catalog does not expose full
   proofs for arbitrary historical records, so this starter cannot verify
   historical hashes without another trusted source of proof material.
3. Check `mesh.get_status`. If pinned remote peers are available, look up the
   catalog's latest canonical date and request `mesh.broadcast` (250 sats);
   checkpoint the date only after a matching peer receipt. If the server has
   no configured peers, log `isolated` and leave broadcasting pending. The
   worker does not claim a successful broadcast in that case.

The legacy MCP names `mesh.status`, `proof.status`, and
`proof.epistemic_receipt` remain accepted by compatible servers. New agents
should use `mesh.get_status`, `proof.get_status`, and
`proof.issue_receipt`, respectively.

Seeder logs include a SHA-256 hash of each paid invoice after the wallet
reports a valid preimage, the stable latest telemetry hash on every cycle,
 and a verification event after proof verification succeeds. Error events include
 the exception message and stack with wallet URIs, invoices, payment bytes, and
 configured secrets redacted.

The wallet must return a real 32-byte hex payment preimage; each SDK verifies
it against its challenge before sending it. `src/wallet.ts` includes an
injectable adapter for LNURL-capable wallets that can **pay BOLT11 invoices**.
A bare LNURL-pay address is a receiving address and cannot settle an L402
invoice.

Run checks from the repository root:

```sh
pnpm --filter @bitcoin-stratigraphy/autonomous-agent-template build
pnpm --filter @bitcoin-stratigraphy/autonomous-agent-template typecheck
pnpm --filter @bitcoin-stratigraphy/autonomous-agent-template test
```

In a standalone copy, use `pnpm install && pnpm build && pnpm test` instead.
To adopt a published SDK later, replace the `file:./vendor/...tgz` reference
with a published `@bitcoin-stratigraphy/sdk` version and remove `vendor/`.
See `sdk/typescript/README.md` in the source repository for SDK packaging and
GitHub subdirectory installation instructions.