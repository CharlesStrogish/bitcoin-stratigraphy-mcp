<!-- Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available). -->
# Enterprise agent API

Run the Python enterprise entry point:

```sh
uv run --no-sync python main.py
```

Or launch ASGI directly:

```sh
uv run --no-sync uvicorn agent_api:app --host 0.0.0.0 --port 8000
```

Both routes require the project-root `acme_corp.lic` to verify against the
embedded Ed25519 issuer key. A missing, expired, malformed or incorrectly signed
license halts startup. The license is checked at app construction and again
before ASGI startup; there is no environment flag or alternate issuer-key file.

The server honors `PORT` when launched through `main.py` or `agent_api.py`.
It is registered as a second service of the existing API artifact.

## Endpoints

- `/agent-api/docs`: OpenAPI documentation.
- `/agent-api/supply-metrics`: REST JSON for `get_supply_metrics`.
- `/agent-api/mcp`: MCP Streamable HTTP; two tools, `get_supply_metrics` and
  `get_historical_proof`.
- `/agent-api/historical-proof?date=YYYY-MM-DD`: archived JSON and OpenTimestamps
  proof, including exact contents and download URLs.
- `/agent-api/health`: process health; not an MCP tool.

The existing `/mcp` server and its 15 canonical tools are unchanged.

## Supply semantics

`stratigraphy_pipeline.py` starts one asyncio background worker per ASGI process,
only after the enterprise license gate passes. It fetches inputs concurrently and
publishes one immutable, complete snapshot every 30 seconds. API/MCP reads share
that snapshot rather than issuing another upstream request per agent call.
Shutdown cancels and awaits the worker and its in-flight requests before closing
the HTTP client.

Sources:
- Height: `https://mempool.space/api/blocks/tip/height`.
- Hashrate: `https://mempool.space/api/v1/mining/hashrate/1w`, using
  `currentHashrate` in **hashes per second**, not the historical series or difficulty.
- Spot USD price: `https://api.coinbase.com/v2/prices/BTC-USD/spot`.
- Price fallback: `https://mempool.space/api/v1/prices`; its timestamp must be
  at most 15 minutes old and no more than 60 seconds in the future.

Each streamed request has an eight-second total deadline and a bounded response
size; the entire refresh is bounded to 20 seconds. Failed refreshes invalidate
the previous snapshot and retry with bounded exponential backoff. Missing,
malformed or expired snapshots return HTTP **503**, never mock data or a mixture
of partial new inputs and previous values. Snapshots expire after 90 seconds.
`observed_at_utc` records successful collection time; `snapshot_age_seconds`
reports its age, not an upstream quote timestamp. The process-health endpoint
includes `pipeline_ready` separately from process liveness.

`current_epoch` is the **zero-based halving epoch**, calculated as
`block_height // 210000`. Genesis is epoch 0; height 840000 begins epoch 4.
This is not a 2016-block difficulty-adjustment epoch.

`scheduled_issued_supply_sats` sums integer-satoshi block subsidies from genesis
through the reported tip, inclusive. `estimated_issued_supply_btc` converts that
value to BTC. `supply_progress_percent` compares it with the fixed 21,000,000 BTC
ceiling. This is scheduled issuance, not measured circulating or spendable supply:
genesis, unclaimed rewards, lost coins and burned/unspendable coins are not
subtracted. The exact satoshi field avoids relying on floating-point BTC precision.

## Thermodynamics and Hal Finney Horizon

The unified REST/MCP response adds:

- `btc_price_usd`: the live provider spot quote.
- `hal_finney_horizon_multiple`: exactly `10000000.0 / btc_price_usd`, without
  arbitrary rounding or clamping.
- `attribution`, immediately after the multiple in JSON, exactly:
  `"Projected by Hal Finney on January 10, 2009 ($10M per coin valuation under total global wealth absorption)."`
