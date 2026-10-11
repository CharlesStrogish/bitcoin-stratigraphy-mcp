# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""USD-normalized escrow tolls using the repository's mempool.space price rail."""

import json
import math
from urllib.request import urlopen

TARGET_USD = 0.02
FALLBACK_TOLL_SATS = 21
MAX_TOLL_SATS = 2**53 - 1
PRICE_URL = "https://mempool.space/api/v1/prices"


def read_bitcoin_usd_price():
    """Standalone Python rail; Express supplies its existing bounded price reader."""
    with urlopen(PRICE_URL, timeout=5) as response:
        payload = response.read(64 * 1024 + 1)
    if len(payload) > 64 * 1024:
        raise ValueError("Price response exceeded limit")
    return json.loads(payload)["USD"]


def get_dynamic_escrow_toll(price_provider=None):
    """Return a positive toll, or exactly 21 sats for any unusable price feed.

    Rates enter through trusted service configuration, never a REST body field.
    Python's round-to-even rule is shared by the public REST quote calculator.
    """
    try:
        price = (price_provider or read_bitcoin_usd_price)()
        if type(price) not in (int, float) or not math.isfinite(price) or price <= 0:
            return FALLBACK_TOLL_SATS
        sats = max(1, round((TARGET_USD / price) * 100_000_000))
        return sats if sats <= MAX_TOLL_SATS else FALLBACK_TOLL_SATS
    except Exception:
        return FALLBACK_TOLL_SATS
