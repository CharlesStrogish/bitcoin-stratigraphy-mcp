# Bitcoin Stratigraphy MCP Server

**[Developer Portal & Live Tool Explorer](https://bitcoinstratigraphy.com/docs)** · **[Python SDK & Integration Cookbooks](https://bitcoinstratigraphy.com/cookbooks)**

## v2.1.3 — 16 Canonical Tools

**Institutional Bitcoin thermodynamic state-anchoring · L402 micropayments · EU AI Act Article 12 execution evidence**

**[Bitcoin Stratigraphy](https://bitcoinstratigraphy.com)** serves enterprise
autonomous swarms through 16 canonical MCP tools. The commercial deployment
path is the **$250,000/year Tier II Commercial Enterprise Exemption**, with
Automated Compliance SLAs for signed revocation exports and receipt-key rotation.

## High-velocity enterprise deployment

- **L402 Bulk Macaroons:** include `X-L402-Batch-Size: 100` on an initial paid
  `tools/call`. Pay the exact upfront invoice once, then reuse the invoice-bound
  credential for up to 100 calls to that exact tool. Expiry, attenuation,
  inherited quotas, NIP-98 identity and revocation still apply on every call.
  Query `POST /api/v1/cost` for free quotes; it does not create invoices.
- **NIP-98 Kill Switch + Signed CRL Snapshots:** operator-authenticated
  `POST /api/admin/revoke_key` persists revocations before future authenticated
  requests can invoice or execute. Public
  [`GET /api/v1/compliance/revocation-snapshot`](https://bitcoinstratigraphy.com/api/v1/compliance/revocation-snapshot)
  exports the complete registry, its ISO `as_of` timestamp, a 15-minute
  `next_update` boundary and the issuer's SHA-256 SPKI fingerprint, all signed
  with Ed25519. Export failures return 503, never a fabricated empty CRL.
- **Zero-Trust Article 12 Verifier:** download
  [`/static/verify.html`](https://bitcoinstratigraphy.com/static/verify.html)
  for self-contained browser verification of signed receipts, committed NIP-98
  attribution and RFC 6962 inclusion. Supply independently pinned current and
  historical issuer PEM keys. An optional signed CRL checks non-revocation at
  its recorded timestamp and freshness against the audit browser's clock.
- **Commercial Enterprise Exemption:** Tier II offers a commercial alternative
  to AGPLv3 for private VPC and air-gapped deployments. The commercial agreement
  governs proprietary swarm IP and Automated Compliance SLAs. AGPLv3 Section 13
  covers corresponding source for covered modified network software; it does
  not automatically require disclosure of independent weights or applications.
  [Enterprise procurement brief](https://bitcoinstratigraphy.com/#enterprise-licensing)
  · [licensing@bitcoinstratigraphy.com](mailto:licensing@bitcoinstratigraphy.com).
- **In-band compliance telemetry:** GET/POST `/api/v1/cost` and L402 challenge
  bodies include `licensing_compliance`. Successful L402 responses expose the
  same JSON in `X-L402-Licensing-Compliance`; settlement logs expose the structured
  object for Splunk/Datadog ingestion without altering any MCP tool contract.

### Automated exports and receipt issuer rotation

Poll the public snapshot endpoint from your audit scheduler before an air-gapped
review. Retain the exact signed JSON and capture clock evidence. A snapshot
proves only the issuer's registry state at `as_of`; `next_update` is a freshness
limit, not a promise that no revocation can occur in that interval. A later
revocation does not erase valid historical execution evidence, and an offline
pass never authorizes a new request.

By default receipts and CRL exports use the persistent tool-integrity issuer.
To rotate **only** receipt/CRL signing, configure a dedicated Ed25519 PKCS#8 PEM
as `ARTICLE12_ISSUER_PRIVATE_KEY` through your secret manager and restart the API.
Never commit private keys. Publish the corresponding SPKI public key through
your independently authenticated procurement/configuration channel **before**
cutover, and retain historical public pins for historical receipts. Receipts
include signed `issuer_key_id` and `issued_at` fields; CRL signatures use a
separate domain from receipt signatures. Paste multiple PEM blocks or a JSON
array of PEM strings into the offline verifier. Each artifact selects only an
independently pinned matching fingerprint. Remove compromised issuer pins
through your enterprise trust process; do not accept self-announced keys.
This does not rotate or modify the 16 MCP tool signatures or descriptions.

Receipt signatures, agent attribution, CRL state, Bitcoin anchoring and legal
compliance are distinct checks. The verifier does not independently re-verify
the original Schnorr-signed NIP-98 request or establish regulatory compliance.

**OpenTimestamps AI Notary Hub · LangChain/LlamaIndex Native · 100-call Macro-Macaroons · Free Sandbox available**

Use [`proof.notarize`](cookbooks/frameworks/README.md#what-the-agent-reports)
to obtain a portable OpenTimestamps receipt for a SHA-256 hash.
Explore the **[native framework quickstarts in `/cookbooks/frameworks`](cookbooks/frameworks/)**:
[LangChain](cookbooks/frameworks/langchain_agent.py) and
[LlamaIndex](cookbooks/frameworks/llamaindex_agent.py).

[![LangChain Ready](https://img.shields.io/badge/LangChain-Ready-1C3C3C)](cookbooks/frameworks/langchain_agent.py)
[![LlamaIndex Ready](https://img.shields.io/badge/LlamaIndex-Ready-6366F1)](cookbooks/frameworks/llamaindex_agent.py)
[![OpenTimestamps Integrated](https://img.shields.io/badge/OpenTimestamps-Integrated-F7931A)](https://opentimestamps.org/)

The catalog contains **14 paid tools and 2 free sandbox tools**:
The new `workflow.audit_trajectory` combines existing diff arithmetic and
minimal boundary SHA-256/OTS receipt references in one **250-sat** call:
`{"fromTarget":"2026-10-12","toTarget":"latest"}`. Both targets are required.
It shares one captured live snapshot across the report, omits intermediate
record/proof-byte envelopes, and does not fabricate OTS coverage for live data.
The two free sandbox tools remain
`stratigraphy.list` and `proof.list`. A notarization Macro-Macaroon authorizes
100 tool-scoped calls for 25,000 sats at the current 250-sat base price.
Calendar acceptance is not Bitcoin confirmation; upgrade and independently
verify `.ots` receipts later. Native clients require prepaid L402 headers or
a trusted, budget-controlled wallet proxy; they do not pay automatically.

[![Glama TDQS](https://img.shields.io/badge/Glama-Grade%20A%20%284.4%2F5.0%29-10b981)](https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy)
[![Smithery Rating](https://img.shields.io/badge/Smithery-100%2F100-brightgreen)](https://smithery.ai/servers/crstrogish/bitcoin-stratigraphy-mcp)
[![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2026--07--28-orange)](https://modelcontextprotocol.io/specification/2026-07-28)
[![L402 Enabled](https://img.shields.io/badge/Monetization-L402%20Lightning-yellow)](https://l402.org)

Enterprise L402 data vending engine serving real-time thermodynamic Bitcoin telemetry, Groth16 ZK-SNARK verification, Nostr P2P mesh consensus, and agent context state grounding to autonomous AI swarms and LLM pipelines across **16 Canonical Tools**.

## Enterprise Architecture

- **Stateless MCP Transport:** MCP `2026-07-28` removes session-affinity
  bottlenecks so requests can be routed across horizontally scaled instances.
  Handshake-era clients remain supported. Transport is stateless; callback
  queues and some rate-limit state remain process-local.
- **Cryptographic Tool Integrity:** All 16 canonical tool descriptions are
  SHA-256 hashed and their digests signed at boot with an Ed25519 keypair.
  The public key, hashes, and signatures are published at
  `/.well-known/integrity.json`. Clients that verify a trusted public-key pin
  can detect description tampering before exposing tools to an LLM.
  Signatures establish provenance, not blanket prevention of tool poisoning;
  see [verification instructions](docs/tool-integrity.md).
- **NIP-98 Agent Identity Binding:** Schnorr-signed NIP-98 HTTP events
  authenticate an agent's pubkey against the request URL, method, and payload
  hash. Authenticated identity is bound into L402 macaroons and the Postgres
  settlement ledger's RFC 6962 Merkle receipts. Authenticated credentials
  require a fresh event from the same pubkey on every use; self-declared
  attribution remains explicitly distinguishable from verified identity.
- **Zero-Polling Asymmetric Webhooks:** Heavy `stratigraphy.get_range` and
  `proof.submit` calls support asynchronous execution: after payment, HTTP 202
  acknowledges the task and the server POSTs its result to `webhook_url`.
  Callbacks use Standard Webhooks `v1a` Ed25519 signatures with the same
  published integrity key. No per-receiver shared secret is required.
  See [callback delivery and verification](#zero-polling-execution-webhook_url).

## Licensing, IP & Enterprise Terms

### Npm server release

`@bitcoin-stratigraphy/mcp-server@2.1.3` is staged separately from this private
workspace. It packages the HTTP MCP runtime, required proof assets, isolated
workers, and the license-gated Python companion inside `dist/`, with README.md,
LICENSE, and npm's mandatory package.json. No wallet secrets, customer license,
custody database, source maps, development workspace, or node_modules are shipped.

From the workspace root:

```sh
pnpm run build:npm && pnpm run release:npm:check
(cd generated-artifacts/npm/mcp-server && npm publish --access public --tag latest)
```

The publish command requires an npm account authorized for the
`@bitcoin-stratigraphy` scope. See [runtime setup](npm/mcp-server/README.md) before
installing: the executable uses Streamable HTTP, not stdio, and the licensed
Python companion runs separately on loopback port 8000.
Npm publication does not update the hosted HTTP server or automatically refresh
Smithery/official MCP Registry entries; publish the endpoint changes and refresh
those listings through their respective workflows.

### Local Bitcoin Core telemetry (enterprise pipeline)

Set all three environment variables on the deployment:
`BITCOIN_CORE_RPC_URL` (for example, `http://127.0.0.1:8332`), `RPC_USER`,
and `RPC_PASSWORD`. Keep credentials in your deployment's secret configuration,
not in source control or the RPC URL. Enable authenticated Bitcoin Core RPC and
restrict its listener/firewall to the engine's trusted network.

`stratigraphy_pipeline.py` then uses only the configured RPC endpoint:
`getblockchaininfo`, `getblockheader`, and `getnetworkhashps`. Headers and hashrate
are bound to the same observed mainnet tip. A node still in initial block download,
invalid/partial configuration, or RPC failure makes telemetry unavailable; it
never triggers a public-API fallback. RPC redirects are refused, and the enterprise
telemetry HTTP client ignores ambient HTTP proxy settings.

Bitcoin Core does not provide BTC/USD prices. Local-mode snapshots report
fiat-dependent valuation fields as `null`, with an explicit
unavailable price source; supply, header, hashrate, and power metrics remain usable.
When **all three variables are absent**, the existing mempool.space/Coinbase
route (including the public price fallback) remains unchanged.
This mode isolates the telemetry pipeline; other services, including cloud
archives, OpenTimestamps calendars, relays, and Lightning wallets, have their
own connectivity requirements.

Run `bash scripts/test-stratigraphy-coverage.sh` to exercise both RPC and public
routes with offline HTTP fixtures. The command enforces **100% statement and
branch coverage** for `stratigraphy_pipeline.py`, including failure paths.

**Created & Architected by Charles R. Strogish.**

Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.

Covered first-party software is **dual-licensed: GNU Affero General Public
License version 3 (AGPLv3) or Enterprise Commercial terms**. The complete AGPLv3
text and dual-licensing rider are in [LICENSE.md](LICENSE.md).

- **Open-source option:** Use, modification and redistribution are governed by
  AGPLv3. Commercial activity is permitted when AGPL conditions are met.
  Preserve required notices, provide corresponding source when required, and
  comply with section 13's source-offer obligations for modified software that
  interacts with users over a network.
- **Enterprise Commercial option:** For proprietary, closed-source enterprise
  swarm deployments or multi-tenant hosting without the source disclosure
  required by AGPL, a Commercial License from Charles R. Strogish is required.
  Deployment scope, rights, fees and support require a separate written
  agreement; this notice is not that agreement. Contact the repository maintainer
  to arrange commercial terms before such deployment.
- **IP and scope:** This model applies to rights the licensor owns or is
  authorized to license. Third-party dependencies, contributions and separately
  licensed datasets retain their own terms. Previously granted licenses are not
  revoked. Payment for API access does not grant a commercial software license.
- **Security:** Follow the coordinated disclosure guidelines in
  [SECURITY.md](SECURITY.md). Do not publish vulnerabilities or credentials in
  ordinary public issues.

These notices do not guarantee legal protection or regulatory compliance.
Obtain qualified legal review of ownership and any enterprise agreement.

## Limitation of Liability & Hold Harmless

All data is provided **"AS IS" and "AS AVAILABLE", without warranty**, express or
implied. To the fullest extent permitted by applicable law, the Bitcoin
Stratigraphy Data Engine and its founder/architect, **Charles R. Strogish, shall
not be held liable for enterprise losses**, downstream financial execution,
hallucinations, or client-system logic failures.

New L402 macaroons carry `liability = "charles_r_strogish_held_harmless"` in their
authenticated HMAC chain. API responses communicate the proposed terms through
`X-Limitation-Of-Liability`; clients are requested to review and record them
before execution. These are technical notices, not proof of legally valid
assent, an indemnity agreement, or guaranteed immunity from lawsuits. Mandatory
law and applicable signed agreements govern enforceability; obtain qualified
legal review. Previously issued paid tokens are not retroactively invalidated.

## Enterprise SDK and Swarm Flight Simulator

Install the self-contained enterprise suite from the checkout or a built wheel:

```bash
pip install ./sdk/python
```

```python
from bitcoin_stratigraphy_enterprise import SwarmFlightRecorder, Article12NotaryCallback
```

The package also provides bilateral settlement and independent offline auditing.
See the [enterprise SDK guide](sdk/python/README.md) for prepaid anchoring,
LangChain/CrewAI integration, console commands and distribution builds.
It is not yet published to PyPI. Legacy cookbook imports and CLI paths remain
compatible.

Open **`/simulator`** on the dashboard for the **Enterprise Swarm Control Room**:
50 synthetic agents stream 1,000 traces into a real, salted SHA-256 Merkle tree.
Select any thought to verify and export its inclusion path. The final
`X-L402-Batch-Size: 100` anchor/OTS receipt is explicitly simulated: **no payment,
no calendar submission, no Bitcoin confirmation**. Selective disclosure is a
Merkle audit path, not a zero-knowledge proof.

## Architecture Overview

### M2M Cryptographic Handshakes & The Zero-Trust Swarm Standard

In the machine economy, autonomous agents cannot rely on trust, heuristics, or unverified peer outputs. The Bitcoin Stratigraphy Data Engine serves as the global clearinghouse and base-layer trust protocol for non-human entities. Enterprise swarms use our L402 Oracle as a zero-trust firewall to verify the outputs of other sub-agents. By requiring a Stratigraphy OpenTimestamps (.ots) receipt or Groth16 proof before accepting data from a peer agent, swarms mathematically eliminate hallucinations, prevent compute-theft, and establish an unforgeable chain of custody across the global AI network.

- **In-band Article 12 context binding:** synchronous calls accept
  `params._meta.agentContextSha256` or `X-Agent-Context-SHA256`. A lowercase SHA-256
  digest adds a fourth signed component to `_meta.responseSignature`; omitted
  context preserves the legacy three-part format. This binds a submitted digest,
  not proof that an agent actually used the data.
- **Wholesale macro-macaroon sub-vending:** buy a tool-scoped 100-call capability
  with `X-L402-Batch-Size: 100`, then use `proof.attenuate` with
  `delegate_pubkey = <pubkey>`, `requests = 1`, `rpc` and `time` caveats.
  Children require fresh delegate NIP-98 signatures and consume inherited quotas.
  Wholesale ancestor revocation is enforced; invoice attribution cannot move.
- **NIP-98 solvency attestations:** `payment.get_info` accepts `_meta.targetPubkey`
  or `X-Target-Pubkey`, otherwise using the authenticated caller. REST:
  `GET /api/v1/compliance/agent-solvency?pubkey=<pubkey>`. Signed telemetry reports
  confirmed settlement volume, distinct settled invoice count, and current
  revocation—not future creditworthiness or a payment guarantee.
- **Upstream verification allocation:** authenticated creation records an
  immutable first-recorded origin for supported proofs/receipts. A successful,
  paid `proof.verify` on that same statement records a 15% upstream allocation
  and the remaining 6% caller allocation from the existing programmatic L402
  revenue sharing pool. No additional merchant funding is used. Integer-msat
  rounding preserves the original pool exactly; the caller receives its
  remainder after flooring the upstream amount. Historical signed invoices and
  other tool allocations stay unchanged. Replay cannot create another credit.
  Counters appear in `payment.get_info` and `/api/v1/escrow/stats`; accounting
  remains ledger-only, with no automatic disbursement.

```text
AI swarms & LLM agent clients
             |
             v
Discovery + Streamable HTTP MCP
/.well-known/mcp.json -> /mcp
             |
             v
L402 gateway + scoped macaroons
Pricing -> invoice -> payment proof
             |
             v
16-tool router / 5 namespaces
stratigraphy (5) | proof (7)
mesh (2)        | payment (1)
workflow (1)
             |
             v
Telemetry / Groth16 / Nostr mesh
             |
             v
Lightning settlement / OTS receipts
```

- **Clients:** Claude, GPT-based agents, Perplexity integrations, autonomous
  swarms, and custom MCP runners need a compatible client; naming a client here
  does not imply that it has automatic wallet or payment support.
- **Discovery and gateway:** Public discovery links directly to the `/docs`
  portal and identifies the MCP endpoint. `GET /api/v1/cost` advertises REST
  prices and asset availability; `POST /api/v1/cost` accepts a `tools` array
  and returns free itemized MCP satoshi prices, a batch total, and per-tool
  L402 invoice-generation instructions without creating or paying invoices.
  `payment.get_info` advertises MCP terms. Paid calls receive HTTP 402
  challenges, then redeem verified payment proofs and scoped macaroons.
- **Tool routing:** The canonical catalog contains 5 `stratigraphy.*`,
  7 `proof.*`, 2 `mesh.*`, 1 `payment.*`, and 1 `workflow.*` tools.
- **Telemetry subsystem:** The 422-record historical dataset supports indexed
  lookups, numerical differences, source-record digests, and compact ranges.
  Historical height mappings are deterministic indices, not native block
  provenance. Live telemetry and the separate REST SSE feed have their own
  freshness and availability boundaries.
- **Cryptographic subsystem:** Groth16/Poseidon BN254 verifies defined telemetry
  statements; drift verification and OTS receipt verification have distinct
  evidence requirements. Signed agent-context receipts are a separate,
  off-chain Bitcoin-tip attestation mechanism.
- **Mesh and anchors:** NIP-01/78 broadcasts and pinned-peer quorum checks expose
  provenance and cross-validation metrics. Lightning settlement, signed tip
  receipts, and Bitcoin-confirmed OTS receipts are distinct mechanisms.

## Key Capabilities

- L402 Micropayments & Macaroon Attenuations: Programmatic pay-per-query settlement in satoshis with zero API keys. Supports parent macaroon caveat scoping (proof.attenuate) with TTLs and rate controls.
- Multi-Asset Settlement Router: Native payment support across Base-layer Lightning (btc-lightning), Liquid Bitcoin (l-btc), Taproot Assets (taproot-assets), and Base USDC (x402).
- Groth16 ZK-SNARK & OTS Proof Verification: Execute cryptographic verification for supplied Groth16/Poseidon BN254 telemetry proofs, drift zk-SNARKs, and OpenTimestamps (OTS) Bitcoin block-header receipts.
- Agent Context State Grounding: Anchor autonomous agent prompt executions, CIDs, and dataset context hashes directly into signed Bitcoin-tip receipts (proof.ground).
- Autonomous P2P Mesh Network: Nostr-backed (NIP-01/78) peer topology broadcasting with automated quorum validation, cross-validation metrics, and node public-key provenance.
- Stratigraphy Strata Analytics: High-speed differential comparisons (stratigraphy.get_diff) and compressed record digests designed specifically for LLM context window efficiency.
- Real-Time SSE Streaming: Live Server-Sent Events (/api/v1/stratigraphy/stream) for continuous telemetry feeds.

### Autonomous Proof-of-Execution Escrow Oracle (L402 + RFC 6962)

Machine-native conditional micro-settlement for autonomous agent-to-agent delegation.

* **Phase 1: Bounty Lock:** The delegating agent (Agent A) locks a satoshi bounty (e.g., 1,000 sats) to an execution contract, such as model fine-tuning verification.
* **Phase 2: Work Submission:** The worker agent (Agent B) completes the task and submits a deterministic execution trace along with the result hash.
* **Phase 3: Settlement & Toll:** The Stratigraphy Hub validates the RFC 6962 Merkle leaf, releases the payment preimage to the worker agent, and automatically collects a dynamic protocol toll (pegged to ~$0.02 USD in satoshis).
* **Live Network Status:** The terminal reads unauthenticated `GET /api/v1/escrow/stats` on page load and refreshes every five minutes while visible. PostgreSQL-backed `total_settled_sats` and `total_contracts` include the preserved historical genesis exactly once, exclude unpaid commitments and REST access fees, and retain the legacy `verified_toll_sats` / `settled_contracts` aliases. `latest_merkle_root` exposes the latest execution leaf hash, not the aggregate tree root or proof of Bitcoin inclusion. Empty ledgers return zero totals and a null hash; failed reads return HTTP 503 and the ticker stops indicating live connectivity.
* **Enterprise Sandbox:** Includes a client simulation terminal allowing risk teams to copy the JSON escrow proof without requiring real payments or live Bitcoin anchors.

### Operational boundaries

- **Payment rails are surface- and configuration-dependent.** The REST L402 router
  supports `btc-lightning`, `l-btc`, and `taproot-assets`; Liquid and Taproot Assets
  need configured providers. Check `/api/v1/cost` for availability. MCP paid tools
  use Lightning L402 plus Base USDC x402 only when configured; `payment.get_info`
  reports their current terms, not all REST router assets. Lightning is Bitcoin's
  payment-channel layer; Base USDC is a separate EVM rail.
- **API-keyless does not mean unauthenticated paid execution.** Wallet
  authorization, exact payment proofs, scoped credentials, and client spending
  limits remain required. Macaroon TTL/request budgets and HTTP rate limits are
  separate controls.
- **Live streaming and historical indexing are different.** MCP uses Streamable
  HTTP at `/mcp`. The paid REST SSE feed at `/api/v1/stratigraphy/stream` refreshes
  snapshots on a 30-second cadence and supports configured L402 router assets,
  not a promised Base USDC SSE rail. Historical strata remain indexed daily
  records, not native block provenance.
- **Cryptographic checks have defined trust boundaries.** Groth16 verifies an
  exact statement/payload, not source truth or every agent reasoning step.
  Grounding receipts are off-chain Schnorr-signed Bitcoin-tip attestations, not
  on-chain transactions or ZK/PoW validity proofs. OTS verification requires an
  actual receipt and matching target digest; calendar acceptance is not Bitcoin
  confirmation.
- **Mesh consensus is scoped.** Broadcasts and quorum checks use configured,
  pinned peers; peer agreement does not establish source truth. Enterprise use
  still requires organizational supervision and durable evidence retention; see
  [the compliance framework](docs/ENTERPRISE_COMPLIANCE.md).

The Glama badge is a static snapshot of the **A (4.4/5.0)** tool-definition
quality score, checked on September 30, 2026. The Smithery badge displays the
supplied **100/100** listing score. Follow the registry links for current results;
neither badge is an independent security audit or blanket verification of data.
Signed Bitcoin-tip receipts are attestations, not Groth16 proofs or Bitcoin
proof-of-work validity proofs.

## Tool Directory

The directory uses bulleted definitions rather than multi-column tables so each
tool description can wrap independently on mobile. These are the **16 canonical
MCP names** returned by `tools/list`.

### `stratigraphy.*` — 5 tools

- **`stratigraphy.list`** — Discover UTC archive bounds, the current Bitcoin tip
  height, and catalog metadata without paid snapshot or proof bytes.
  - Access: free, parameterless discovery.
- **`stratigraphy.get`** — Retrieve full live pipeline telemetry and selected
  archived UTC snapshots by date or height, recent days, or bounded ranges, with
  their OpenTimestamps receipts; optionally select metrics.
  - Access: paid, read-only. The record limit is 1–100, default 10.
- **`stratigraphy.get_digest`** — Retrieve SHA-256 fingerprints of archived or
  live pipeline JSON, with associated receipts, when full telemetry is unnecessary.
  - Access: paid, read-only. A fingerprint is not a verification receipt.
- **`stratigraphy.get_diff`** — Compute signed deltas between two live or archived
  snapshots, including the 15 J/TH power change.
  - Access: paid, read-only. `fromTarget` is required; `toTarget` defaults to `latest`.
- **`stratigraphy.get_range`** — Retrieve fingerprints for a contiguous span of
  captured UTC snapshots across inclusive height or date bounds.
  - Access: paid, read-only. `startTarget` is required; the batch limit is 1–100,
    default 50. Optional `webhook_url` gives zero-polling execution (see below).

### `proof.*` — 7 tools

- **`proof.attenuate`** — Append strictly formatted first-party caveats to an
  authentic, unexpired parent macaroon: an expiration boundary
  (`time < 2026-12-31T23:59:59.000Z`), exact tool targets
  (`rpc = stratigraphy.get_diff`), and target, path, or request budgets.
  - Access: paid. Supply `macaroon` and at least one restriction: `expiresAt` or
    `ttlSeconds`, `tools`, or `caveats`. Redemption is refused at or after the
    deadline (HTTP 401) and for any tool the `rpc` caveat does not name exactly
    (HTTP 403). A child cannot widen inherited authority, and later redemption
    still requires the parent's payment proof.
- **`proof.verify`** — Verify supplied Groth16 telemetry proofs, drift zk-SNARKs,
  or OpenTimestamps receipts.
  - Access: paid. Verification can update a bounded lifecycle index; drift checks
    require a Bitcoin block provider. OTS needs a real receipt and matching digest.
- **`proof.get_by_hash`** — Retrieve a retained proof, signed receipt, or
  lifecycle-only status using exactly one known `hash` or `jobId`.
  - Access: paid, read-only. Retrieval does not rerun Groth16 verification or
    reconstruct missing proof payloads.
- **`proof.list`** — Discover, filter, and paginate recent proof lifecycle
  summaries from bounded process-local memory.
  - Access: free sandbox discovery (alias `proof.status`). Supports `limit`,
    `offset`, and optional `status`; returns summaries, not full proofs.
- **`proof.submit`** — Register a Groth16 proof with its five public signals,
  then attempt a NIP-78 attestation.
  - Access: paid; changes proof registry state. Nostr publication can fail
    separately, and registration does not append the proof to a Merkle tree.
    Optional `webhook_url` gives zero-polling execution (see below).
- **`proof.notarize`** — Create a detached OpenTimestamps `.ots` receipt for a
  SHA-256 digest using public calendars.
  - Access: paid; `X-L402-Batch-Size: 100` buys 100 tool-scoped calls for
    25,000 sats. Returns `pending_calendar`; calendar acceptance is not Bitcoin
    confirmation.
- **`proof.ground`** — Issue a signed Bitcoin-tip receipt for agent context
  (`contextHash` plus `agentId`) or for a dataset CID.
  - Access: paid; the input modes are exclusive. This is an off-chain signed
    anchor, not a Groth16 proof, on-chain transaction, or Bitcoin-confirmed OTS receipt.

### Zero-polling execution (`webhook_url`)

`stratigraphy.get_range` and `proof.submit` accept an optional public HTTPS
`webhook_url`. After the L402 payment is verified, the server answers
**HTTP 202 Accepted** with a `task_id` and status `pending`, runs the tool in the
background, then POSTs the final MCP result (or JSON-RPC error) with the same
`task_id` to the callback. Each callback is signed under the Standard Webhooks
scheme (`Webhook-Signature: v1a,…`, Ed25519) with the key published at
`/.well-known/integrity.json`. Without `webhook_url` the call stays synchronous.
Unsafe callback targets are refused before an invoice is issued, and tasks live
in server memory, so a restart loses pending work. See
[CONNECT.md](CONNECT.md#zero-polling-execution-with-webhook_url) for the request
and callback shapes.

### `mesh.*` — 2 tools

- **`mesh.get_status`** — Inspect configured peer health, quorum status, node
  provenance, and cross-validation metrics.
  - Access: paid, read-only. Status describes the configured pinned-peer mesh,
    not arbitrary-peer trust or proof of source truth.
- **`mesh.broadcast`** — Send signed indexed telemetry to configured peers
  through the outbound broadcast and cross-validation flow.
  - Access: paid; performs network side effects. Quorum results depend on the
    configured peer policy and availability.

### `payment.*` — 1 tool

- **`payment.get_info`** — Discover current MCP pricing and settlement methods,
  or check authenticated settlement status.
  - Access: paid L402 call; `action: "query"` is the default and `action: "settle"`
    requires authenticated payment evidence. Neither mode mints a macaroon or
    creates an invoice. Free price quotes are available from `/api/v1/cost`.

### `workflow.*` — 1 tool

- **`workflow.audit_trajectory`** — Deterministic composite workflow executing end-to-end thermodynamic audits. Returns signed deltas and compressed proof receipts in a single payload to save LLM context tokens.
  - Access: paid; currently 250 sats per call.
  - Inputs: required `fromTarget` and `toTarget`, for example
    `{"fromTarget":"2026-10-12","toTarget":"latest"}`.
  - Combines existing diff arithmetic, exact-byte SHA-256 boundary
    fingerprints, and available OTS receipt references. Live boundaries have
    no archived OTS receipt; this does not create a new Bitcoin-confirmed proof.

Most paid MCP calls currently cost **250 sats** without valid credentials.
Check `payment.get_info` and the actual challenge for current terms; do not
assume a static per-call price applies to every payment policy or asset.

## Signed synchronous MCP responses and prepaid batch discovery

Successful synchronous `tools/call` results include `_meta.responseSignature`
using the same persistent Ed25519 identity published at
`/.well-known/integrity.json`. Existing `content`, `structuredContent`, and other
metadata remain intact, including stateless server-info metadata. Payment errors,
JSON-RPC errors, discovery results, and asynchronous HTTP 202 acknowledgements do
not receive this envelope; callbacks retain their separate signed-webhook format.

The server signs UTF-8 `tool_name.timestamp.contentSha256`, where `tool_name` is
the exact requested tool name (including any supported alias), `timestamp` is
integer Unix seconds, and `contentSha256` hashes the deterministic JSON object
containing `content` and, when present, `structuredContent`. Object keys are
recursively sorted; arrays and text bytes keep their order. Verify both payload
representations, not just whichever one your client displays.

The exported `verifyToolResponse` helper in
`artifacts/api-server/src/lib/mcp-response-signature.ts` checks the signature,
trusted-key fingerprint, exact tool name, digest and a default five-minute clock
tolerance. Independently pin `server_public_key` before verification. Signatures
establish origin and content integrity, not factual correctness or request-level
replay protection. See [canonicalization and verification](docs/tool-integrity.md#signed-synchronous-tool-responses).

`GET /api/v1/cost`, `POST /api/v1/cost` quotes and the native
`stratigraphy://catalog/overview` resource expose a `batchSettlement` block.
The currently supported pass size is **100 calls**, not an arbitrary 10–1000
range. Include `X-L402-Batch-Size: 100` on the initial paid `tools/call` challenge,
settle its single upfront Lightning invoice, then reuse its invoice-bound
macro-macaroon/preimage for up to 100 calls to that same tool. The price is 100
times the per-call price. Payment-proof caching avoids repeated Lightning
settlement latency; expiry, revocation, attenuation and inherited request quotas
are still enforced on every call. This is not a cross-tool aggregate invoice,
does not enable x402 batching, and discovery itself never creates an invoice.

## Native MCP Resources & Prompts

The endpoint exposes **3 public Resources and 3 public Prompts alongside the
16 canonical tools**, on both stateless `2026-07-28` and legacy `2025-11-25`
transports. Discovery and prompt retrieval require no L402 payment; executing
paid tools recommended by a prompt still requires settlement.

### Resources

Call `resources/list` for the catalog, then `resources/read` with a `uri`:

- **`stratigraphy://catalog/overview`** — Bitcoin Stratigraphy Catalog & L402
  Overview: indexed dataset boundaries, all 16 tools grouped by namespace,
  and L402 Lightning settlement and NIP-98 authentication instructions.
- **`stratigraphy://compliance/eu-ai-act-article-12`** — EU AI Act Article 12 &
  Enterprise Licensing Matrix: structured logging-control mappings for RFC 6962
  receipts, authenticated agent identity, macaroon attenuation, and Article
  26(6) retention, plus the **$250k/year Commercial Enterprise Exemption** at
  **licensing@bitcoinstratigraphy.com**.
- **`stratigraphy://security/tool-integrity`** — Ed25519 Signed Tool Integrity
  Manifest: the identical startup payload served at
  `/.well-known/integrity.json`, including all 16 description hashes and
  signatures. Verify with an independently trusted public-key pin.

All three use `application/json`; parse `contents[0].text` as JSON. Unknown
URIs return JSON-RPC `-32602`. Resource contents provide context and evidence,
not automatic legal certification or proof of arbitrary factual claims.

### Prompts

Call `prompts/list`, then `prompts/get` with a `name` and optional `arguments`
object. All argument values are strings.

- **`ground_agent_reasoning`** — required `claim`; optional
  `targetHeightOrDate` (defaults to `latest`). Guides `stratigraphy.get` and
  `proof.ground`, including budget-approved L402 settlement and explicit
  limits on what context anchoring can establish.
- **`audit_thermodynamic_trajectory`** — required `fromTarget` and `toTarget`.
  Guides a composite `workflow.audit_trajectory` call and `proof.verify`
  verification of available referenced OTS receipts; never invents proof
  coverage for live boundaries.
- **`evaluate_enterprise_compliance`** — optional `organizationName` and
  `swarmSize`. Embeds the compliance resource and guides a private VPC/air-gap
  assessment, NIP-98 identity binding, `proof.attenuate` circuit breakers,
  retention controls, and commercial licensing.

Unknown names, missing required arguments, and invalid argument types or
values return JSON-RPC `-32602`.

For stateless requests, include the usual protocol `_meta`,
`MCP-Protocol-Version: 2026-07-28`, and the matching `Mcp-Method`.
`Mcp-Name` is optional for `prompts/get` and `resources/read`; when provided,
it must match `params.name` or `params.uri`, respectively. Example body:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "resources/read",
  "params": {
    "uri": "stratigraphy://security/tool-integrity",
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Stateless `resources/list`, `resources/read`, and `prompts/list` results include
`ttlMs: 300000` and `cacheScope: "public"`. Argument-specific `prompts/get`
results are not advertised as publicly cacheable. Legacy clients use their
normal initialize handshake and omit the stateless `_meta` fields. Neither
subscriptions nor list-change notifications are advertised.

## Public Auto-Discovery

- **Manifest:** `GET /.well-known/mcp.json`
- **MCP transport:** Streamable HTTP at `/mcp`
- **Tool discovery:** JSON-RPC `tools/list`
- **REST cost discovery:** `GET /api/v1/cost`
- **MCP cost discovery:** `payment.get_info` with its default query action

The manifest is public and unmetered, returns `application/json`, and sets
`Access-Control-Allow-Origin: *`. After publishing the endpoint update, retrieve
it from the deployment:

```sh
curl -i https://bitcoinstratigraphy.com/.well-known/mcp.json
```

The manifest declares release version `2.1.3`, `mcp.version: "2026-07-28"` and
`mcp.supported_versions`. Those are metadata values, not protocol configuration.
The endpoint serves the stateless MCP `2026-07-28` transport and still accepts
handshake-era clients on `2025-11-25` and earlier. Let clients negotiate rather
than forcing the manifest's declared version.

## Quick Connect

**Live MCP endpoint:** `https://bitcoinstratigraphy.com/mcp`

**Transport:** Streamable HTTP, stateless · **Protocol:** MCP `2026-07-28`
(handshake-era `2025-11-25` clients remain supported)

The endpoint keeps no sessions: there is no `initialize` handshake and no
`Mcp-Session-Id`, so any server instance can answer any request. A `2026-07-28`
client calls `server/discover` for supported versions and capabilities, then
sends its protocol version and client capabilities in `params._meta` on every
request, with matching `MCP-Protocol-Version`, `Mcp-Method` and (for
`tools/call`) `Mcp-Name` headers. See [CONNECT.md](CONNECT.md) for the request
shape.

Discovery with `stratigraphy.list` and `proof.list` is free. These connection
examples do **not** provide a wallet or pay L402 invoices automatically. Check
`payment.get_info` for current per-tool prices before enabling paid calls; the
published price for most paid tools is 250 sats, not 10 sats.

### Claude Desktop

Open **Settings → Developer → Edit Config**, then merge this entry into
`claude_desktop_config.json` (requires Node.js and `npx`). The `mcp-remote`
bridge connects Claude Desktop's local stdio client to the remote HTTP server:

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://bitcoinstratigraphy.com/mcp"]
    }
  }
}
```

Restart Claude Desktop, then confirm `bitcoin-stratigraphy` appears in its MCP
server list. Start with `stratigraphy.list` or `payment.get_info`.

See [CONNECT.md — Claude Desktop](CONNECT.md#claude-desktop) for setup and payment details.

### Cursor

Add to `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "url": "https://bitcoinstratigraphy.com/mcp"
    }
  }
}
```

Merge the entry into any existing `mcpServers` object, then enable the server in
Cursor's MCP settings. Cursor connects directly over HTTP; no local server is needed.

See [CONNECT.md — Cursor](CONNECT.md#cursor) for setup and payment details.

### Custom Agent Orchestrators

Use the official TypeScript MCP SDK's `StreamableHTTPClientTransport`. Install
the SDK in your agent project:

```sh
npm install @modelcontextprotocol/sdk
```

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({
  name: "stratigraphy-agent",
  version: "1.0.0",
});

try {
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL("https://bitcoinstratigraphy.com/mcp"),
    ),
  );

  const catalog = await client.listTools();
  console.log(catalog.tools.map((tool) => tool.name));

  // Free pricing discovery only; this does not authorize a payment.
  const paymentInfo = await client.callTool({
    name: "payment.get_info",
    arguments: {},
  });
  console.log(paymentInfo);
} finally {
  await client.close();
}
```

For other languages or frameworks, use an MCP client supporting Streamable HTTP
and point it at the same URL. Clients implementing `2026-07-28` use
`server/discover` and per-request `_meta`; older clients initialize as before.
Let the client negotiate the protocol version and manage MCP headers; this is
not a legacy `/sse` endpoint.

Paid tool execution requires a separate, wallet-enabled L402 integration:
handle the HTTP `402` challenge, obtain explicit payment authorization, pay the
Lightning invoice, and retry using `Authorization: L402 <macaroon>:<preimage>`.
Never commit wallet secrets, macaroons, or payment preimages to client
configuration or registry files. See [CONNECT.md](CONNECT.md) for payment details.

### ElizaOS

Install `@elizaos/plugin-mcp` and make `npx` available to the agent:

```ts
import type { Character } from "@elizaos/core";

export const character: Character = {
  name: "StratigraphyAgent",
  plugins: ["@elizaos/plugin-mcp"],
  settings: {
    mcp: {
      servers: {
        bitcoinStratigraphy: {
          type: "stdio",
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            "https://bitcoinstratigraphy.com/mcp",
          ],
        },
      },
    },
  },
  system: "Inspect payment.get_info before requesting paid Bitcoin Stratigraphy tools.",
};
```

See [CONNECT.md — ElizaOS character](CONNECT.md#elizaos-character) for setup and payment details.

## Ecosystem Registry Discovery

- [Smithery listing](https://smithery.ai/servers/crstrogish/bitcoin-stratigraphy-mcp)
  · root connection metadata: [`smithery.yaml`](smithery.yaml).
- [Glama listing and live score](https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy)
  · root metadata: [`glama.json`](glama.json).
- [Public MCP server card](https://bitcoinstratigraphy.com/.well-known/mcp/server-card.json)
  · [Agent discovery guide](https://bitcoinstratigraphy.com/llms.txt).

Root metadata makes the repository easier to inspect, but does not automatically
submit it to every index. For Smithery's current remote-server registration flow,
submit the live MCP URL at [smithery.ai/new](https://smithery.ai/new), or use its CLI
from an authenticated maintainer account:

```sh
smithery mcp publish "https://bitcoinstratigraphy.com/mcp" -n crstrogish/bitcoin-stratigraphy-mcp
```

See [Smithery's publishing documentation](https://smithery.ai/docs/build/publish).
This connects a registry listing to the existing server; it does not deploy a
local stdio process or require changes to the server's tool definitions.

## Autonomous routing, audit receipts and annual commercial exemptions

> Provides corporate risk teams with an unforgeable cryptographic audit trail, mathematically proving that an autonomous agent based its execution on state-anchored thermodynamic data.

**Verification limit:** this enterprise positioning sentence is not a proof
that an agent actually used the data. A Cryptographic Audit Receipt signs the
submitted SHA-256 decision/data commitment; it does not independently prove
state anchoring, data truth, absolute unforgeability or legal indemnification.

- Optional X-Agent-LNURL or X-Agent-Lightning-Address binds a signed programmatic L402 revenue sharing allocation to the issued L402 invoice. Verified settlement credits the PostgreSQL ledger once; no payouts are sent.
  Invoice settlement alone does not make this allocation payable; current address
  verification is also required.
- `POST /api/v1/compliance/indemnity` returns a domain-separated Ed25519
  **Cryptographic Audit Receipt** in `indemnity_receipt`. It accepts
  `agent_decision` and `stratigraphy_data_used`, and states its verification
  limits explicitly.
- Fresh NIP-98 authentication binds `Buyer-Pubkey` to confirmed cumulative spend.
  At the live BTC/USD equivalent of $250,000 in new qualifying volume, a signed
  Tier II token unlocks for **exactly 365 days**. It prints the exact UTC
  **Expiry Date** and cryptographic `exp`; e.g. unlock
  `2026-10-24T00:00:00.000Z` → **Expiry Date: `2027-10-24T00:00:00.000Z`**.
- `GET /api/v1/compliance/commercial-exemption` returns buyer status.
  `POST /api/v1/compliance/commercial-exemption/purchase` provides a funded L402
  bulk-purchase path. Unpaid invoices and self-declared reservations grant no
  rights. Renewals require new confirmed qualifying volume, never replayed
  historical spend.
- At expiry without qualifying renewal, future macaroons lose
  `Commercial-Exemption: Active`; status responses and subsequent authenticated
  request logs report high-risk AGPLv3 copyleft/no active commercial exemption.
  Actual AGPL duties depend on covered software and use.

See [enterprise protocol economics and verification](docs/enterprise-protocol-economics.md)
for canonical hashing, signed-token checks, rate/price limits and air-gap
behavior. All 16 canonical MCP schemas and parameter structures are unchanged.
