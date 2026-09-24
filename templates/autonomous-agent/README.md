# Autonomous Bitcoin Stratigraphy agent starter

This is a **single-worker reference implementation** using
`@bitcoin-stratigraphy/sdk` for the paid REST dataset and
`@bitcoin-stratigraphy/sdk/mcp` for proof verification and mesh broadcasts.
It does not use a mock proof or claim that an attestation catalog entry contains
proof bytes. The paid dataset supplies the exact `zkProof` and `data` that the
worker sends to `proof.verify`.

## Run on Replit

1. Fork this **repository with its `sdk/typescript/` directory**. The SDK is
   currently a local workspace package (`workspace:*`), not a published npm
   package. Copy `templates/autonomous-agent/.replit.example` to the fork's
   root `.replit` and `templates/autonomous-agent/replit.nix.example` to
   `replit.nix` to make its Run button start this worker rather than the
   dashboard. In a Repl made solely from this directory, first make the SDK
   available as a package and replace `workspace:*` in `package.json`.
2. Create a **separate payer wallet** with a limited NWC spending budget and
   `pay_invoice` permission. Add its `nostr+walletconnect://...` URI as the
   `NWC_PAIRING_SECRET` Replit Secret. Do not paste a filled-in `.env` file into
   the repo. If the payer and invoice issuer are the same wallet, some
   providers return a UUID instead of a Lightning preimage; the SDK correctly
   refuses that payment proof.
3. Click **Run**. The command installs packages, builds the SDK and worker,
   and starts polling. A development run without a database keeps its
   checkpoint in `.autonomous-agent-state.json`. It is not a durable production
   store.
4. For 24/7 operation, add a Replit PostgreSQL database, then choose
   **Reserved VM** when publishing the fork. Reserved VM runs continuously;
   a Scheduled deployment does not. Replit injects `DATABASE_URL` for the
   database; production startup **fails closed** without it so a restart
   cannot silently replay paid actions. The worker creates a small
   `stratigraphy_agent_checkpoint` table. Add the NWC secret to the published
   app's secrets too. The sample `.replit` config uses `ignorePorts = true`
   because this is a background worker, not a web server. Publishing and a
   funded wallet can incur hosting and Lightning charges.

The `.env.example` lists `REPLIT_DB` because older Replit projects may have a
PostgreSQL connection URL under that name. It is an optional fallback; **new
Replit databases use `DATABASE_URL`**. Never set `REPLIT_DB` to an unrelated
key-value URL. `STRATIGRAPHY_SERVER_URL` defaults to the REST origin without
`/mcp`; `POLL_INTERVAL_MS` defaults to 3,600,000 (one hour, minimum 15 minutes).
Set optional values in Replit Secrets/settings rather than committing `.env`.

## What each cycle does

1. Retrieve the paid REST dataset using a one-day L402 subscription pass,
   log the most recent thermodynamic signal, and fingerprint stable research
   fields (not newly generated Nostr attestation timestamps).
2. For a **new dataset snapshot**, verify the exact proof returned with that
   dataset using the MCP `proof.verify` tool (250 sats). Save a checkpoint only
   after successful verification. The proof catalog does not expose full
   proofs for arbitrary historical records, so this starter cannot verify
   historical hashes without another trusted source of proof material.
3. Check `mesh.status`. If pinned remote peers are available, look up the
   catalog's latest canonical date and request `mesh.broadcast` (250 sats);
   checkpoint the date only after a matching peer receipt. If the server has
   no configured peers, log `isolated` and leave broadcasting pending. The
   worker does not claim a successful broadcast in that case.

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