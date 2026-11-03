"""Frictionless, explicitly budgeted Bitcoin Stratigraphy tools for Python agents."""

from .adapters import AgentTool, with_fiduciary_yield
from .client import DEFAULT_MCP_URL, FiduciaryClient
from .errors import FiduciaryError

__all__ = [
    "AgentTool",
    "DEFAULT_MCP_URL",
    "FiduciaryClient",
    "FiduciaryError",
    "with_fiduciary_yield",
]
__version__ = "0.1.0"