- `network_hashrate_h_s`: provider-estimated current network hashrate in H/s.
- `network_hashrate_th_s`: H/s divided by `1e12`.
- `network_energy_watts`: TH/s multiplied by `15`, in **joules per second**.
- `efficiency_baseline_j_th`: exactly `15`.
- `price_source`, `hashrate_source` and `energy_method`: provenance and units.

The 15 J/TH baseline is an assumed modern-miner efficiency model, not measured
network electricity consumption. Hashrate is also a provider estimate. The
horizon is a price multiple toward $10M per coin, **not days remaining or a
prediction of when that valuation will occur**.

The license gate authorizes this deployment to start; it is not per-agent request
authentication. No existing L402 gates or public API access rules were changed.

## Phase 3: cryptographic provenance

`provenance_anchor.py` schedules a background job at **midnight UTC**, once per UTC
day, after licensed ASGI startup. It captures the live pipeline's complete,
non-expired snapshot and uploads these objects to **Replit App Storage**:

```text
provenance/daily/snapshot_YYYY-MM-DD.json
provenance/daily/snapshot_YYYY-MM-DD.json.ots
```

The date identifies the archive's UTC capture day; the JSON's `observed_at_utc`
retains the source-collection time. The job does not manufacture past dates or
capture an additional snapshot merely because the process restarts. The first
new snapshot is created at the next midnight UTC. If collection/stamping fails,
the job retries every five minutes. Once JSON is saved, retries stamp those
**same bytes**, never recapture different data under that date. The JSON is
uploaded **before** public-calendar submission, and the proof is uploaded as soon
as it is generated. An interrupted proof operation can therefore resume from
the bucket's original JSON even after the entire local filesystem is replaced.

The installed `opentimestamps-client` supplies the official core library.
Stamping uses SHA-256 detached-file proofs, standard random-nonce blinding,
and the library's default public calendar pools. The asyncio transport has
deadlines, bounded responses and disabled redirects; it requires two accepted
calendar responses, matching the CLI default quorum. Files are atomically
published without overwriting existing archives. Cloud uploads use atomic
generation-zero preconditions, so competing instances cannot replace a date's
snapshot or initial proof; all adopt the existing cloud snapshot before stamping.
Per-date filesystem locks additionally coordinate workers sharing local disk.
Shutdown cancels and awaits outstanding calendar submissions.

`replit-object-storage` provides managed Replit credentials. The provisioned
bucket is selected by `DEFAULT_OBJECT_STORAGE_BUCKET_ID`; no separate Google
service-account key is needed. The SDK's authenticated GCS handle supplies
create-only uploads, bounded range downloads and transport timeouts.

**Object Storage is the source of truth** for all historical REST and MCP
responses, including JSON, proof and ZIP downloads. Local files under
`generated-artifacts/provenance/` are only staging/retry caches and remain
excluded from Git and deployment images. Existing local archives are uploaded
on startup; completed receipts are preserved without restamping. Startup and
five-minute recovery scans discover cloud snapshots missing proofs, including
ones created by a previous deployment with no surviving local cache.

Successfully uploaded archives survive replacement of the application filesystem.
Storage outages are reported explicitly; there is no silent local-file fallback.
If a server is lost before its initial JSON upload succeeds, that unuploaded
capture cannot be recovered from Object Storage. A missed date remains unavailable
rather than being backfilled with today's data. The midnight producer still
requires a running licensed API process.

### Automatic Bitcoin finalization

`provenance_upgrade.py` scans every `.ots` object in the configured bucket on
startup and **every six hours** while the licensed API runs. A dedicated,
single-thread background worker keeps calendar, Bitcoin and storage I/O off the
ASGI event loop and off the data pipeline's shared thread pool.

The official OpenTimestamps core library upgrades pending attestations. Before
replacement, the worker checks the Merkle commitment against matching block
headers from Blockstream and mempool.space, including header hash and proof of
work. It removes calendar-only branches and atomically **overwrites the same
`.ots` object**, conditional on its original cloud generation. Concurrent
changes, pending commitments, unavailable sources and invalid receipts retain
the existing object for a future scan. Snapshot JSON is never modified.

