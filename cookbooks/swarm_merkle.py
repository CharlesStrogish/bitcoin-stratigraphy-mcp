# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Compatibility module; implementation lives in the enterprise SDK."""

import sys
from cookbooks._enterprise_compat import load_module

sys.modules[__name__] = load_module("swarm_merkle")
