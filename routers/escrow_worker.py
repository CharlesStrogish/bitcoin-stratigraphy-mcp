# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Bounded, secret-free-env JSON bridge for the existing Express server."""

import json
from pathlib import Path
import sys
import tempfile

# Resolve imports from the staged distribution, not the caller's working directory.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from routers.escrow_api import EscrowApi  # noqa: E402
from services.escrow_db import EscrowStore  # noqa: E402
from services.escrow_engine import EscrowEngine  # noqa: E402


def main():
    try:
        raw = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError("Worker request exceeds limit")
        request = json.loads(raw)
        height = request.get("strata_height")
        # SQLite is now only an isolated execution workspace. PostgreSQL owns
        # the snapshot and holds a cross-replica lock until the next commit.
        with tempfile.TemporaryDirectory(prefix="escrow-work-") as directory:
            store = EscrowStore(Path(directory) / "escrow.sqlite3")
            if request.get("state") is not None:
                restore_state(store, request["state"])
            elif Path(request["database_path"]).exists():
                # One-time adoption, never overwrite a committed durable state.
                legacy = EscrowStore(request["database_path"])
                restore_state(store, export_state(legacy))
            engine = EscrowEngine(
                store,
                strata_block_provider=(lambda: height) if height is not None else None,
                bitcoin_price_provider=(
                    (lambda: request["btc_usd_price"])
                    if "btc_usd_price" in request else None
                ),
            )
            if request["operation"] == "stats":
                status, body = 200, verified_totals(store, request["genesis_id"])
            else:
                status, body = EscrowApi(engine).dispatch(
                    request["operation"], request["body"], request.get("lightning_settlement"),
                )
            print(json.dumps({"status": status, "body": body, "state": export_state(store)}))
    except Exception:
        # No traceback or submitted fields: these may contain private evidence.
        print(json.dumps({"status": 503, "body": {"error": "Escrow worker unavailable"}}))


def export_state(store):
    with store.connection() as connection:
        contracts = [dict(row) for row in connection.execute(
            "SELECT * FROM agent_escrow_contracts ORDER BY escrow_id"
        )]
        leaves = [dict(row) for row in connection.execute(
            "SELECT * FROM escrow_execution_leaves ORDER BY leaf_index"
        )]
    for row in leaves:
        row["leaf_preimage"] = row["leaf_preimage"].hex()
    return {"version": 1, "contracts": contracts, "leaves": leaves}


def restore_state(store, state):
    if state["version"] != 1:
        raise ValueError("Unknown escrow snapshot version")
    # Column names come exclusively from SQLite's own schema, not JSON input.
    with store.transaction() as connection:
        for table, rows in (
            ("agent_escrow_contracts", state["contracts"]),
            ("escrow_execution_leaves", state["leaves"]),
        ):
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            for original in rows:
                row = dict(original)
                if table == "escrow_execution_leaves":
                    row["leaf_preimage"] = bytes.fromhex(row["leaf_preimage"])
                connection.execute(
                    f"INSERT INTO {table} ({','.join(columns)}) "
                    f"VALUES ({','.join('?' for _ in columns)})",
                    [row[column] for column in columns],
                )
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("Invalid escrow snapshot")


def verified_totals(store, genesis_id):
    total, count = 24, 1
    with store.connection() as connection:
        rows = connection.execute(
            """SELECT c.escrow_id, c.toll_fee_sats, l.receipt_json
            FROM agent_escrow_contracts c JOIN escrow_execution_leaves l USING(escrow_id)
            WHERE c.status='SETTLED'"""
        )
        for row in rows:
            if row["escrow_id"] == genesis_id:
                continue  # Historical baseline is counted exactly once.
            payment = json.loads(row["receipt_json"]).get("lightning_settlement")
            if payment is not None:
                status, _ = EscrowApi(EscrowEngine(store)).dispatch(
                    "receipt", {"escrow_id": row["escrow_id"]}
                )
                if (
                    status != 200
                    or type(payment.get("amount_sats")) is not int
                    or payment["amount_sats"] != row["toll_fee_sats"]
                    or not payment.get("provider") or not payment.get("confirmed_at")
                ):
                    raise ValueError("Corrupt verified toll receipt")
                total += payment["amount_sats"]
                count += 1
    if total > 2**53 - 1:
        raise ValueError("Escrow counter exceeds JSON safe integer range")
    return {"verified_toll_sats": total, "settled_contracts": count,
            "genesis_escrow_id": genesis_id}


if __name__ == "__main__":
    main()
