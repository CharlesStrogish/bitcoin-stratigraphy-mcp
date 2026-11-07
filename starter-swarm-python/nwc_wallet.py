"""Quiet NIP-47 wallet adapter using the maintained Rust Nostr SDK bindings."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

from wallet import WalletError


class NwcWallet:
    """Dedicated clearing payer. Never retries an uncertain payment."""

    def __init__(self, uri: str):
        # Validate transport locally before loading a connection containing secrets.
        try:
            from nostr_sdk import NostrWalletConnectUri

            parsed = urlsplit(uri)
            query = parse_qs(parsed.query, strict_parsing=True)
            if (
                parsed.scheme != "nostr+walletconnect"
                or parsed.fragment
                or parsed.username
                or parsed.password
            ):
                raise ValueError
            relays = query.get("relay", [])
            if not relays or any(
                urlsplit(relay).scheme != "wss"
                or not urlsplit(relay).hostname
                or urlsplit(relay).username
                or urlsplit(relay).password
                or urlsplit(relay).fragment
                for relay in relays
            ):
                raise ValueError
            self._uri = NostrWalletConnectUri.parse(uri)
        except Exception:
            raise ValueError("Set a valid NWC_URI with secure wss relays.") from None

    async def _pay(self, invoice: str):
        from nostr_sdk import NostrWalletConnectBuilder, PayInvoiceRequest

        connection = (
            NostrWalletConnectBuilder(self._uri).timeout(timedelta(seconds=20)).build()
        )
        try:
            return await asyncio.wait_for(
                connection.pay_invoice(
                    PayInvoiceRequest(id=None, invoice=invoice, amount=None)
                ),
                timeout=25,
            )
        finally:
            # Closing cannot turn a proven payment into a new payment attempt.
            try:
                await asyncio.wait_for(connection.client().shutdown(), timeout=5)
            except Exception:
                pass

    def pay_invoice(self, invoice: str) -> dict:
        try:
            result = asyncio.run(self._pay(invoice))
            # The shared SDK validates the hash-bound preimage and actual fees.
            return {"preimage": result.preimage, "fees_paid": result.fees_paid}
        except Exception:
            raise WalletError(
                "NWC payment outcome unconfirmed. Inspect privately; do not repay."
            ) from None

    def close(self):
        """Each payment owns and closes its own relay client."""
