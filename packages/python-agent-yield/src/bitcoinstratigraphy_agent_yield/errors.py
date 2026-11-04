"""Stable, secret-free SDK errors."""


class FiduciaryError(RuntimeError):
    """A protocol, authorization or accounting error; never a wallet traceback."""


class FiduciaryTamperingError(FiduciaryError):
    def __init__(self):
        super().__init__("Data payload signature verification failed.")
