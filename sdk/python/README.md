# Bitcoin Stratigraphy Enterprise SDK

## L402/NIP-98 orchestration transport

The additive [`bitcoin-stratigraphy-mcp-client`](mcp-client/README.md) distribution
provides a typed transport for the official MCP Python SDK, with Schnorr-signed
NIP-98 headers, explicit L402 wallet handoff, isolated signing tests, and a
four-line LangChain agent integration. Install it from `./sdk/python/mcp-client`;
the enterprise SDK below remains unchanged and independently installable.

With a secret-managed `private_key`, an async invoice-approving `wallet_handler`
and your configured LangChain `model`, the integration is exactly four lines:

```python
from bitcoin_stratigraphy_mcp_client import L402Nip98Transport
from langchain.agents import create_agent
async with L402Nip98Transport(private_key, wallet_handler).langchain_tools() as tools:
    agent = create_agent(model, tools=tools)
```

Invoke the agent inside that context. See the
[transport guide](mcp-client/README.md) for installation, the typed wallet
contract, payment safeguards and independent tests.

## CrewAI Multi-Agent Integration

Install the optional native integration with
`pip install './sdk/python/mcp-client[crewai]'`. Supply the same secret-managed
`private_key` and async `wallet_handler` used by the LangChain adapter, plus your
configured CrewAI `llm`. Equip an agent in exactly four lines:

```python
from crewai import Agent
from bitcoin_stratigraphy_mcp_client.crewai import CrewAISwarmTools
with CrewAISwarmTools(private_key, wallet_handler) as tools:
    agent = Agent(role="Treasury auditor", goal="Audit swarm data", backstory="Enterprise risk team", tools=tools, llm=llm)
```

Share `tools` with additional agents and keep `Crew(...).kickoff()` or
`await Crew(...).kickoff_async()` inside the context. These are native CrewAI
`BaseTool` instances, not LangChain wrappers. The context owns a background-loop
MCP session; both synchronous and asynchronous calls use the existing NIP-98
signer and L402 wallet handoff without changing server policy or tools.
Wallet callbacks execute on that background loop: create loop-affine wallet
clients there rather than reusing an HTTP client from another event loop.
See the [native integration guide](mcp-client/README.md#crewai-multi-agent-integration)
for lifecycle, dependency compatibility and offline tests.

## Licensing, IP & Enterprise Terms

Created & Architected by Charles R. Strogish.

Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
This SDK is dual-licensed under AGPLv3 or a separately executed Enterprise
Commercial License. See [LICENSE.md](LICENSE.md) for the complete terms.
AGPL permits commercial use subject to its conditions. Proprietary deployments
that cannot meet applicable source-disclosure obligations require a Commercial
License from Charles R. Strogish. API fees do not grant commercial software
rights. Third-party components and previously granted licenses retain their
own terms.

Python 3.10+ evidence tooling for LangChain, CrewAI, and framework-independent
agents. Install a built wheel or the source directory:

```bash
pip install ./dist/bitcoin_stratigraphy_enterprise-0.2.0-py3-none-any.whl
# From a repository checkout:
pip install ./sdk/python
```

The distribution is buildable and installable; it has **not been published to
PyPI**. Do not assume `pip install bitcoin-stratigraphy-enterprise` is available
until an authorized registry release is made.

## One-line imports

```python
from bitcoin_stratigraphy_enterprise import SwarmFlightRecorder, Article12NotaryCallback
```

```python
from bitcoin_stratigraphy_enterprise import SwarmFlightRecorder, verify_inclusion_proof

recorder = SwarmFlightRecorder()  # No wallet or network access by default.
index = recorder.record_trace(
    {
        "agent_id": "policy-reviewer",
        "decision_summary": "Denied export pending privacy review",
        "tool_call": {"name": "export_records", "outcome": "blocked"},
    }
)
receipt = recorder.flush_root()  # Deferred locally, not Bitcoin-anchored.
bundle = recorder.export_disclosure(index)
report = verify_inclusion_proof(
    bundle["trace"],
    bundle["merkle_proof"],
    bundle["root_receipt"],
    expected_recorder_key=recorder.public_key,
)
assert report["merkle_inclusion_verified"]
assert not report["bitcoin_inclusion_verified"]
```

`expected_recorder_key` must come from independent organizational enrollment
when auditing someone else's evidence; taking it from their receipt does not
establish authority.

## LangChain and CrewAI

Install your chosen framework separately. LangChain is not a mandatory package
dependency; when available, the Article 12 wrapper subclasses its real
`BaseCallbackHandler`:

```python
from bitcoin_stratigraphy_enterprise import Article12NotaryCallback

with Article12NotaryCallback(
    agent_id="risk-review", journal_path="private-audit.jsonl"
) as callback:
    # chain.invoke(inputs, config={"callbacks": [callback]})
    run_id = callback.start_run({"request": "synthetic"})
    callback.finish_run(run_id, {"decision": "blocked"})
```

For CrewAI or any other framework, call `recorder.record_trace(...)` from your
task/step callback with a sanitized JSON object. `record_trace`, `append_trace`
and `add_trace` are generic hooks, **not** CrewAI-specific callback subclasses.
The SDK cannot recover hidden model reasoning.

## Prepaid anchoring and CLI

```python
from bitcoin_stratigraphy_enterprise import PrepaidMacroNotarizer, SwarmFlightRecorder
# Retrieve authorization from your own secret manager, never source code.
# recorder = SwarmFlightRecorder(PrepaidMacroNotarizer(authorization))
```

Only a batch root is sent to `proof.notarize`; the adapter uses prepaid
`X-L402-Batch-Size: 100`. Empty flushes do not pay again. Uncertain outcomes do
not automatically retry or purchase invoices.

```bash
stratigraphy-swarm                       # Safe synthetic 50-agent demo
stratigraphy-swarm --verify disclosure.json --recorder-key ENROLLED_PUBLIC_KEY
stratigraphy-article12 --help
stratigraphy-b2b --help
stratigraphy-audit --help
```

Explicit `stratigraphy-swarm --production` can consume a real prepaid call when
`L402_AUTHORIZATION` is present. Offline verification never contacts MCP or pays.
The Article 12 wrapper uses an available prepaid `L402_AUTHORIZATION` by default;
omit that credential for a local-only assessment.

## Evidence boundaries

Selective disclosure is a salted RFC 6962-style Merkle inclusion path, **not a
zero-knowledge proof**. It reveals the selected trace, its salt, index, tree size
and sibling commitments, not other trace plaintext. A recorder signature does
not establish corporate authority, complete telemetry or honest inputs.

Pending OTS is not Bitcoin confirmation. Confirmation requires independently
validated mainnet evidence; Bitcoin block timestamps are not exact legal clocks.
Article 12 evidence collection is not legal-compliance certification.

Swarm retention and reservations are in memory; production requires durable
evidence custody, replay reservations, key management and recovery. Sanitize
inputs, restrict exports, and arrange lawful retention/encryption. Article 12
journal locking uses POSIX `flock`; Windows deployments need an appropriate
locking implementation.

## Build and compatibility

```bash
python -m build ./sdk/python
# Or, with uv:
uv build ./sdk/python
```

The wheel includes all enterprise helpers and the prepaid MCP transport, with
no imports from repository-only `cookbooks` or `sdk` namespaces. Legacy
`cookbooks/*.py` entry points remain compatible. The canonical MCP tools,
schemas and HTTP API remain unchanged.
