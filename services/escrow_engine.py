"""Execution commitments using the existing SDK's unchanged RFC 6962 engine."""

from datetime import datetime, timezone
import hashlib
import json
import re
import secrets
import uuid

from bitcoin_stratigraphy_enterprise.swarm_merkle import MerkleAccumulator, leaf_hash
from services.escrow_db import EscrowStore
from services.escrow_pricing import get_dynamic_escrow_toll


def _hex32(value, name):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-fA-F]{64}", value) is None:
        raise ValueError(f"{name} must be 64 hexadecimal characters")
    return value.lower()


class EscrowStateError(ValueError):
    """Unknown contract or a disallowed lifecycle transition."""


class EscrowEngine:
    """Trusted operator service, not an unauthenticated worker redemption API.

    Durable leaf preimages are replayed through the existing accumulator under
    BEGIN IMMEDIATE. This keeps proof order stable across processes and restarts,
    and avoids an in-memory append surviving a rolled-back database settlement.
    The strata height provider must supply an independently sourced current height.
    """

    def __init__(
        self, store=None, *, strata_block_provider=None, max_leaves=10_000,
        bitcoin_price_provider=None,
    ):
        self.store = store if store is not None else EscrowStore()
        self.strata_block_provider = strata_block_provider
        self.bitcoin_price_provider = bitcoin_price_provider
        # Delegate capacity validation to the existing engine.
        MerkleAccumulator(max_leaves)
        self.max_leaves = max_leaves

    def create_l402_escrow(self, buyer_pubkey, worker_pubkey, task_hash, amount_sats):
        buyer_pubkey = _hex32(buyer_pubkey, "buyer_pubkey")
        worker_pubkey = _hex32(worker_pubkey, "worker_pubkey")
        task_hash = _hex32(task_hash, "task_hash")
        if type(amount_sats) is not int or not 0 < amount_sats <= 2**63 - 1:
            raise ValueError("amount_sats must be a positive SQLite-safe integer")
        toll_fee_sats = get_dynamic_escrow_toll(self.bitcoin_price_provider)
        if amount_sats > 2**63 - 1 - toll_fee_sats:
            raise ValueError("amount_sats must be a positive SQLite-safe integer")
        preimage = secrets.token_hex(32)
        payment_hash = hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
        escrow_id = str(uuid.uuid4())
        with self.store.transaction() as connection:
            connection.execute(
                """INSERT INTO agent_escrow_contracts
                (escrow_id, buyer_pubkey, worker_pubkey, task_hash, amount_sats,
                 toll_fee_sats, payment_hash, preimage, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'LOCKED')""",
                (escrow_id, buyer_pubkey, worker_pubkey, task_hash,
                 amount_sats, toll_fee_sats, payment_hash, preimage),
            )
        return {
            "escrow_id": escrow_id, "payment_hash": payment_hash,
            "toll_fee_sats": toll_fee_sats,
        }

    def verify_execution_and_settle(self, escrow_id, execution_trace, result_payload):
        """Commit caller-authorized execution evidence; release only after commit.

        Hashing proves a commitment, not whether the trace completed the task.
        Authentication/task validation and real Lightning custody remain upstream.
        """
        if not isinstance(execution_trace, str) or not isinstance(result_payload, str):
            raise ValueError("execution_trace and result_payload must be UTF-8 strings")
        with self.store.transaction() as connection:
            contract = connection.execute(
                "SELECT * FROM agent_escrow_contracts WHERE escrow_id = ?",
                (escrow_id,),
            ).fetchone()
            if contract is None or contract["status"] != "LOCKED":
                raise EscrowStateError("Settlement requires an existing LOCKED escrow")
            if self.strata_block_provider is None:
                raise RuntimeError("A trusted strata block height provider is required")
            height = self.strata_block_provider()
            if type(height) is not int or not 0 <= height <= 2**63 - 1:
                raise ValueError("Strata block height must be a nonnegative integer")
            task_hash = _hex32(contract["task_hash"], "stored task_hash")
            preimage = _hex32(contract["preimage"], "stored preimage")
            payment_hash = hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
            if not secrets.compare_digest(payment_hash, contract["payment_hash"]):
                raise EscrowStateError("Stored payment commitment is corrupt")
            data = (
                bytes.fromhex(task_hash)
                + hashlib.sha256(execution_trace.encode("utf-8")).digest()
                + hashlib.sha256(result_payload.encode("utf-8")).digest()
            )
            tree = MerkleAccumulator(self.max_leaves)
            for row in connection.execute(
                "SELECT leaf_index, leaf_preimage FROM escrow_execution_leaves ORDER BY leaf_index"
            ):
                if tree.append(row["leaf_preimage"]) != row["leaf_index"]:
                    raise EscrowStateError("Durable Merkle leaf order is corrupt")
            # append accepts RAW leaf data: it performs the 0x00 separation itself.
            index = tree.append(data)
            digest = leaf_hash(data).hex()
            receipt = {
                "escrow_id": escrow_id,
                "leaf_index": index,
                "audit_path": [sibling.hex() for sibling in tree.inclusion_path(index)],
                "merkle_root": tree.root.hex(),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "tree_size": tree.size,
                "execution_leaf_hash": digest,
                "settled_at_strata_block": height,
                "receipt_type": "article_12_execution_commitment",
            }
            connection.execute(
                """INSERT INTO escrow_execution_leaves
                   (leaf_index, escrow_id, leaf_preimage, receipt_json) VALUES (?, ?, ?, ?)""",
                (index, escrow_id, data, json.dumps(receipt, sort_keys=True)),
            )
            updated = connection.execute(
                """UPDATE agent_escrow_contracts
                   SET status='SETTLED', execution_leaf_hash=?, settled_at_strata_block=?
                   WHERE escrow_id=? AND status='LOCKED'""",
                (digest, height, escrow_id),
            )
            if updated.rowcount != 1:
                raise EscrowStateError("Escrow state changed during settlement")
        # Never include the preimage in the public compliance receipt or logs.
        return {"preimage": preimage, "receipt": receipt}


_engine = None


def configure_engine(engine):
    """Install an explicitly configured trusted service for module-level calls."""
    if not isinstance(engine, EscrowEngine):
        raise TypeError("Expected EscrowEngine")
    global _engine
    _engine = engine


def _configured_engine():
    if _engine is None:
        raise RuntimeError("Configure an EscrowEngine before using this service")
    return _engine


def create_l402_escrow(buyer_pubkey, worker_pubkey, task_hash, amount_sats):
    return _configured_engine().create_l402_escrow(
        buyer_pubkey, worker_pubkey, task_hash, amount_sats
    )


def verify_execution_and_settle(escrow_id, execution_trace, result_payload):
    return _configured_engine().verify_execution_and_settle(
        escrow_id, execution_trace, result_payload
    )
