"""Frictionless, explicitly budgeted Bitcoin Stratigraphy tools for Python agents."""

from .adapters import AgentTool, with_fiduciary_yield
from .client import DEFAULT_MCP_URL, FiduciaryClient, YieldStakingClient
from .staking import ESCROW_TOOL, Nip98Signer, YieldSettings
from .errors import FiduciaryError
from .armor import CircuitBreakerError, TruthReceipt
from .errors import FiduciaryTamperingError

__all__ = [
    "FiduciaryTamperingError",
    "CircuitBreakerError",
    "TruthReceipt",
    "AgentTool",
    "DEFAULT_MCP_URL",
    "FiduciaryClient",
    "FiduciaryError",
    "with_fiduciary_yield",
    "YieldStakingClient",
    "YieldSettings",
    "Nip98Signer",
    "ESCROW_TOOL",
]
__version__ = "1.1.0"
