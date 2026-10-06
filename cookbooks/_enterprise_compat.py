# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Checkout-only bootstrap for legacy cookbook import and CLI compatibility."""

from importlib import import_module
from pathlib import Path
import sys


def load_module(name):
    source = str(Path(__file__).resolve().parents[1] / "sdk" / "python")
    if source not in sys.path:
        sys.path.insert(0, source)
    return import_module(f"bitcoin_stratigraphy_enterprise.{name}")