Finalized receipts can be verified without contacting calendar servers; agents
can download the latest receipt through the existing historical-proof endpoints.
Their proof hash may change after finalization. Public-header corroboration is
not full-node chain validation: the API conservatively retains the
`bitcoin_attestation_present_unverified` status and auditors should independently
verify with their own Bitcoin mainnet node. Routine retries are debug-only logs.

### Agent retrieval

The primary 15-tool `/mcp` catalog now obtains its stratigraphy responses
through an authenticated internal bridge to this licensed Python pipeline and
the authoritative Object Storage archive. The free `stratigraphy.list` tool
exposes only real archive bounds and live tip metadata. The four paid
stratigraphy tools return the latest complete live pipeline snapshot (including
the assumed 15 J/TH network power estimate and the $10M/current-price
Finney multiple with attribution), plus exact archived JSON and the **current**
bucket `.ots` bytes for selected UTC captures. A receipt covers its archived
JSON only, **not** a later changing live value. No legacy video/index record
is substituted when the pipeline or storage fails. Existing L402 tool scopes,
prices, quotas and caveated maximum heights remain in force, using real
observed block heights rather than synthetic date-to-block indices. Internal
requests are HMAC-authenticated, time-limited and replay-protected; they are
not an unpaid public tool.

MCP:

```json
{"name":"get_historical_proof","arguments":{"date":"2026-10-12"}}
```

REST:

```text
GET /agent-api/historical-proof?date=2026-10-12
```

The response contains:
- `snapshot_json`: the **exact saved UTF-8 text**, including its final newline.
- `ots_proof_base64`: the **exact detached .ots bytes**, base64-encoded.
- `snapshot_sha256`, `ots_sha256`, filenames and `proof_status`.
- `snapshot_download_url`, `ots_download_url` and `bundle_download_url`.

Those URLs serve byte-exact attachments:

```text
GET /agent-api/historical-proof/2026-10-12/snapshot
GET /agent-api/historical-proof/2026-10-12/ots
GET /agent-api/historical-proof/2026-10-12/download
```

The last URL downloads a ZIP containing both files. Download helpers are REST
only; they do not add further MCP tools. Retrieval is read-only and first checks
that the .ots SHA-256 commitment matches the original JSON bytes.

Invalid dates return **422**; missing archives return **404**. A saved snapshot
without its proof, corrupt files or a commitment mismatch return **409**.
Storage connectivity, authorization or upload-service failures return **503**,
not a misleading "missing date" response.

### Independent Bitcoin verification

New OpenTimestamps receipts generally contain **pending calendar attestations**,
not completed Bitcoin proofs. `proof_status` is either:

- `pending_bitcoin_confirmation`: public-calendar receipt, not yet Bitcoin-confirmed.
- `bitcoin_attestation_present_unverified`: Bitcoin attestation exists in the
  receipt, but this server has **not independently verified its chain inclusion**.

After the public calendars anchor the commitment, use an independent, working
OpenTimestamps CLI with the downloaded files and your own fully validating
Bitcoin mainnet node:

```sh
ots upgrade snapshot_2026-10-12.json.ots
ots verify snapshot_2026-10-12.json.ots
```

Keep the matching `.json` in the same directory. Do **not** parse and reserialize
the JSON before verification. Upgrade changes your local proof, not the snapshot.
The service does not automatically upgrade historical receipts; the client
obtains confirmation evidence independently from the public calendars.

Calendar acceptance or matching SHA-256 alone is not Bitcoin verification.
Successful Bitcoin verification establishes that the exact bytes existed by
the anchoring block, not that every price/hashrate observation is accurate,
that no days were omitted, or that a block timestamp proves an exact midnight.
