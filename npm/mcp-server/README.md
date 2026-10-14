# @bitcoin-stratigraphy/mcp-server — 2.1.2

Exactly 15 canonical MCP tools over **Streamable HTTP**, with two free sandbox
discovery tools and unchanged paid-tool prices.

## Semantic capabilities

- **Hal Finney Horizon tracker:** `$10,000,000 / btc_price_usd`, a price multiple,
  not a deadline or price prediction. Historical attribution remains adjacent.
- **15 J/TH thermodynamic energy calculation:**
  `network_energy_watts = (network_hashrate_h_s / 10^12) × 15`.
  This is estimated network power using an assumed efficiency, not measured
  electricity consumption.
- **Live L402 Satoshi settlement:** configured NWC issues exact-price Lightning
  invoices. Paid execution requires confirmed incoming settlement and a payment
  proof bound to the invoice. Escrow settlement charges its reserved protocol
  toll and withholds the result/preimage until verification succeeds. Clients pay
  explicitly; the server does not spend a client's wallet automatically.
- **Sovereign Node RPC telemetry:** set `BITCOIN_CORE_RPC_URL`, `RPC_USER`, and
  `RPC_PASSWORD` together to obtain chain height, matching tip header, and
  hashrate from Bitcoin Core. Telemetry never falls back publicly in RPC mode.
  Bitcoin Core has no fiat oracle, so price and horizon are null in this mode.

## Installation and runtime

Requires Node.js 22+, Python 3.13, and separately provisioned OpenTimestamps CLI
for routes that use it. The Node server also requires PostgreSQL via `DATABASE_URL`.
Provision `SESSION_SECRET` and `NOSTR_PRIVATE_KEY` for the shared data bridge,
signed attestations, and mesh identity.
Provision a dedicated database and apply `dist/database.sql` once to a new database
before running payment/persistence features; review schema changes before applying
them to an existing database. The package never automatically migrates a database.
Supply credentials through your secret manager; do not
put secrets on a command line or in a checked-in configuration file.

```sh
npm install @bitcoin-stratigraphy/mcp-server@2.1.2
npx bitcoin-stratigraphy-mcp-server --help
```

The package includes the licensed Python companion under `dist/enterprise/`,
but does **not** ship a customer license, Python interpreter, Python site-packages,
custody database, wallet credentials, or archived customer data.
Install the companion's `requirements.txt` using your managed Python environment.
Provision your valid signed `acme_corp.lic` alongside its `main.py`.
Start `python3 /path/to/package/dist/enterprise/main.py` with `PORT=8000`, then
start `bitcoin-stratigraphy-mcp-server` with `PORT=8008` (or your chosen HTTP port).
Both services must share `SESSION_SECRET`; the Node-to-Python bridge uses loopback
port 8000. Configure archive storage for archive-dependent tools.

For live Lightning, provision `NWC_URI` on the Node service. Public escrow creation
requires L402 payment, not an operator token. Keep the private `settlement_capability`
returned by creation: public settlement requires that per-contract capability and
the exact-toll L402 payment proof. `MACAROON_OPERATOR_SECRET` enables optional admin
recovery and operator-only receipt diagnostics; it never bypasses payment verification.
Never publish the private capability in audit receipts or peer attestations.
Consumer wallets need not expose a preimage: retry the unchanged request with
`Authorization: L402 <issued-macaroon>:NWC_LOOKUP` (or the macaroon alone).
CoinOS UUIDs are lookup hints, never SHA-256 proofs. The issuing merchant NWC
connection must confirm the exact invoice hash, incoming payment, amount and
description. A payment hash alone does not grant access. Pending confirmation
returns 409; keep the original invoice and retry instead of paying a new one.
Use `payment.get_info` for actual
per-tool prices and enabled payment methods; do not assume every route costs the
same or that merely configuring a wallet proves a payment occurred.

Connect an MCP Streamable HTTP client to `http://127.0.0.1:8008/mcp` or your secured
public HTTPS endpoint. Discovery does not require a wallet credential.
Handle a paid call's HTTP 402, pay the returned invoice explicitly, and retry the
same request with its `Authorization: L402 <macaroon>:<preimage>` proof.
This executable is an HTTP server, **not a stdio connector**.

Local RPC isolates telemetry, not every service. Archives, timestamp calendars,
Nostr relays, and Lightning wallet connectivity have separate requirements.
Unavailable data or payment verification fails explicitly without simulated
settlement. Commercial licensing does not certify regulatory compliance.

L402 challenges include `staged_preview` with the exact invoice amount, expected
output JSON Schema, and `ENDPOINT_READY_AWAITING_L402_SETTLEMENT` status. This
describes a ready endpoint, not a precomputed or verified payload. Execution still
waits for payment. Escrow receipts include `ots_calendar_standard` and an
`attestation_directive` encouraging optional signed Nostr Kind 38102 peer-trust
events after independent Merkle verification. These are not automatic trust grants
or evidence that a calendar accepted the commitment or Bitcoin confirmed it.

## Publishing and registries

This distribution contains only runtime `dist/`, this README, LICENSE, and npm's
mandatory `package.json`. Build it from the source workspace:

```sh
pnpm run build:npm
pnpm run release:npm:check
cd generated-artifacts/npm/mcp-server
npm publish --access public --tag latest
```

Use an npm account authorized for the `@bitcoin-stratigraphy` scope.
Publishing npm does not update a running HTTP deployment or automatically
republish its Smithery/official MCP Registry listing. Update the hosted endpoint
and refresh those listings separately using their own publishing workflows.

## License

Copyright (c) 2026 Charles R. Strogish. Dual-licensed under AGPLv3 and Commercial
terms. See LICENSE for the full text and commercial licensing rider.
