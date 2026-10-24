# Enterprise protocol economics and Cryptographic Audit Receipts

All additions are REST endpoints, middleware, and accounting metadata. The 16
canonical MCP tools and their parameter schemas are unchanged.

## Enterprise positioning and verification limits

Requested enterprise positioning:

> Provides corporate risk teams with an unforgeable cryptographic audit trail, mathematically proving that an autonomous agent based its execution on state-anchored thermodynamic data.

**Technical scope:** the sentence above is positioning, not the receipt's
verification guarantee. Ed25519 provides computational signature security under
its key-security assumptions, not absolute unforgeability. The receipt proves
that the issuer signed a SHA-256 commitment to the submitted decision/data
object. It does **not** prove the agent actually used that data, validate an
independent Bitcoin state anchor, establish data truth, or provide legal
indemnification. State-Anchored Provenance requires separate, independently
verified source/anchor evidence. This endpoint explicitly reports
`state_anchor_verified: false` and `agent_execution_proven: false`.

## Autonomous Routing Kickback

Send exactly one optional header on invoice creation:

```text
X-Agent-Lightning-Address: routing-agent@example.com
# or X-Agent-LNURL: <checksummed lnurl1... value>
```

The same headers are accepted on `GET`/`POST /api/v1/cost`. Cost quotes do not
create invoices or credit any account. An issued Lightning invoice binds its
payment hash, provider, full invoice amount, payout address and buyer (if
authenticated) into a domain-separated signed allocation. The kickback is
`floor(invoice_amount_msats * 5 / 100)`, in integer millisatoshis. Fractional
millisatoshi dust stays with the merchant. The paid invoice's original gross
amount remains due; the kickback is not an invoice discount.

The invoice ledger records the allocation before returning the invoice. Only
merchant-verified settlement marks it payable. Repeated proofs, descendants,
cached retries and parallel requests cannot credit it twice. The address cannot
be replaced after invoice issuance. Challenge caches partition buyer/payout
attribution without expanding IP rate limits. Existing invoices minted before
this accounting layer are not retroactively assigned an affiliate.

**No payouts are sent automatically.** This is local PostgreSQL accounting for
future payout processing. LNURLs are not resolved and no third-party payout
requests are made. Address headers are a requested destination, not proof that
the signer controls that wallet. Inspect the signed allocation before paying.

## Authenticated annual commercial exemption

Use a fresh NIP-98 event for the request's exact URL, method and body. For paid
retries put it in `X-Nostr-Authorization`, leaving `Authorization` for L402.
Optional `Buyer-Pubkey` must match this verified signer. An unsigned public-key
header, declared purchase amount, or unfunded preauthorization grants nothing.

- Every new, verified, registered BTC-Lightning invoice credits the original
  buyer's cumulative integer-msat spend once, including existing bulk batches.
- Unconsumed qualifying volume is valued at a current BTC/USD spot quote
  (Coinbase, bounded to 60 seconds in memory with a four-second request timeout).
  The USD threshold is $250,000. FX failure never fabricates a price or grants a
  license. Confirmed satoshi accounting remains durable for later reconciliation.
- Unlock consumes the qualifying balance for that annual grant. Overage is not
  a promise of prepaid additional license years. New settled purchases accrue
  separately and can fund renewal at or after expiry.
- The signed token contains `sub`, `iat`, `exp`, `unlock_date`, and the exact
  `expiry_date`. **Expiry Date = unlock timestamp + 31,536,000 seconds (365 days)**,
  not a calendar-year approximation. For example, an unlock at
  `2026-10-24T00:00:00.000Z` has **Expiry Date: `2027-10-24T00:00:00.000Z`**.
- A token is active only while `now < exp`. Issued macaroons carry
  `Commercial-Exemption: Active` only for a currently active authenticated buyer;
  their own expiry is capped at the exemption's `exp`. An extra issuer-secret
  proof prevents holders from forging commercial metadata through attenuation.
- Without new qualifying settled volume, expiry removes the commercial
  exemption. At the next authenticated request, status headers, accounting
  responses and server logs report `Expired`, `copyleft_risk: high`, and
  `AGPLv3 viral copyleft — no active commercial exemption`. Agent clients should
  propagate those returned findings into their own logs. No automatic legal
  conclusion about independent weights or unrelated software is implied.
- A new grant needs new qualifying spend. Replaying an old paid invoice or an
  old signed token cannot renew the grant. Previously valid historical execution
  receipts remain inspectable; they are not authorization for future execution.

`GET /api/v1/compliance/commercial-exemption` returns the authenticated buyer's
account and active signed token. A confirmed purchase also returns the token in
`X-Commercial-Exemption-Token` (base64url JSON), with exact UTC expiry in
`X-Commercial-Exemption-Expires`. Pin the issuer independently and verify the
signature, `sub` and strict `exp` before relying on a token.

For a funded bulk license purchase, use
`POST /api/v1/compliance/commercial-exemption/purchase`. The initial request
returns a 402 invoice at the live threshold price. Pay that exact invoice and
retry with the returned macaroon, proof, and fresh NIP-98 authentication.
No token is activated on invoice creation alone. While an existing exemption is
active, newly settled qualifying volume is reserved for a later renewal rather
than silently extending the current token.

In Bitcoin Core local/air-gap mode (`BITCOIN_CORE_RPC_URL`), the default fiat
reader makes no external call and returns unavailable. Air-gapped deployments
need a trusted local price-reader integration to evaluate new fiat thresholds.
Existing signed expiry remains enforceable without fiat connectivity.

## Cryptographic Audit Receipt REST endpoint

```http
POST /api/v1/compliance/indemnity
Content-Type: application/json

{"agent_decision":"Rebalance using this observed state","stratigraphy_data_used":{"height":900000,"signal":"observed"}}
```

The compatibility URL and `indemnity_receipt` response key do not confer legal
indemnity. The backend receipt is named **Cryptographic Audit Receipt**, with
State-Anchored Provenance expressed strictly as a submitted-data commitment.
The decision string is preserved, including whitespace; blank decisions are
rejected. Object keys are recursively sorted by the existing Node canonical
serializer. Hash the canonical validated JSON object containing both request
fields using SHA-256, UTF-8. The response includes the digest, issuance time,
issuer fingerprint, verification limits and the exact active commercial
exemption expiry if the caller is authenticated. Raw decision/data content is
not persisted or returned. Input is bounded to 16,000 decision characters and
128 KiB of canonical JSON.

The attestation signs the following bytes with Ed25519:

```text
bitcoin-stratigraphy/cryptographic-audit/v1\n<canonical receipt excluding issuer_attestation>
```

Kickback and exemption signatures use their own distinct domains:
`bitcoin-stratigraphy/routing-kickback/v1\n` and
`bitcoin-stratigraphy/commercial-exemption/v1\n`. They cannot substitute for
Article 12 receipt, revocation snapshot or tool-integrity signatures.

These APIs provide technical audit evidence and a protocol-managed annual
commercial license status. They do not turn oracle use into a regulatory
requirement, guarantee financial outcomes, or replace review of applicable
licensing terms.
