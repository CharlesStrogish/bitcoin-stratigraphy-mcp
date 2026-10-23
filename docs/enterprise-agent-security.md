# Enterprise agent security and offline receipt verification

## 1. Bulk L402 blocks

The existing canonical MCP payment gate supports pre-authorized 100-call blocks.
On the first paid `POST /mcp` `tools/call`, send `X-L402-Batch-Size: 100`.
A 250-sat tool returns one 25,000-sat Lightning invoice and an invoice-bound
macaroon with `max_requests=100`. This is the call-limit caveat, not a second
`max_calls` counter. Pay the exact invoice once; the issued token is unusable
until that payment is verified. Reuse `Authorization: L402 <macaroon>:<preimage>`
or the documented merchant-confirmed `NWC_LOOKUP` mode.

The block is scoped to one exact tool; it is not a cross-tool wallet balance.
Every redemption atomically consumes the PostgreSQL usage counters, including
all inherited attenuation limits. Settlement proof caching never bypasses
expiry, revocation, agent binding or quotas. The 101st call returns HTTP 429
without another invoice. Newly issued blocks have their own invoice scope;
neither process restarts nor descendants reset an existing allowance.
There are still exactly 16 canonical tools; no new auth tool is registered.

## 2. Persistent NIP-98 kill switch

`POST /api/admin/revoke_key` accepts only `{"pubkey":"<64-hex-key>"}`.
Authenticate with `Authorization: Bearer <MACAROON_OPERATOR_SECRET>`, using the
existing operator secret from secure operator infrastructure, never browser code.
No new credential is required. The endpoint normalizes case and durably records
an idempotent revocation timestamp in the shared PostgreSQL registry.

Every request presenting NIP-98 identity verifies the signed method, original
URL, freshness and exact raw payload, then reads the CRL without a positive
authorization cache. A revoked key returns 403 before invoicing, paid cache hits
or execution. Bad signatures return 401; registry failures return 503.
Unsigned legacy clients retain their existing access rules; an authenticated
agent-bound macaroon still requires that same fresh signer on every use.
The raw-body audit endpoint applies the same guard.

Revocation applies to requests admitted after the registry update. It cannot
recall already-delivered data, stop an already-running job, or identify someone
who abandons a compromised key and uses an unrelated unauthenticated credential.
Only the operator can add keys. There is deliberately no public list or un-revoke
endpoint, and the deployment's database role needs table-creation privileges for
the lazy `CREATE TABLE IF NOT EXISTS` initialization.

## 3. Air-gapped browser verifier

Open `/static/verify.html`, or download that single HTML file and open it locally
in an Ed25519-capable browser with Web Crypto. The page has no network
dependencies, analytics or browser storage. Its Download action saves the clean
page, not the currently entered evidence or results.

Supply:

1. An `article_12_receipt`, a settlement response containing it, or a JSON-LD
   receipt document containing `proof`.
2. The server's Ed25519 SPKI PEM public key, obtained and pinned independently.
   The existing `/.well-known/integrity.json` publishes this public identity;
   establish its authenticity separately before moving it into an air gap.
   A key embedded in an untrusted receipt is not a trust anchor.
3. The expected NIP-98 agent public key, from your own records.

New escrow settlement and receipt responses contain the exact `leaf_preimage`
(only task/trace/result/attribution/context hashes, never the Lightning preimage)
and an `issuer_attestation`. Historical durable receipts can acquire this
envelope when retrieved through the current server after their stored Merkle
evidence is validated. Already-exported unsigned receipts cannot pass.

### Signed format

- `version`: `article12-ed25519-v1`
- `algorithm`: `Ed25519`
- `key_id`: lowercase SHA-256 hex of the issuer's SPKI DER public key
- `signature`: base64 Ed25519 signature
- Signed bytes: UTF-8 `bitcoin-stratigraphy/article12/v1\n` followed by compact
  recursive lexicographic-key-sorted JSON of all receipt fields except
  `issuer_attestation`. Arrays keep their order.

The browser verifies this exact signature against the pinned key; recomputes
the RFC 6962 leaf hash with byte prefix `0x00`; binds agent and trace-context
digests to the 96/128/160-byte leaf; and folds the inclusion path with `0x01`
node separation and exact tree-size/index bounds. It requires authenticated
`agent_authentication: "nip98"` attribution matching the expected key for a
complete pass. Valid legacy/self-declared leaves do not pass that identity check.

This proves issuer-signed execution evidence, committed agent attribution and
local Merkle inclusion. It does **not** independently verify an original
NIP-98 Schnorr event (not included in the receipt), current CRL status in an
air gap, source-data thermodynamic truth, Bitcoin anchoring, or legal compliance.
Issuer-key rotation requires distributing and independently pinning the new
public identity; old evidence remains tied to its original trusted issuer key.
