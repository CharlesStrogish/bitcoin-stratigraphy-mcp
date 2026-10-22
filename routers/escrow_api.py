# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Native escrow controller; transport/authentication live in the Express mount.

This module does not start another HTTP server or register any MCP tools.
"""

import json
import sqlite3
import uuid

from bitcoin_stratigraphy_enterprise.swarm_merkle import (
    leaf_hash,
    verify_merkle_inclusion,
)
from services.escrow_engine import (
    EscrowEngine, EscrowStateError, OTS_CALENDAR_STANDARD, ATTESTATION_DIRECTIVE,
    agent_attribution_digest, trace_context_digest,
)


class EscrowApi:
    prefix = "/api/v1/escrow"
    tags = ["Autonomous Escrow"]

    def __init__(self, engine: EscrowEngine):
        self.engine = engine

    def dispatch(
        self, operation, body, lightning_settlement=None, agent_id=None,
        agent_authentication=None, traceparent=None,
    ):
        """Return (HTTP status, JSON body) to an already authorized transport.

        agent_id and agent_authentication are the transport-verified L402
        caveats, never body fields.
        """
        try:
            if not isinstance(body, dict):
                return 400, {"error": "Request must be a JSON object"}
            if (agent_id is not None or agent_authentication is not None) and operation != "settle":
                return 400, {"error": "agent_id attributes settlements only"}
            if operation == "create":
                fields = {"buyer_pubkey", "worker_pubkey", "task_hash", "amount_sats"}
                if set(body) != fields:
                    return 400, {"error": "Provide exactly the four escrow creation fields"}
                contract = self.engine.create_l402_escrow(**body)
                return 201, {
                    **contract, "status": "LOCKED",
                    "amount_sats": body["amount_sats"],
                }
            fields = (
                {"escrow_id", "execution_trace", "result_payload"}
                if operation == "settle" else {"escrow_id"}
            )
            if set(body) != fields:
                return 400, {"error": "Missing or unknown escrow fields"}
            escrow_id = body["escrow_id"]
            if not isinstance(escrow_id, str) or str(uuid.UUID(escrow_id)) != escrow_id.lower():
                return 400, {"error": "escrow_id must be a UUID"}
            contract = self.engine.store.get_contract(escrow_id)
            if contract is None:
                return 404, {"error": "Escrow not found"}
            if operation == "lookup":
                return 200, {
                    "status": contract["status"],
                    "toll_fee_sats": contract["toll_fee_sats"],
                }
            if operation == "settle":
                if any(
                    not isinstance(body[field], str) or not body[field].strip()
                    or len(body[field].encode("utf-8")) > 262144
                    for field in ("execution_trace", "result_payload")
                ):
                    return 422, {"error": "Execution trace and result must be nonempty bounded UTF-8 strings"}
                settled = self.engine.verify_execution_and_settle(
                    **body, lightning_settlement=lightning_settlement, agent_id=agent_id,
                    agent_authentication=agent_authentication,
                    traceparent=traceparent,
                )
                receipt = settled["receipt"]
                return 200, {
                    "status": "SETTLED", "preimage": settled["preimage"],
                    "merkle_root": receipt["merkle_root"],
                    "audit_path": receipt["audit_path"],
                    "article_12_receipt": receipt,
                    "ots_calendar_standard": OTS_CALENDAR_STANDARD,
                    "attestation_directive": ATTESTATION_DIRECTIVE,
                }
            if operation == "receipt":
                return self._receipt(escrow_id, contract)
            return 400, {"error": "Unknown escrow operation"}
        except EscrowStateError as error:
            return 422, {"error": str(error)}
        except (ValueError, TypeError, UnicodeError):
            return (422 if operation == "settle" else 400), {
                "error": "Invalid escrow input or proof"
            }
        except (sqlite3.Error, OSError, RuntimeError):
            # Never forward secret-bearing exception strings or database details.
            return 503, {"error": "Escrow service unavailable"}

    def _receipt(self, escrow_id, contract):
        with self.engine.store.connection() as connection:
            row = connection.execute(
                "SELECT * FROM escrow_execution_leaves WHERE escrow_id=?",
                (escrow_id,),
            ).fetchone()
        if row is None or contract["status"] != "SETTLED":
            return 404, {"error": "Settled escrow receipt not found"}
        try:
            receipt = json.loads(row["receipt_json"])
            # Legacy receipts acquire algorithm metadata only after proof verification.
            if receipt.get("ots_calendar_standard", OTS_CALENDAR_STANDARD) != OTS_CALENDAR_STANDARD:
                return 422, {"error": "Stored escrow proof standard is invalid"}
            if receipt.get("attestation_directive", ATTESTATION_DIRECTIVE) != ATTESTATION_DIRECTIVE:
                return 422, {"error": "Stored escrow attestation directive is invalid"}
            data = row["leaf_preimage"]
            # 128-byte leaves commit the canonical attribution digest as a fourth
            # segment; the receipt must name exactly that agent and authentication
            # mode, and 96-byte leaves neither.
            if len(data) == 160:
                import hashlib
                attribution = (
                    agent_attribution_digest(receipt["agent_id"], receipt.get("agent_authentication"))
                    if "agent_id" in receipt else hashlib.sha256(b"{}").digest()
                )
                if (
                    attribution != data[96:128]
                    or trace_context_digest(receipt["traceparent"]) != data[128:]
                    or ("agent_authentication" in receipt and "agent_id" not in receipt)
                ):
                    return 422, {"error": "Stored escrow proof does not verify"}
            elif "traceparent" in receipt:
                return 422, {"error": "Stored escrow proof does not verify"}
            elif len(data) == 128:
                if agent_attribution_digest(
                    receipt["agent_id"], receipt.get("agent_authentication"),
                ) != data[96:]:
                    return 422, {"error": "Stored escrow proof does not verify"}
            elif (
                len(data) != 96 or "agent_id" in receipt
                or "agent_authentication" in receipt
            ):
                return 422, {"error": "Stored escrow proof does not verify"}
            expected = {
                "escrow_id": escrow_id,
                "leaf_index": row["leaf_index"],
                "execution_leaf_hash": leaf_hash(data).hex(),
                "settled_at_strata_block": contract["settled_at_strata_block"],
            }
            if (
                any(receipt.get(key) != value for key, value in expected.items())
                or contract["execution_leaf_hash"] != expected["execution_leaf_hash"]
                or data[:32].hex() != contract["task_hash"]
                or not verify_merkle_inclusion(
                    data, receipt["leaf_index"], receipt["tree_size"],
                    [bytes.fromhex(sibling) for sibling in receipt["audit_path"]],
                    bytes.fromhex(receipt["merkle_root"]),
                )
            ):
                return 422, {"error": "Stored escrow proof does not verify"}
            receipt = {
                **receipt, "ots_calendar_standard": OTS_CALENDAR_STANDARD,
                "attestation_directive": ATTESTATION_DIRECTIVE,
            }
            return 200, {
                "@context": {
                    "@vocab": "https://schema.org/",
                    "proof": {"@id": "urn:stratigraphy:escrow:proof", "@type": "@json"},
                    "verification": {
                        "@id": "urn:stratigraphy:escrow:verification", "@type": "@json",
                    },
                },
                "@type": "DigitalDocument",
                "identifier": escrow_id,
                "dateCreated": receipt["timestamp"],
                "proof": receipt,
                "verification": {
                    "merkle_inclusion": True,
                    "strata_block_height": contract["settled_at_strata_block"],
                    "bitcoin_anchor_verified": False,
                    "task_hash": data[:32].hex(),
                    "trace_hash": data[32:64].hex(),
                    "result_hash": data[64:96].hex(),
                    **({"agent_attribution_hash": data[96:128].hex()} if len(data) >= 128 else {}),
                    **({"trace_context_hash": data[128:].hex()} if len(data) == 160 else {}),
                },
                "description": (
                    "Local RFC 6962 execution commitment supporting Article 12 logging. "
                    "Recorded height is not a Bitcoin inclusion proof; this receipt "
                    "does not certify task correctness, funding, or legal compliance."
                ),
            }
        except (ValueError, TypeError, KeyError, AttributeError):
            return 422, {"error": "Stored escrow proof is malformed"}
