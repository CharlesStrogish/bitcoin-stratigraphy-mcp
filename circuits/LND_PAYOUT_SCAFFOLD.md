# Fee-capped clearing payouts — disabled scaffold

Production settlement and outbound clearing payouts remain disabled. The
authenticated `clearing.settle_contract` handler accepts an optional
`payout_invoice`, covered by the worker's existing NIP-98 payload signature, but
unconditionally rejects payout requests before wallet configuration or I/O.
Installing keys or changing environment flags does not remove this lock.
Existing development settlement still records only development receipts and
never sends a payout.

## Configuration for a future reviewed activation

- `LND_REST_URL`: operator-supplied HTTPS LND REST endpoint; no default.
- `LND_MACAROON`: hex-encoded, least-privilege LND macaroon; no default.
- `LND_TLS_CERT`: optional PEM certificate authority for self-signed LND TLS;
  otherwise system trust is used. TLS verification is never disabled.

Do not commit configuration values or put them in worker requests. No real
credentials are needed for the mocked tests. No new dependencies are required.

## Reserve protection

All calculations use integer millisatoshis. For funded escrow `E`, invoice
principal `P` (a positive whole-satoshi amount), the enforced satoshi cap is:

```
C = min(floor(E / 100000), floor((E - P) / 1000))
```

The first term is 1% of funded escrow, rounded down to sats. The second ensures
the escrow itself funds the fee. Reject `P > E`, zero/amountless invoices and
non-whole-satoshi principals. A full-balance invoice gets a **zero** fee cap,
not an unlimited one. Workers should invoice for less than the escrow amount
when routing fees are needed.

1. Decode the invoice through LND; bind its payment hash, amount and expiry.
2. Obtain a graph-only fee estimate using destination and amount (no payment
   probes). Reject any estimate `> 1000*C` before reservation or send.
3. Durably and exclusively reserve `P + 1000*C` in `clearing_payouts`. This is
   a dedicated clearing table, not the existing bank escrow or staking ledger.
4. Send through LND Router `SendPaymentV2` with explicit `fee_limit_sat = C`,
   including when `C = 0`. Never retry using an unlimited cap.
5. For successful bound payment evidence, debit exactly `P + F` from
   `escrow_balance_msat`, where `F` is the actual fee in msats. Preserve the
   unused portion of the fee allowance in that escrow.

Assuming LND honors its documented limit, `0 <= F <= 1000*C`, hence
`E - P - F >= E - P - 1000*C >= 0`. The estimate alone is not the guarantee:
the send-time LND fee limit protects against fee changes after estimation.
Malformed or over-cap success evidence is an unknown outcome, not proof that
nothing was paid. This is not protection against a malicious/compromised LND.

Unknown/in-flight/timeout outcomes and post-payment database failures keep the
reservation. They never trigger a second send. Only an exact-hash terminal
`FAILED` response or a locally rejected pre-dispatch plan releases the reserve.
The immutable attempt record remains, blocking automatic re-payment even after
failure. There is no automated reconciliation/retry capability in this scaffold.
Residual escrow funds are recorded but not automatically refunded or withdrawn.

## Integration boundary

`services/clearingPayout.ts` connects the authenticated route to the unconditional
activation lock, with the LND/ledger construction and reserve/send/debit engine
wired behind that lock. `adapters/lnd.ts` implements the REST adapter.
`services/clearingPayoutLedger.ts` implements atomic PostgreSQL transitions.
Neither the engine nor ledger initialization is invoked by today's route.

Activation is intentionally **not** a one-flag operation. A separate reviewed
change must accept the independent Phase 2 ceremony, establish the production
proof policy, verify exact contract/worker/invoice binding and merchant-confirmed
funding, initialize the isolated ledger, and durably coordinate the payout result
with production contract status and receipt issuance. Development preimage
proofs are not arbitrary-task execution proofs or production authorization.
Do not enable payouts merely because key files exist.

## Verification

Run only the isolated clearing suite:

```
node scripts/test-clearing-payout.mjs
```

Tests use synthetic identities/invoices and mocked LND REST responses. The
PostgreSQL test creates and removes a private temporary schema. The suite checks
integer reserve inequalities, over-cap rejection without sending, explicit zero
caps, stale-estimate failure, exact fee debiting, concurrent reservation,
ambiguous outcomes, post-payment commit failure and the signed route's hard lock.
It does not import, dispatch or test the 16 Fiduciary data tools or
`payment.get_escrow`, and it never sends a real Lightning payment.
