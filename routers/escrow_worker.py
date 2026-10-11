# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Bounded, secret-free-env JSON bridge for the existing Express server."""

import json
from pathlib import Path
import sys

# Resolve imports from the staged distribution, not the caller's working directory.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from routers.escrow_api import EscrowApi  # noqa: E402
from services.escrow_db import EscrowStore  # noqa: E402
from services.escrow_engine import EscrowEngine  # noqa: E402


def main():
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Worker request exceeds limit")
        request = json.loads(raw)
        height = request.get("strata_height")
        engine = EscrowEngine(
            EscrowStore(request["database_path"]),
            strata_block_provider=(lambda: height) if height is not None else None,
            bitcoin_price_provider=(
                (lambda: request["btc_usd_price"]) if "btc_usd_price" in request else None
            ),
        )
        status, body = EscrowApi(engine).dispatch(request["operation"], request["body"])
        print(json.dumps({"status": status, "body": body}))
    except Exception:
        # No traceback or submitted fields: these may contain private evidence.
        print(json.dumps({"status": 503, "body": {"error": "Escrow worker unavailable"}}))


if __name__ == "__main__":
    main()
