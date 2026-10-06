# Bitcoin Stratigraphy Enterprise SDK

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
