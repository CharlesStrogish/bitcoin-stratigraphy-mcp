"""Stable, secret-free SDK errors."""


class FiduciaryError(RuntimeError):
    """A protocol, authorization or accounting error; never a wallet traceback."""
