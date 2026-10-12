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
- `/agent-api/mcp`: MCP Streamable HTTP; exactly one tool, `get_supply_metrics`.
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
