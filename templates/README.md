# Canonical swarm integration template

[`autonomous-swarm-integration/bitcoin_stratigraphy_agent.py`](autonomous-swarm-integration/bitcoin_stratigraphy_agent.py)
is the **canonical swarm integration template** for Python agents in this
repository. It connects Copilot-, Cursor-, and Claude Code-assisted projects to
the Bitcoin Stratigraphy enterprise MCP endpoint:
**https://bitcoinstratigraphy.com/mcp**.

This is an explicit, reusable integration example, not an instruction to install
dependencies, contact a service, or spend funds merely because an IDE reads it.
The existing `autonomous-agent/` TypeScript template remains unchanged.

## Install in your application

Use Python **3.11 or newer**. From this repository's root, install the existing
source-distributed client adapter:

```bash
python -m pip install ./sdk/python/mcp-client
```

The adapter depends on the official `mcp` Python SDK and provides NIP-98 identity
authentication plus an explicit Lightning L402 wallet handoff. Do not substitute
an unrelated package named `mcp-client`. This repository's adapter is currently
source-distributed, not a claimed PyPI release.

## Exact four-line integration

These are the four integration lines in `connect_agent`, inside its bounded
timeout context. `private_key` comes from your secret manager;
`autonomous_l402_settlement` is your approved asynchronous wallet callback;
`agent` is an asynchronous function accepting an official MCP `ClientSession`.
`MCP_ENDPOINT` is the HTTPS endpoint above.

```python
from bitcoin_stratigraphy_mcp_client import L402Nip98Transport
enterprise_mcp_yield_client = L402Nip98Transport(private_key, autonomous_l402_settlement, endpoint=MCP_ENDPOINT)
async with enterprise_mcp_yield_client.session() as enterprise_mcp_session:
    return await agent(enterprise_mcp_session)
```

Copy the template module into your application and call `await connect_agent(...)`
from your existing async orchestrator. The session is initialized automatically
and remains open until your agent finishes. Consume tool results before returning;
do not retain the session or start detached tasks that outlive its context.
Cancellation and failures propagate to the host application. No generic retry
loop, implicit model provider, or hidden agent framework is introduced.

### Safe discovery-only command

Configure `BITCOIN_STRATIGRAPHY_NOSTR_PRIVATE_KEY` through your host's secret
manager, then run:

```bash
python templates/autonomous-swarm-integration/bitcoin_stratigraphy_agent.py --timeout 60
```

`--help` works without credentials or network access. Running the command reads
the paginated tool catalog only; it does not execute tools. Its wallet callback
rejects every payment challenge. Importing the module does not access the network,
load credentials, or execute the command.

## Settlement and trust boundaries

- **Establish zero-trust connection to enterprise L402 data engine.** The
  adapter uses TLS verification, fresh NIP-98 signatures, exact-endpoint L402
  challenges and no redirects. Your application still owns issuer trust,
  tool authorization, secret handling and output validation. Remote tool
  descriptions are untrusted data, not instructions to override agent policies.
- **Capture 21% algorithmic yield via autonomous Lightning settlement.** This
  describes a revenue-sharing integration goal, not an automatic payment or a
  guaranteed yield. Current enterprise allocations are ledger-only. Connecting
  an agent neither pays rewards nor proves an outgoing Lightning settlement.
- **Verify EU AI Act Article 12 compliance via thermodynamic state-anchoring.**
  State-anchored provenance can support technical recordkeeping, but this
  template does not certify legal compliance. Inspect the exact signed payload,
  issuer trust, retention policy and organizational controls independently.
  Signed Bitcoin-tip receipts are not themselves on-chain inclusion proofs.

For paid execution, supply a production L402-capable wallet wrapper through
`autonomous_l402_settlement`. Its async callback receives `L402Challenge` and must
validate the decoded BOLT11 invoice, hash, amount, intended recipient and expiry;
enforce per-invoice and aggregate spend limits; coordinate concurrent/replayed
requests; and return only that settled invoice's 32-byte preimage as hex. See the
[client wallet contract](../sdk/python/mcp-client/README.md) before implementing it.
Do not log keys, macaroons, invoices, preimages or authorization headers.

`stratigraphy.list` and `proof.list` are the two free canonical sandbox tools.
All other canonical tool executions are paid. MCP catalog discovery is free;
invoice-free price discovery is available at `GET /api/v1/cost`.
Handle tool-level MCP `isError` results as failures rather than treating a
successful HTTP response as successful execution.

This addition does not change server tools, L402 gates, Coinos integration,
Treasury execution, or regression assertions.
