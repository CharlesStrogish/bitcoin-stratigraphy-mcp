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
from services.escrow_engine import EscrowEngine, EscrowStateError


class EscrowApi:
    prefix = "/api/v1/escrow"
    tags = ["Autonomous Escrow"]

    def __init__(self, engine: EscrowEngine):
        self.engine = engine

    def dispatch(self, operation, body):
        """Return (HTTP status, JSON body) to an already authorized transport."""
        try:
            if not isinstance(body, dict):
                return 400, {"error": "Request must be a JSON object"}
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
                return 200, {"status": contract["status"]}
            if operation == "settle":
                if any(
                    not isinstance(body[field], str) or not body[field].strip()
                    or len(body[field].encode("utf-8")) > 262144
                    for field in ("execution_trace", "result_payload")
                ):
                    return 422, {"error": "Execution trace and result must be nonempty bounded UTF-8 strings"}
                settled = self.engine.verify_execution_and_settle(**body)
                receipt = settled["receipt"]
                return 200, {
                    "status": "SETTLED", "preimage": settled["preimage"],
                    "merkle_root": receipt["merkle_root"],
                    "audit_path": receipt["audit_path"],
                    "article_12_receipt": receipt,
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
            data = row["leaf_preimage"]
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
                    "result_hash": data[64:].hex(),
                },
                "description": (
                    "Local RFC 6962 execution commitment supporting Article 12 logging. "
                    "Recorded height is not a Bitcoin inclusion proof; this receipt "
                    "does not certify task correctness, funding, or legal compliance."
                ),
            }
        except (ValueError, TypeError, KeyError, AttributeError):
            return 422, {"error": "Stored escrow proof is malformed"}
