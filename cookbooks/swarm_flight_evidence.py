"""Compatibility module; implementation lives in the enterprise SDK."""
import sys
from cookbooks._enterprise_compat import load_module

sys.modules[__name__] = load_module("swarm_flight_evidence")
