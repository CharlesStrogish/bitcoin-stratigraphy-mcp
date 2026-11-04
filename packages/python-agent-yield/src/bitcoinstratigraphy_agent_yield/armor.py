"""Session spend admission and explicitly scoped, JSON-compatible receipts."""

import hashlib
import json
import threading
from datetime import datetime, timezone

from .errors import FiduciaryError


class CircuitBreakerError(FiduciaryError):
    def __init__(self):
        super().__init__("Maximum authorized thermodynamic spend reached.")


def utc_now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def sats_string(msats):
    whole, fraction = divmod(msats, 1000)
    return str(whole) + (f".{fraction:03d}".rstrip("0") if fraction else "")


class SpendCircuit:
    def __init__(self, max_spend_sats=5000):
        if type(max_spend_sats) is not int or not 0 <= max_spend_sats <= 2**53 - 1:
            raise FiduciaryError("INVALID_MAX_SPEND_SATS")
        self._limit = max_spend_sats * 1000
        self._reserved = 0
        self._tripped = False
        self._invoices = {}
        self._lock = threading.Lock()

    @property
    def remaining_msats(self):
        with self._lock:
            return max(0, self._limit - self._reserved)

    def assert_capacity(self):
        with self._lock:
            if self._tripped or self._reserved >= self._limit:
                raise CircuitBreakerError()

    def reserve(self, payment_hash, amount):
        with self._lock:
            if payment_hash in self._invoices:
                return None
            if self._tripped or self._reserved + amount > self._limit:
                self._tripped = True
                raise CircuitBreakerError()
            self._invoices[payment_hash] = amount
            self._reserved += amount
        released = False

        def release():
            nonlocal released
            with self._lock:
                if not released:
                    released = True
                    self._reserved -= self._invoices.pop(payment_hash)

        return release

    def settle(self, payment_hash, amount):
        with self._lock:
            prior = self._invoices.get(payment_hash)
            if prior is None:
                return
            self._reserved += amount - prior
            self._invoices[payment_hash] = amount
            if self._reserved > self._limit:
                self._tripped = True


class TruthReceipt(dict):
    """A serializable object; a payment preimage is not a signed data anchor."""

    def __init__(self, payload, evidence=None):
        super().__init__(
            payload=payload,
            thermodynamic_cost=sats_string(evidence["amount"] if evidence else 0),
            timestamp=evidence["settled_at"] if evidence else utc_now(),
            cryptographic_proof=evidence["preimage"] if evidence else None,
            payment_hash=evidence["hash"] if evidence else None,
            evidence_scope="payment_only" if evidence else "payment_not_observed",
            timestamp_kind=(
                "client_observed_settlement" if evidence["settled_at"] else "unknown"
            )
            if evidence
            else "receipt_observed",
            payload_sha256=hashlib.sha256(
                json.dumps(
                    payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
                ).encode()
            ).hexdigest(),
        )

    @property
    def payload(self):
        return self["payload"]

    @property
    def thermodynamic_cost(self):
        return self["thermodynamic_cost"]

    @property
    def timestamp(self):
        return self["timestamp"]

    @property
    def cryptographic_proof(self):
        return self["cryptographic_proof"]
