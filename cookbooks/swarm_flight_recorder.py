#!/usr/bin/env python3
# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Compatibility entry point; implementation lives in the enterprise SDK."""

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cookbooks._enterprise_compat import load_module

_implementation = load_module("swarm_flight_recorder")
if __name__ == "__main__":
    raise SystemExit(_implementation.main())
sys.modules[__name__] = _implementation
