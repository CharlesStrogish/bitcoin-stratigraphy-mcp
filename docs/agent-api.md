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

The height is fetched live from `https://mempool.space/api/blocks/tip/height`.
The operation has an eight-second total deadline and a bounded response size.
Unavailable or malformed upstream data returns an explicit error rather than
falling back to a fabricated height.

`current_epoch` is the **zero-based halving epoch**, calculated as
`block_height // 210000`. Genesis is epoch 0; height 840000 begins epoch 4.
This is not a 2016-block difficulty-adjustment epoch.

`scheduled_issued_supply_sats` sums integer-satoshi block subsidies from genesis
through the reported tip, inclusive. `estimated_issued_supply_btc` converts that
value to BTC. `supply_progress_percent` compares it with the fixed 21,000,000 BTC
ceiling. This is scheduled issuance, not measured circulating or spendable supply:
genesis, unclaimed rewards, lost coins and burned/unspendable coins are not
subtracted. The exact satoshi field avoids relying on floating-point BTC precision.

The license gate authorizes this deployment to start; it is not per-agent request
authentication. No existing L402 gates or public API access rules were changed.
