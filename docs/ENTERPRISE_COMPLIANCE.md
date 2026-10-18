# Enterprise Compliance and Zero-Knowledge Governance Framework

**System:** Bitcoin Stratigraphy Data Engine  
**Review date:** September 30, 2026  
**Scope:** The 14 canonical MCP tools, separately scoped REST payment/stream surfaces, cryptographic evidence, and enterprise auditor procedures.

> This is a control framework and implementation assessment, not a certification,
> legal opinion, regulatory approval, or assertion that every enterprise obligation
> is already satisfied. “Required” below describes enterprise governance policy;
> “implemented” describes the reviewed server. This document introduces no new
> tool, circuit, caveat, storage guarantee, or server behavior.

## Contents

1. [Executive summary and regulatory matrix](#1-executive-summary-and-regulatory-matrix)
2. [Cryptographic audit trail architecture](#2-cryptographic-audit-trail-architecture)
3. [Groth16 ZK-SNARK circuit specifications](#3-groth16-zk-snark-circuit-specifications)
4. [L402 bounded economic agency](#4-l402-bounded-economic-agency)
5. [Production Python auditor example](#5-production-python-auditor-example)
6. [Auditor operational runbook](#6-auditor-operational-runbook)
7. [Governance ownership and release gates](#7-governance-ownership-and-release-gates)
8. [References and validation](#8-references-and-validation)

## 1. Executive summary and regulatory matrix

The service exposes indexed Bitcoin telemetry, Groth16 proof verification,
Bitcoin-tip receipts, and optional Nostr mesh operations through MCP. Enterprises
can use these controls to assemble checkable evidence for an agent's data access,
verification decisions, state references, and authorized spending.

The broader capability overview also includes macaroon attenuation with TTL and
request-count controls; REST settlement routing for `btc-lightning`, `l-btc`,
and `taproot-assets` where available; conditional Base USDC x402 for MCP only
when explicitly enabled; a separate paid REST SSE feed at
`GET /api/v1/stratigraphy/stream` (30-second refresh, not MCP transport); drift
proof verification alongside Groth16/Poseidon BN254 telemetry; and separate
OpenTimestamps receipt verification. `/api/v1/cost` reports current REST prices
and settlement availability. MCP paid-call credentials and REST subscription
credentials have distinct scopes and are not interchangeable.

Historical daily index heights are not live Bitcoin-tip readings or native
per-record block provenance. Nostr peers are pinned and reciprocal; broadcast
and quorum provide peer-consistency signals, not source truth. The signed
context/CID receipts described below are off-chain.

Three boundaries are fundamental:

- A valid Groth16 proof establishes a specified circuit relation for particular
  public inputs; it does not establish the truth of upstream measurements or the
  correctness of an LLM's interpretation.
- A signed Bitcoin-tip receipt authenticates an issuer's statement about observed
  chain state. It is not an on-chain commitment, Bitcoin consensus proof, or
  durable, immutable records archive.
- L402 authenticates paid access under enforced caveats. Enterprise authorization,
  spending reservations, human approval, retention, and regulatory classification
  remain responsibilities of the integrating organization.

### 1.1 Applicable obligations and control objectives

| Reference | Obligation or guidance | Enterprise control objective | Remaining organizational responsibility |
| --- | --- | --- | --- |
| EU AI Act, Regulation (EU) 2024/1689, Article 12 | High-risk AI systems must technically allow automatic recording of events over their lifetime, with logging capabilities appropriate to traceability and applicable use cases. | Preserve exact tool inputs, outputs, proofs, timestamps, schema/key versions, and verification outcomes in a durable execution journal. | Determine whether the deployed system is high-risk; implement complete lifecycle logging, retention, access controls, and incident handling. A proof cache is not that journal. |
| EU AI Act, Article 14 | High-risk systems must enable effective human oversight, including understanding limitations, avoiding automation bias, interpreting outputs, and intervening, overriding, or stopping where appropriate. | Require human approval for spending and publication policies; reject invalid evidence; support review and a trusted application-level stop mechanism. | Assign competent reviewers, document override procedures, and implement stop/approval controls outside model prompts. Article 14 is human oversight, not a second traceability provision. |
| EU AI Act, Articles 19 and 26, where applicable | Provider/deployer duties concerning logs, oversight, monitoring, and use apply according to role and classification. | Assign custody and retention responsibilities rather than assuming server-side bounded indexes satisfy them. | Counsel determines applicable obligations, minimum retention, exceptions, effective dates, and amendments. Do not apply an unqualified universal retention period. |
| FTC Act Section 5 and FTC AI enforcement/guidance | Deceptive or unfair AI representations and practices remain actionable; claims about accuracy, capability, or superiority need appropriate substantiation. | Keep proof claims tied to measured capabilities; retain evaluations and limitations; do not market “zero hallucinations,” “regulator certified,” or unsupported accuracy guarantees. | Review marketing and deployments, substantiate claims, manage consumer impact, and assess privacy/fairness risks. There is no single implemented “FTC AI Integrity” certification. |
| SEC Exchange Act Rules 17a-3/17a-4, where applicable | Covered broker-dealers must make/preserve required records; electronic preservation under Rule 17a-4(f) can use compliant WORM storage or the qualifying audit-trail alternative. | Export evidence into a governed records system with the required preservation, recoverability, and regulator access. | Classify records, select applicable retention periods, maintain required access/undertakings, and meet production obligations. A signature alone does not satisfy Rule 17a-4. |
| FINRA Rules 4511 and 3110; Regulatory Notice 24-09 | Books/records and supervision obligations apply to covered member activities, including use of Gen AI and third-party tools. | Preserve relevant records and supervise model/tool use, accuracy, data integrity, and reviewer decisions. | Maintain written supervisory procedures, designated supervisors, testing, exceptions, and examination-ready exports. Rule 4511's six-year default applies to records without another specified period, not every record. |

These are capability-to-obligation mappings, not findings that this MCP service
is itself a high-risk AI system or a regulated broker-dealer. Legal and compliance
owners must assess the enterprise's specific activity, jurisdiction, role, and
current law before deployment.

### 1.2 Direct mapping of all 14 MCP tool controls

The matrix maps each tool to evidence supporting Article 12, oversight supporting
Article 14, FTC integrity objectives, and SEC/FINRA records/supervision objectives.
The organization must archive these records; the tool alone does not do so.

| Canonical tool | EU Art. 12 traceability evidence | EU Art. 14 oversight action | FTC AI integrity application | SEC/FINRA audit or supervisory record |
| --- | --- | --- | --- | --- |
| `stratigraphy.list` | Dataset coverage, available metrics, and discovery response. | Reviewer confirms coverage and indexing limitations before approving use. | Disclose indexed history versus live data. | Retain catalog/coverage version used to select a dataset. |
| `stratigraphy.get` | Exact selected records, parameters, and response/proof evidence. | Review source suitability and invalid/missing evidence. | Substantiate answers against retained inputs, not generated claims. | Preserve source records cited by a covered workflow. |
| `stratigraphy.get_digest` | Compact digest, selected bounds, source fingerprints, and derivation context. | Reject unsupported conclusions or use outside documented coverage. | Label summary/provenance limits; do not call a digest an independent proof. | Retain digest with original records and selection criteria. |
| `stratigraphy.get_diff` | Both comparison inputs, selection parameters, and reported changes. | Investigate material changes and approve consequential actions. | Distinguish computed differences from causal explanations. | Preserve comparative evidence and reviewer disposition. |
| `stratigraphy.get_range` | Bounded range, ordering, compression metadata, and returned records. | Enforce approved scope and verify completeness/decompression. | Avoid implying synthetic index heights are native block provenance. | Preserve range inputs and exact uncompressed evidence. |
| `proof.attenuate` | Delegation decision, parent/child relationship, and selected restrictions; exclude bearer credentials from ordinary logs. | Human-approved least privilege and revocation procedures. | Describe restrictions actually enforced, not invented caveats. | Retain redacted delegation records and policy approvals. |
| `proof.verify` | Original proof, exact snapshot/public inputs, key identifier, validity result, and verification time. | Fail closed for invalid evidence; require independent checks for material decisions. | Describe the circuit statement and source/interpretation limitations. | Preserve verification evidence, trusted key version, and exception handling. |
| `proof.get_by_hash` | Identifier queried, retained payload kind, response, and custody linkage. | Reject status-only or unavailable evidence as proof of verification. | Do not describe a lookup status as fresh independent verification. | Export exact evidence into the regulated archive; document missing records. |
| `proof.list` | Bounded lifecycle summaries and query filters. | Use for triage, not as the sole audit evidence. | Disclose process-local lifecycle/index limitations. | Preserve reconciliation reports; retrieve full artifacts separately. |
| `proof.submit` | Submitted proof/signals, submission identifier, registry result, and attestation publication outcome. | Approve state-changing registration/publication before invocation. | Separate proof validity from Nostr publication success. | Record submission approvals and distinct verification/publication outcomes. |
| `proof.ground` | Signed context/dataset receipt with observed Bitcoin height/hash and issuer timestamp. | Approve anchoring context and independently inspect receipt/chain reference. | Call it an off-chain signed tip receipt, not a confirmed on-chain or ZK/PoW proof. | Archive original receipt, signer trust policy, and independent chain observations. |
| `mesh.get_status` | Peer/quorum health snapshot and observation time. | Pause distributed reliance when trust/quorum policy fails. | Do not equate peer agreement with source truth. | Retain health observations and supervisory exception decisions. |
| `mesh.broadcast` | Exact stored snapshot, signed distribution evidence, and peer outcomes. | Approve outbound sharing and enforce allowed peers/data classification. | Disclose side effects and distinguish broadcast from acceptance. | Preserve publication authorization and delivery/acceptance evidence. |
| `payment.get_info` | Price query, terms, or authenticated settlement result. | Set wallet budget and reconcile payments before executing paid work. | Disclose current prices/fees; a settlement result is not general access authorization. | Retain invoice/payment references, settlement results, and approvals without bearer secrets. |

### 1.3 Minimum enterprise evidence record

The enterprise journal must capture a correlation ID, actor/agent identity,
supervisor and approval decision, UTC start/end times, canonical tool name,
transport/schema version, exact non-secret inputs and outputs, original proof
and public inputs, trusted verification-key fingerprint, verification outcome,
source provenance, receipt identifier/signing key, relevant invoice/payment
references, and retention/legal-hold classification.

Preserve original evidence and authorized changes separately. Record modifications,
deletions, reviewer overrides, and failures with identities/times sufficient to
reconstruct originals where the applicable records rules require it. Encrypt and
restrict sensitive evidence; do not log preimages, macaroons, wallet credentials,
private keys, or Authorization headers.

## 2. Cryptographic audit trail architecture

### 2.1 Three-tier evidence flow

```text
Original indexed telemetry + selection + source provenance
    |
    +-- Tier 1: stratigraphy.get_digest
    |      compact deterministic state summary, bounds and fingerprints
    |
    +-- Tier 2: proof.verify
    |      off-chain Groth16 relation checked against exact original snapshot
    |
    +-- Tier 3: proof.ground
           signed Bitcoin-tip context/dataset receipt
           |
           +-- enterprise durable archive + independent receipt/chain checks
               required for the immutable-records governance objective
```

### 2.2 Tier 1 — deterministic state via `stratigraphy.get_digest`

Retain the exact selection, digest response, referenced original records, and
dataset/schema version. Digests provide compact summaries and source-record
fingerprints. Their provenance is not native per-record block confirmation:
historical heights use a documented deterministic 144-block/day index.

A digest's source fingerprint and the telemetry circuit's `snapshotDigest` are
not automatically the same identifier. The circuit digest is derived from the
exact canonical telemetry payload. Do not reconstruct a proof payload from a
compact summary or silently substitute a newly queried dataset.

### 2.3 Tier 2 — off-chain ZK execution evidence via `proof.verify`

For the telemetry path, the server verifies a Groth16/Poseidon BN254 proof and
checks the public statement against its exact snapshot. “ZK execution” here means
execution of the defined verification relation, not proof of arbitrary agent
reasoning, model weights, policy compliance, or every earlier tool call.

Retain the unmodified proof, five public signals, associated snapshot, circuit
version, trusted key and setup provenance, and verification result. Material
decisions require independent verification against an out-of-band trusted key,
not only a remote response containing `valid: true`.

Zero knowledge protects the private witness under the protocol's assumptions; it
does not conceal public signals, MCP requests, a publicly distributed Nostr event,
or telemetry disclosed to a verifier. Minimize sensitive context and assess
linkability before disclosure.

### 2.4 Tier 3 — immutable state anchoring objective via `proof.ground`

**Implemented:** `proof.ground` creates an off-chain signed context receipt
(`contextHash` plus `agentId`, optionally metadata) or a dataset receipt (`cid`,
optionally `nostrEventId` and context). It records an observed Bitcoin height and
block hash and signs the receipt commitment using a Nostr NIP-78 event with a
secp256k1 BIP340 **Schnorr** signature.

**Not implemented by this tool:** publication of that commitment in a Bitcoin
transaction, proof of chain inclusion/confirmation, or immutable long-term
retention. “Immutable state anchoring” is the enterprise objective, not an
existing on-chain guarantee. Referencing an existing block does not prove that
the receipt existed when that block was mined.

To satisfy a durable records objective, export all evidence to an enterprise
archive with the applicable preservation/audit-trail controls. If confirmed
Bitcoin commitment or OpenTimestamps evidence is required, obtain and verify a
separate complete commitment/attestation workflow. An OTS verification mode
does not make every grounding receipt Bitcoin-confirmed.

Receipt indexes and proof payload archives are bounded and process-local.
Eviction or restart can make lookup unavailable. The external archive is the
records system of record.

## 3. Groth16 ZK-SNARK circuit specifications

### 3.1 Curve, statement, and witness

The telemetry circuit uses Groth16 with Poseidon commitments over BN254
(also identified as `bn128` by the proof library).

| Parameter | Value or definition |
| --- | --- |
| Scalar field modulus `r` | `21888242871839275222246405745257275088548364400416034343698204186575808495617` |
| Base field modulus `q` | `21888242871839275222246405745257275088696311157297823662689037894645226208583` |
| Ordered public signals | `[blockHeight, thermodynamicHash, timestamp, valuationSat, snapshotDigest]` |
| `blockHeight` | Non-negative, 32-bit integer; for historical telemetry, an indexed height. |
| `timestamp` | Non-negative, 48-bit Unix-millisecond value. |
| `valuationSat` | Non-negative, 48-bit integer. |
| Private multiplier | Non-negative, 32-bit integer circuit witness. |
| Snapshot commitment | Canonical payload JSON, SHA-256 over UTF-8 bytes, reduced modulo `r`; the verifier checks exact snapshot/statement binding. |
| Poseidon relation | `thermodynamicHash = Poseidon(blockHeight, timestamp, valuationSat, snapshotDigest, multiplier)` |
| Valuation relation | `valuationSat = multiplier * 100` |
| Snapshot witness relation | The private snapshot witness digest equals the public snapshot digest. |

These constraints do not prove economic valuation accuracy or Bitcoin proof-of-work
validity. The drift circuit is separate and has eight public signals; it must not
be interpreted using this five-signal telemetry specification.

### 3.2 Bilinear pairing verification

Let `G1` and `G2` be the appropriate prime-order groups, `GT` the target group,
and `e: G1 × G2 → GT` the bilinear pairing. For proof points
`A ∈ G1`, `B ∈ G2`, `C ∈ G1` and public input vector `x`, define:

```text
x_0 = 1
vk_x = IC_0 + sum_{i=1}^{n}(x_i * IC_i)

e(A, B) = e(alpha_1, beta_2)
          * e(vk_x, gamma_2)
          * e(C, delta_2)
```

Equivalently, a pairing-product verifier checks:

```text
e(-A, B) * e(alpha_1, beta_2) * e(vk_x, gamma_2) * e(C, delta_2) = 1_GT
```

The requested illustrative expression
`e(A, B) = e(alpha, beta) * e(sum(x_i * gamma_i), delta) * e(C, delta)`
is **not the general Groth16 verification equation**: it omits the explicit
constant term and conflates the verification key's `gamma_2` and `delta_2`.
If `gamma_i` denotes `IC_i`, pair the input commitment with `gamma_2`, not
`delta_2`. Use the standard equation above and the actual trusted verification key.

Production verification additionally requires correct encoding, coordinate
bounds, on-curve/subgroup checks, the expected circuit/key, exact signal order,
and snapshot/semantic binding. JSON validity alone proves none of these.

### 3.3 Strict `Groth16ComplianceCircuitInput` JSON Schema

This is a **document-defined audit interchange format**, not a new server input
schema. It deliberately requires canonical decimal strings and affine
snarkjs-style coordinates. The Python adapter below translates it to the existing
telemetry `proof.verify` arguments. Draft 2020-12 is required.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Groth16ComplianceCircuitInput",
  "type": "object",
  "additionalProperties": false,
  "required": ["public_inputs", "pi_a", "pi_b", "pi_c"],
  "properties": {
    "public_inputs": {
      "type": "array",
      "description": "Telemetry circuit order: blockHeight, thermodynamicHash, timestamp, valuationSat, snapshotDigest.",
      "minItems": 5,
      "maxItems": 5,
      "prefixItems": [
        { "$ref": "#/$defs/decimalField" },
        { "$ref": "#/$defs/decimalField" },
        { "$ref": "#/$defs/decimalField" },
        { "$ref": "#/$defs/decimalField" },
        { "$ref": "#/$defs/decimalField" }
      ],
      "items": false
    },
    "pi_a": { "$ref": "#/$defs/g1Affine" },
    "pi_b": { "$ref": "#/$defs/g2Affine" },
    "pi_c": { "$ref": "#/$defs/g1Affine" }
  },
  "$defs": {
    "decimalField": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]{0,76})$",
      "maxLength": 77,
      "description": "Canonical unsigned decimal string. Semantic validation must additionally enforce the applicable modulus."
    },
    "fieldPair": {
      "type": "array",
      "minItems": 2,
      "maxItems": 2,
      "prefixItems": [
        { "$ref": "#/$defs/decimalField" },
        { "$ref": "#/$defs/decimalField" }
      ],
      "items": false
    },
    "g1Affine": {
      "type": "array",
      "minItems": 3,
      "maxItems": 3,
      "prefixItems": [
        { "$ref": "#/$defs/decimalField" },
        { "$ref": "#/$defs/decimalField" },
        { "type": "string", "const": "1" }
      ],
      "items": false
    },
    "g2Affine": {
      "type": "array",
      "minItems": 3,
      "maxItems": 3,
      "prefixItems": [
        { "$ref": "#/$defs/fieldPair" },
        { "$ref": "#/$defs/fieldPair" },
        {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "prefixItems": [
            { "type": "string", "const": "1" },
            { "type": "string", "const": "0" }
          ],
          "items": false
        }
      ],
      "items": false
    }
  }
}
```

Supplemental semantic checks are mandatory: all signals must be `< r`; all
coordinates must be `< q`; height/timestamp/valuation must satisfy the bit bounds
above. Standard JSON Schema cannot compare arbitrarily large integers encoded
as strings to the modulus. A shape-valid coordinate array is not a valid proof.

The audit schema omits key identifiers and telemetry intentionally: these are
separate mandatory evidence attachments, not additional properties of this
four-field circuit input.

## 4. L402 bounded economic agency

### 4.1 Authentication mechanics

1. Discover the actual schemas with `tools/list` and query `payment.get_info`.
2. A paid `tools/call` without usable authorization receives HTTP 402 before
   protected execution. Its challenge contains an exact invoice and an unpaid,
   invoice-bound, tool-scoped macaroon.
3. Trusted wallet orchestration checks header/body agreement, BOLT11 network,
   amount, payment hash, expiry, intended operation, and approved fee-inclusive
   budget. Reserve the budget atomically before authorizing payment.
4. Pay that exact invoice using the caller's separately authorized wallet.
5. Verify that the genuine 32-byte preimage satisfies
   `SHA256(raw_preimage_bytes) == challenge_payment_hash`.
6. Retry the intended call with the credential below. Paid MCP credentials are
   scoped to the operation and normally have a single-use request budget.
7. Reconcile ambiguous timeouts or a second 402 instead of blindly paying again.
   A transaction ID, CoinOS internal-payment UUID, or bare hash is not a preimage.

```http
WWW-Authenticate: L402 macaroon="<invoice-bound-macaroon>", invoice="<BOLT11-invoice>"
Authorization: L402 <macaroon>:<preimage>
```

The macaroon is issued at challenge time, not in a new exchange after payment.
Stock MCP SDK clients do not automatically pay invoices. Query/discovery modes
do not authorize spending or grant access to other tools.

### 4.2 Requested governance caveats versus enforced server caveats

| Requested policy name | Implemented name or mechanism | Enforcement status and enterprise requirement |
| --- | --- | --- |
| `time_valid` | Issuance `valid_until`; attenuation `time < YYYY-MM-DDTHH:MM:SS.sssZ` (from `expiresAt` or `ttlSeconds`). Legacy `time_before` caveats remain verified. | Expiry is enforced on every redemption with millisecond precision: at or after a delegated deadline the request is refused with HTTP 401 before payment verification. `time_valid` is not a supported attenuation key. Timestamp bounds are exclusive; a legacy date-only `time_before` includes that UTC date. |
| `max_calls` | `max_requests`. | Request limits are enforced; descendants consume inherited metered scopes atomically. `max_calls` is not a supported key. Paid MCP issuance normally permits one call. |
| `allowed_tools` | `rpc = <tool>[,<tool>]` (from `tools`), together with exact `allowed_path` scope. Legacy `allowed_tools` caveats remain verified. | Tool restrictions are enforced at redemption: an `rpc` caveat must name the executing tool exactly, otherwise the request is refused with HTTP 403. Every inherited `rpc` or `allowed_tools` caveat must authorize the operation, routes that execute no MCP tool refuse tool-scoped credentials, and attenuation cannot broaden the parent. |
| `max_sats_per_invocation` | No equivalent server attenuation caveat. Invoice/payment amount binding is separate. | **Not server-enforced under this name.** The enterprise wallet must enforce the fee-inclusive per-call cap, atomic total reservations, deduplication, and reconciliation. Do not claim that `amount_msats` implements a spend ceiling. |

Other supported attenuation restrictions include `allowed_path` and `max_target`.
The latter restricts supported targets, not monetary spending; deny operations
that cannot honor an inherited restriction. Issued credentials bind payment hash,
validity, tier, and applicable amount/provider/asset/agent identity fields.
Unknown or malformed caveats fail verification; do not send the requested policy
aliases as if they were implemented server caveats.

Enterprise policy must approve canonical tools, limit wallet spend and fees,
segregate operator and caller wallets, manage exact-token revocation, and stop
paid work when shared enforcement state is unavailable. Never give an agent the
service operator's incoming-wallet credentials.

### 4.3 Pricing and evidence

The reviewed price examples are 250 sats for most paid tools and 10 sats for
`proof.list`; `stratigraphy.list`, `mesh.get_status`, and price queries are free.
`proof.attenuate` has no invoice fee but requires a valid parent credential.
Requery live prices; do not hard-code these examples into a budget guarantee.
Millisatoshi accounting does not mean this service has sub-satoshi tool prices.

Store redacted invoice/payment references and budget decisions in the audit
journal. Store bearer credentials only in a restricted, short-lived secret
channel; do not place them in model prompts or the evidence export.

## 5. Production Python auditor example

### 5.1 Preconditions and execution

This executable CLI uses the **official `mcp` Python SDK** to verify a genuine
telemetry proof and retrieve a previously issued grounding receipt. It does not
generate fake proofs, create a new receipt, pay automatically, or reuse one
credential across two paid operations.

Prerequisites:

- Python 3.11 or newer. The example targets the official SDK `mcp==1.26.0`.
- Save the JSON Schema above as `groth16-compliance.schema.json` in the auditor's
  own working directory and the Python block below as `audit_agent.py`.
- `evidence.json` must contain `circuit_input` conforming to the audit schema,
  `verification_key_id` from the trusted circuit deployment, and `data` containing
  the original, unmodified telemetry snapshot. Use a real proof export, not toy
  coordinate examples.
- Acquire two fresh credentials through approved wallet orchestration: one for
  the intended `proof.verify` call and one for the intended `proof.get_by_hash`
  call. A restricted `credentials.json` maps each canonical tool name to its
  complete `L402 <macaroon>:<preimage>` value. It must have mode `0600` or stricter.
  Do not commit it or print it.
- Obtain the receipt lookup identifier and issuer's 32-byte x-only public key
  from an authenticated, independent source. Do not trust a key merely because
  it appears in the retrieved receipt.

```sh
python -m pip install "mcp==1.26.0" "jsonschema>=4.23,<5" "coincurve>=21,<22"
python audit_agent.py \
  --endpoint https://bitcoinstratigraphy.com/mcp \
  --schema groth16-compliance.schema.json \
  --evidence evidence.json \
  --credentials credentials.json \
  --receipt-id "$RECEIPT_ID" \
  --issuer "$TRUSTED_ISSUER_PUBLIC_KEY" \
  --output audit-evidence.json
```

The two shell variables are a non-secret lookup identifier and a public key;
they are not wallet credentials. Run this in the auditor's environment. The
example reads local attachments and never asks the service to reveal secrets.

### 5.2 Executable auditor

```python
import argparse
import asyncio
import base64
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from urllib.parse import urlparse

import httpx
from coincurve import PublicKeyXOnly
from jsonschema import Draft202012Validator
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

R = 21888242871839275222246405745257275088548364400416034343698204186575808495617
Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583


def load_json(path, secret=False):
    file = Path(path)
    if secret and stat.S_IMODE(file.stat().st_mode) & 0o077:
        raise ValueError("Credential file permissions are too broad")
    if file.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Input attachment exceeds the example's size limit")
    return json.loads(file.read_text(encoding="utf-8"))


def make_verify_arguments(evidence, schema):
    Draft202012Validator.check_schema(schema)
    ci = evidence["circuit_input"]
    Draft202012Validator(schema).validate(ci)
    values = [int(value) for value in ci["public_inputs"]]
    coordinates = (
        ci["pi_a"] + ci["pi_c"] + [value for pair in ci["pi_b"] for value in pair]
    )
    if any(value >= R for value in values):
        raise ValueError("Public signal outside scalar field")
    if any(int(value) >= Q for value in coordinates):
        raise ValueError("Coordinate outside base field")
    h, thermodynamic_hash, timestamp, valuation, digest = values
    if h >= 2**32 or timestamp >= 2**48 or valuation >= 2**48:
        raise ValueError("Public integer outside circuit range")
    proof = {key: ci[key] for key in ("pi_a", "pi_b", "pi_c")}
    proof.update(protocol="groth16", curve="bn128")
    encoded = (
        base64.urlsafe_b64encode(
            json.dumps(proof, separators=(",", ":")).encode("utf-8")
        )
        .decode("ascii")
        .rstrip("=")
    )
    key_id = evidence["verification_key_id"]
    if not isinstance(key_id, str) or not key_id.startswith("sha256:"):
        raise ValueError("Invalid verification key identifier")
    return {
        "proof": encoded,
        "publicInputs": {
            "blockHeight": h,
            "thermodynamicHash": str(thermodynamic_hash),
            "timestamp": timestamp,
            "valuationSat": valuation,
            "snapshotDigest": str(digest),
        },
        "verificationKeyId": key_id,
        "data": evidence["data"],
    }


async def call_once(endpoint, name, arguments, authorization):
    if not isinstance(authorization, str) or not re.fullmatch(
        r"L402 [A-Za-z0-9_-]+:[0-9a-fA-F]{64}", authorization
    ):
        raise ValueError("Invalid L402 credential encoding")
    async with httpx.AsyncClient(
        headers={"Authorization": authorization},
        timeout=httpx.Timeout(60.0, read=120.0),
        follow_redirects=False,
    ) as http_client:
        async with streamable_http_client(endpoint, http_client=http_client) as (
            read,
            write,
            _,
        ):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(name, arguments=arguments)
                if result.isError:
                    raise RuntimeError("MCP tool reported an error")
                value = result.structuredContent
                if value is None:
                    texts = [
                        item.text for item in result.content if item.type == "text"
                    ]
                    if len(texts) != 1:
                        raise RuntimeError("Unexpected MCP response encoding")
                    value = json.loads(texts[0])
                if not isinstance(value, dict):
                    raise RuntimeError("Expected an object tool result")
                return value


def verify_receipt_event(record, trusted_issuer):
    if record.get("kind") not in ("context-receipt", "dataset-receipt"):
        raise ValueError("Lookup did not return a complete grounding receipt")
    wrapper = record["proofPayload"]
    signed = wrapper
    if record["kind"] == "dataset-receipt":
        signed = json.loads(wrapper["attestation"]["proofPayload"])
    signature = signed["signature"]
    event = signature["event"]
    if signature["protocol"] != "nostr" or signature["nip"] != 78:
        raise ValueError("Unexpected attestation protocol")
    if event["pubkey"] != trusted_issuer or event["kind"] != 30078:
        raise ValueError("Unexpected receipt issuer or event kind")
    if type(event["created_at"]) is not int:
        raise ValueError("Invalid Nostr event timestamp")
    canonical_event = json.dumps(
        [
            0,
            event["pubkey"],
            event["created_at"],
            event["kind"],
            event["tags"],
            event["content"],
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    event_id = hashlib.sha256(canonical_event).digest()
    if event_id.hex() != event["id"]:
        raise ValueError("Nostr event identifier does not match")
    if not PublicKeyXOnly(bytes.fromhex(trusted_issuer)).verify(
        bytes.fromhex(event["sig"]), event_id
    ):
        raise ValueError("Invalid BIP340 Schnorr signature")
    return signed


async def audit(args):
    parsed = urlparse(args.endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Use an approved HTTPS MCP endpoint without URL credentials")
    if not re.fullmatch(r"[0-9a-f]{64}", args.issuer):
        raise ValueError("Issuer must be a lowercase 32-byte x-only public key")
    evidence = load_json(args.evidence)
    verify_arguments = make_verify_arguments(evidence, load_json(args.schema))
    credentials = load_json(args.credentials, secret=True)
    if credentials["proof.verify"] == credentials["proof.get_by_hash"]:
        raise ValueError("Separate paid operations require distinct credentials")
    verification = await call_once(
        args.endpoint, "proof.verify", verify_arguments, credentials["proof.verify"]
    )
    if verification.get("valid") is not True:
        raise ValueError("Groth16 proof did not verify for the supplied snapshot")
    record = await call_once(
        args.endpoint,
        "proof.get_by_hash",
        {"hash": args.receipt_id},
        credentials["proof.get_by_hash"],
    )
    signed = verify_receipt_event(record, args.issuer)
    report = {
        "remote_proof_verified": True,
        "verification": verification,
        "verify_arguments": verify_arguments,
        "receipt_lookup": record,
        "receipt_signed_payload": signed,
        "trusted_issuer": args.issuer,
        "receipt_event_signature_verified": True,
        "local_groth16_verification_performed": False,
        "receipt_payload_merkle_binding_checked": False,
        "proof_to_receipt_binding_checked": False,
        "independent_bitcoin_chain_check_performed": False,
    }
    # Do not overwrite earlier evidence. The output contains no L402 credentials.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())
    print("Evidence saved; complete the remaining runbook checks before sign-off.")


def main():
    parser = argparse.ArgumentParser(
        description="Audit a proof and existing state receipt"
    )
    for name in (
        "endpoint",
        "schema",
        "evidence",
        "credentials",
        "receipt-id",
        "issuer",
        "output",
    ):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        asyncio.run(audit(args))
    except Exception:
        # SDK/transport exceptions may contain sensitive request information.
        raise SystemExit(
            "Audit failed. Do not repay blindly; reconcile payment and inspect "
            "the original evidence through a restricted diagnostic channel."
        ) from None


if __name__ == "__main__":
    main()
```

This example verifies the proof through the remote MCP verifier and independently
checks the receipt's Nostr event ID, Schnorr signature, and pinned issuer. It does
**not** yet check the signed commitment's binding to the receipt payload, verify
the Groth16 pairing locally, link the receipt to this exact proof, or validate
the Bitcoin chain reference. The report explicitly marks those checks incomplete;
the following runbook is required before an auditor signs off.

The L402 credential holder should bind each credential to the intended request
in its own orchestration ledger. Tool-path authorization is not itself a guarantee
that every arbitrary JSON argument was committed by the macaroon.

## 6. Auditor operational runbook

### 6.1 Preparation, acquisition, and proof verification

- [ ] **Define scope and legal applicability.** Record the regulated workflow,
  auditor identity, dataset period, risk classification, records category, and
  applicable retention/legal hold. Decide whether independent chain inclusion
  is required; a tip receipt does not supply it.
- [ ] **Establish trust out of band.** Pin the expected issuer public key,
  telemetry circuit/verification-key hash, schema version, and approved Bitcoin
  node/provider. Obtain key rotation/revocation history. Do not accept a key
  simply because the untrusted artifact supplies it.
- [ ] **Snapshot discovery and pricing.** Archive `tools/list` and
  `payment.get_info`, record the selected tool schemas and prices, and authorize
  a bounded wallet budget. Prevent prompts from authorizing their own spending.
- [ ] **Acquire original evidence.** Preserve the original snapshot, proof,
  public inputs, digest, agent execution/approval records, and earlier grounding
  receipt identifier. Retrieve, do not manufacture missing evidence.
- [ ] **Query `proof.get_by_hash`.** Supply exactly one known `hash` or `jobId`.
  For context receipts use the context hash; for dataset receipts use the receipt
  hash or supported CID lookup. Use a separately authorized L402 credential.
  Record the query identifier, response kind, acquisition time, and custody.
- [ ] **Reject incomplete lookup evidence.** `context-receipt` and
  `dataset-receipt` include retained payloads. `zk-proof` can include proof evidence;
  inspect its actual shape. `zk-proof-status` is a lifecycle summary, not a proof
  or receipt. Missing/evicted records require original external evidence, not
  reconstruction from a status flag.
- [ ] **Verify the exact proof statement.** Check the five signals, key identifier,
  coordinate/range constraints, canonical snapshot digest and semantic bindings.
  Call `proof.verify` with the unmodified original data; reject `valid != true`.
  Independently run a trusted Groth16 verifier for material findings. Treat
  different circuit paths, including drift and OTS, as different evidence types.

### 6.2 Signature verification: Schnorr, not ECDSA

- [ ] **Identify the signature algorithm before verification.** Current grounding
  receipts use secp256k1 BIP340 Schnorr/Nostr NIP-78. An ECDSA verifier cannot
  verify these signatures. Mark a requirement for an ECDSA-signed grounding
  receipt as **unsupported**, not passed. An unrelated ECDSA-signed enterprise
  envelope would require its own issuer, encoding, exact message and trust policy;
  it would not replace verification of the original receipt.
- [ ] **Unwrap the original signed receipt.** For `context-receipt`, use
  `proofPayload`. For `dataset-receipt`, parse the wrapper's
  `attestation.proofPayload` JSON string. Retain both wrapper and signed receipt.
- [ ] **Check the Nostr event.** Recompute its NIP-01 event ID as
  `SHA256(UTF8(JSON([0, pubkey, created_at, kind, tags, content])))`; verify its
  64-byte BIP340 signature with the pinned x-only public key. Require kind `30078`,
  protocol `nostr`, and NIP `78`. The Python example performs this subset.
- [ ] **Recompute the receipt's payload commitment.** Use the server's exact
  `canonicalMeshJson` serialization semantics: recursively sorted object keys,
  compact JSON, original array order, and JavaScript-compatible string/number
  serialization. A generic reserialization that changes number formatting or
  Unicode ordering is not a valid substitute. SHA-256 the canonical UTF-8 bytes
  for `payloadSha256`; split into 1024-byte chunks and hash each chunk.
- [ ] **Recompute the Merkle root.** Sort leaf hash strings lexicographically.
  Hash each concatenated left/right **ASCII hexadecimal string pair**, not
  decoded binary digests. Duplicate an odd final node at each level; the empty
  leaf-list convention is SHA-256 of empty bytes. Compare all chunk hashes,
  their order in the commitment, root, chunk size, and algorithm.
- [ ] **Check exact signed content and tags.** Event content is the compact,
  insertion-ordered JSON commitment with keys
  `schema, algorithm, payloadSha256, blockSizeBytes, blockHashes, merkleRoot, timestamp`.
  Recompute SHA-256 over that content and compare `signature.payload_sha256`.
  Require ordered tags `[["d","bitcoin-stratigraphy:"+digest],
  ["t","bitcoin-stratigraphy"],["t","telemetry"],["x",digest]]`.
  Require the expected attestation schema, SHA-256 algorithm, and 1024-byte size.
- [ ] **Check outward aliases against the authenticated payload.** For context
  receipts, compare schema, context hash, agent ID, height/hash, Merkle root,
  timestamp, and `nostrSignature` with the signed fields. The event's
  `created_at` must equal `floor(timestamp_ms / 1000)`. For dataset receipts,
  compare CID, optional Nostr event ID, receipt hash, tip height/hash, and ISO
  timestamp with the original signed context receipt and metadata.
- [ ] **Recompute the dataset receipt identifier where applicable.** It is
  `SHA256(UTF8(JSON([cid, blockHash, blockTip, nostrEventId_or_empty, timestamp_ISO])))`.
  Check equality with the signed context hash and outward `receiptHash`.
- [ ] **Bind evidence to this agent action.** Verify that the authenticated
  context/dataset commitment corresponds to the approved action and exact proof
  evidence. A metadata field naming a proof does not mean the notary verified
  that proof. If the relationship was not committed, report it as unestablished.

### 6.3 Bitcoin height, timestamps, custody, and disposition

- [ ] **Validate the Bitcoin reference independently.** Using an approved
  validating Bitcoin Core node, obtain `getblockhash(height)` and
  `getblockheader(hash)`; compare height/hash, chain membership and header time.
  Record node/network, observation time, confirmations, and reorg status.
  An independently chosen explorer is weaker evidence and must be labeled.
- [ ] **Separate three different times.** The signed receipt timestamp is an
  issuer clock observation in milliseconds; Nostr `created_at` is seconds; the
  Bitcoin header timestamp is miner-supplied and is not a precise wall-clock
  receipt time. A height alone is not a timestamp. Neither the receipt nor a
  referenced old block proves receipt existence at that block's mining time.
- [ ] **Avoid height/provenance substitution.** Historical dataset index heights
  are not native block provenance. Compare the grounding receipt's observed
  real height/hash separately from the historical index and circuit statement.
- [ ] **Verify any claimed immutable anchoring separately.** Require a real
  Bitcoin inclusion/confirmation proof or complete upgraded OTS receipt if that
  is the audit claim. Do not accept a CID, block reference, Merkle root, signature,
  or `attestation.verified: true` as a substitute.
- [ ] **Export to the enterprise records archive.** Preserve exact artifacts,
  independent verification reports, original records, change history, schema/key
  versions, and approvals under applicable retention and legal holds. Test
  regulator-accessible export and recovery of originals where required.
- [ ] **Reconcile economic activity.** Match invoices and verified payment
  references to authorized calls, fee-inclusive reservations, and outcomes.
  Document partial failures without exposing bearer secrets.
- [ ] **Issue a qualified disposition.** Report proof validity, source trust,
  signature/payload binding, action linkage, chain-reference validity, durability,
  and supervisory approval as separate findings. Escalate invalid signatures,
  missing original evidence, mismatched aliases, untrusted keys, budget failures,
  or unsupported ECDSA/on-chain claims. A valid cryptographic finding is not a
  blanket regulatory-compliance finding.

## 7. Governance ownership and release gates

| Owner | Required duties and approval evidence |
| --- | --- |
| Legal/compliance | Classify applicability, approve claims, retention schedules and jurisdictional requirements, and review material changes. |
| Model/tool risk owner | Evaluate source integrity, model behavior, tool selection and known limitations; maintain documented tests and exception criteria. |
| Cryptography/security | Pin issuer/circuit keys, review circuit/setup provenance, test proof/receipt binding, supervise key rotation/revocation, and protect secrets. |
| Wallet operator | Enforce spending/fee limits, atomic reservations and deduplication; reconcile ambiguous settlements and maintain segregated wallets. |
| Records custodian | Preserve original evidence, change/deletion history and legal holds; demonstrate restoration and examiner-ready export. |
| Human supervisor | Approve side effects, review invalid/missing evidence and material decisions, document overrides, and exercise the stop procedure. |
| Independent auditor | Reperform checks, document trust assumptions and gaps, and keep cryptographic conclusions separate from legal conclusions. |

Before production use in a covered enterprise workflow, require evidence that:

1. All 14 tool permissions are explicitly reviewed; side effects require approval.
2. Invalid proof, mismatched snapshot, tampered receipt, wrong issuer/key, expired
   credential, prohibited tool, exhausted request budget, and uncertain payment
   cases fail closed.
3. The wallet independently enforces the missing per-invocation monetary ceiling.
4. The archive survives application restarts and preserves complete originals and
   required change history for the applicable retention period.
5. Reviewers can halt the workflow and record an override without giving the
   model control of the approval mechanism.
6. Public statements accurately disclose Schnorr signatures, off-chain receipts,
   circuit limits, indexing limits, and absence of an automatic compliance guarantee.

These are organizational acceptance gates. This document does not assert that
the deployment has already passed them or change server enforcement.

## 8. References and validation

### 8.1 Official regulatory and protocol references

- [EU AI Act: Regulation (EU) 2024/1689, official text](https://eur-lex.europa.eu/eli/reg/2024/1689/oj/eng).
  Read Articles 12, 14, 19 and 26; check the current consolidated text and
  application schedule before legal sign-off.
- [FTC Operation AI Comply: deceptive AI claims and schemes](https://www.ftc.gov/news-events/news/press-releases/2024/09/ftc-announces-crackdown-deceptive-ai-claims-schemes).
  This is an enforcement/guidance reference, not an AI integrity certificate.
- [SEC electronic recordkeeping amendments overview](https://www.sec.gov/investment/amendments-electronic-recordkeeping-requirements-broker-dealers)
  and [adopting release 34-96034](https://www.sec.gov/files/rules/final/2022/34-96034.pdf).
- [FINRA Rule 4511](https://www.finra.org/rules-guidance/rulebooks/finra-rules/4511),
  [Rule 3110](https://www.finra.org/rules-guidance/rulebooks/finra-rules/3110), and
  [Regulatory Notice 24-09](https://www.finra.org/rules-guidance/notices/24-09).
- [Official MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
  and [version 1.26.0 Streamable HTTP client implementation](https://github.com/modelcontextprotocol/python-sdk/blob/v1.26.0/src/mcp/client/streamable_http.py).
- [Groth16 paper](https://eprint.iacr.org/2016/260),
  [Nostr NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
  [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md), and
  [BIP340](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki).

### 8.2 Implementation evidence reviewed

- [MCP catalog, input validation, execution, lookup, and paid-call gating](../artifacts/api-server/src/routes/mcp.ts).
- [Macaroon issuance, attenuation, and verification](../artifacts/api-server/src/lib/subscription-pass.ts).
- [Telemetry proof validation and bounded archive](../artifacts/api-server/src/services/zkProofService.ts)
  and [telemetry circuit](../artifacts/api-server/src/services/zk/telemetry.circom).
- [Context receipts](../artifacts/api-server/src/services/epistemicGrounding.ts),
  [dataset receipt wrappers](../artifacts/api-server/src/services/epistemicDatasetReceipt.ts),
  [cryptographic attestation verification](../artifacts/api-server/src/services/attestation.ts),
  and [canonicalization/Merkle conventions](../artifacts/api-server/src/services/meshGossipService.ts).
- [Tool catalog and prices](../CONNECT.md) and
  [client payment integration guidance](L402_AGENT_PAYMENTS.md).

### 8.3 Validation scope

Syntax validation for this document covers JSON parsing, Draft 2020-12 schema
compilation and positive/negative shape cases, Python compilation, Markdown
fences/headings/tables, and relative links. Syntax validation is not a circuit
security audit, legal determination, or live payment test.

The Python example requires genuine evidence, independently trusted keys, valid
per-tool paid credentials, and installed auditor-side dependencies. Production
acceptance additionally requires the complete runbook, independent cryptographic
checks, and enterprise retention/supervision testing. No live payment or receipt
creation is authorized by publication of this documentation.