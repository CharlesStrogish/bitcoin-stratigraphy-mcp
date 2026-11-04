"""Observer-only terminal receipts. stdout belongs to the MCP transport."""

import os
import sys


def terminal_receipt(
    kind: str, amount_msats: int, remaining_msats: int | None = None
) -> None:
    try:
        if os.getenv("QUIET_STRATIGRAPHY", "").lower() == "true":
            return
        if type(amount_msats) is not int or amount_msats <= 0:
            return
        whole, fraction = divmod(amount_msats, 1000)
        sats = str(whole) + (f".{fraction:03d}".rstrip("0") if fraction else "")
        if kind == "settled":
            color = "\x1b[32m"
            message = f"Thermodynamic Yield Earned: {sats} Sats routed to agent wallet."
        elif kind == "allocated":
            color = "\x1b[33m"
            message = (
                f"Thermodynamic Yield Allocated: {sats} Sats (settlement pending)."
            )
        else:
            return
        capacity = ""
        if type(remaining_msats) is int and remaining_msats >= 0:
            from .armor import sats_string

            capacity = (
                f" Circuit breaker: {sats_string(remaining_msats)} Sats remaining."
            )
        print(
            f"{color}[Bitcoin Stratigraphy] ⚡ {message}{capacity}\x1b[0m",
            file=sys.stderr,
        )
    except Exception:
        pass  # Diagnostics must never affect payment or execution.
