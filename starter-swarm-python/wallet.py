"""Small, explicit LND REST adapter for the public agent-yield wallet contract.

This file is independent of the Central Bank server. HTTPX is a dependency of
bitcoinstratigraphy-agent-yield. No private repository modules are imported.
"""

from __future__ import annotations

import json
import re
import ssl
from urllib.parse import urlsplit

import httpx

FEE_LIMIT_SATS = 10


class WalletError(RuntimeError):
    """Safe error text: never include wallet responses, headers, or credentials."""


class LndWallet:
    """Pay exact BOLT11 invoices and receive fractional-satoshi yield via LND.

    The SDK validates the invoice before calling us and the payment preimage
    afterwards. LND enforces the routing-fee limit at the payment boundary.
    A timeout is an UNKNOWN payment outcome, not permission to repay.
    """

    def __init__(self, url: str, macaroon_hex: str, tls_cert_path: str = ""):
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
        ):
            raise ValueError("LND_REST_URL must be an HTTPS origin without credentials.")
        if not re.fullmatch(r"(?:[0-9a-fA-F]{2})+", macaroon_hex):
            raise ValueError("LND_MACAROON_HEX must be your hex-encoded macaroon.")
        context = ssl.create_default_context(cafile=tls_cert_path or None)
        self.http = httpx.Client(
            base_url=url.rstrip("/"),
            headers={"Grpc-Metadata-macaroon": macaroon_hex},
            verify=context,
            timeout=20,
            follow_redirects=False,
            trust_env=False,
        )

    def _post(self, path: str, body: dict) -> dict:
        try:
            response = self.http.post(path, json=body)
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict):
                raise ValueError
            return result
        except (httpx.HTTPError, ValueError):
            raise WalletError(
                "LND request failed. Check node status privately; do not blindly "
                "retry a payment or delete the SDK ledger."
            ) from None

    def pay_invoice(self, bolt11: str) -> dict:
        """LND SendPaymentV2 returns newline-delimited gateway result envelopes."""
        try:
            # Suppress intermediate updates; LND bounds routing to 10 seconds,
            # inside the HTTP client's 20-second timeout. Never retry this POST.
            response = self.http.post(
                "/v2/router/send",
                json={
                    "payment_request": bolt11,
                    "fee_limit_sat": str(FEE_LIMIT_SATS),
                    "timeout_seconds": 10,
                    "no_inflight_updates": True,
                },
            )
            response.raise_for_status()
            updates = [json.loads(line) for line in response.text.splitlines() if line.strip()]
            if not updates or any("error" in item for item in updates):
                raise ValueError
            result = updates[-1]["result"]
            if result.get("status") != "SUCCEEDED":
                raise ValueError
        except (httpx.HTTPError, KeyError, TypeError, ValueError, AttributeError):
            raise WalletError(
                "LND did not confirm payment. Inspect it privately; do not blindly repay."
            ) from None
        try:
            preimage = result["payment_preimage"]
            raw_fees = result["fee_msat"]
            if not isinstance(raw_fees, (str, int)) or isinstance(raw_fees, bool):
                raise ValueError
            if not re.fullmatch(r"[0-9]+", str(raw_fees)):
                raise ValueError
            fees = int(raw_fees)
            if not re.fullmatch(r"[0-9a-fA-F]{64}", preimage) or fees > FEE_LIMIT_SATS * 1000:
                raise ValueError
        except (KeyError, TypeError, ValueError):
            raise WalletError("LND returned an unconfirmed payment proof or fee.") from None
        return {"preimage": preimage, "fees_paid": fees}

    def make_invoice(self, amount_msats: int) -> dict:
        """Preserve exact 21% credits: never round a receiving invoice to sats."""
        if type(amount_msats) is not int or amount_msats <= 0:
            raise ValueError("Receiving amount must be positive integer millisatoshis.")
        result = self._post(
            "/v1/invoices",
            {
                "value_msat": str(amount_msats),
                "memo": "Bitcoin Stratigraphy agent yield",
                "expiry": "3600",
            },
        )
        invoice = result.get("payment_request")
        if not isinstance(invoice, str) or not invoice:
            raise WalletError("LND did not return a receiving invoice.")
        return {"invoice": invoice}

    def close(self) -> None:
        self.http.close()
