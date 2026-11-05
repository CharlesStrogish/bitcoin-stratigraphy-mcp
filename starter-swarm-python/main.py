#!/usr/bin/env python3
"""bitcoin-stratigraphy-starter-swarm: one agent, one canonical query, real receipts.

Run ``python main.py`` after following README.md. This program can spend real
mainnet sats. The SDK's hardcoded session cap is 1,000 sats including reserved
routing fees; OpenAI charges are separate. Importing this module never pays.
"""

from __future__ import annotations

import json
import os
import sys
from decimal import Decimal
from pathlib import Path

from bitcoinstratigraphy_agent_yield import (
    CircuitBreakerError,
    FiduciaryTamperingError,
    TruthReceipt,
    with_fiduciary_yield,
)
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from dotenv import load_dotenv

from wallet import FEE_LIMIT_SATS, LndWallet

ROOT = Path(__file__).resolve().parent
MAX_SPEND_SATS = 1000  # Fiduciary Armor: deliberately not controlled by the LLM.
CANONICAL_TOOL = "stratigraphy.get_digest"


def required(name: str) -> str:
    """Fail before network activity; never echo a missing or invalid secret."""
    value = os.getenv(name, "").strip()
    if not value or value.startswith("paste_"):
        raise ValueError(f"Set {name} in .env before running the swarm.")
    return value


def local_path(value: str) -> Path:
    """Keep configuration and durable budgets stable across working directories."""
    path = Path(value).expanduser()
    return path if path.is_absolute() else ROOT / path


def trusted_public_key() -> str:
    """Require an independently provisioned Ed25519 SPKI PEM; no trust-on-first-use."""
    pem = local_path(required("STRATIGRAPHY_SERVER_PUBLIC_KEY_PATH")).read_text()
    key = serialization.load_pem_public_key(pem.encode())
    if not isinstance(key, Ed25519PublicKey) or not pem.startswith("-----BEGIN PUBLIC KEY-----"):
        raise ValueError("The server pin must be an Ed25519 SPKI PEM public key.")
    return pem


def display_receipt(receipt: TruthReceipt, remaining_msats: int) -> None:
    """Print the actual receipt, but redact spendable payment credentials."""
    safe = dict(receipt)
    if safe.get("cryptographic_proof"):
        safe["cryptographic_proof"] = "[payment preimage redacted]"
    print("\n=== Ed25519-verified TruthReceipt ===")
    print(json.dumps(safe, indent=2, ensure_ascii=False))
    print(
        "Fiduciary Armor | remaining circuit breaker budget: "
        f"{Decimal(remaining_msats) / 1000} / {MAX_SPEND_SATS} sats\n",
        flush=True,
    )


def main() -> None:
    # Existing process variables win, so secrets managers also work without .env.
    load_dotenv(ROOT / ".env", override=False)
    required("OPENAI_API_KEY")
    pin = trusted_public_key()
    # Import optional framework packages only when actually running the agent.
    from langchain.agents import create_agent
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI

    wallet = LndWallet(
        required("LND_REST_URL"),
        required("LND_MACAROON_HEX"),
        str(local_path(os.environ["LND_TLS_CERT_PATH"]))
        if os.getenv("LND_TLS_CERT_PATH", "").strip()
        else "",
    )
    client = None
    receipts: list[TruthReceipt] = []
    try:
        # The SDK wraps the configuration BEFORE LangChain constructs its graph.
        # Its tools/client perform discovery, L402 settlement, durable reservations,
        # exact-byte Ed25519 verification, and eligible yield claims.
        config = with_fiduciary_yield(
            {
                "framework": "langchain",
                "tools": [],
                "fiduciary": {
                    "wallet": wallet,
                    "server_public_key": pin,
                    "max_spend_sats": 1000,
                    "max_payment_sats": MAX_SPEND_SATS - FEE_LIMIT_SATS,
                    "max_total_sats": MAX_SPEND_SATS,
                    "fee_reserve_sats": FEE_LIMIT_SATS,
                    "state_directory": str(ROOT / ".agent-yield-state"),
                    "on_yield_claim": lambda claim: print(
                        f"21% yield claim: {claim['status']} "
                        f"({claim['amount_msats']} msats)", flush=True
                    ),
                    "on_error": lambda event: print(
                        f"SDK notice: {event['code']}", file=sys.stderr
                    ),
                },
            }
        )
        client = config["fiduciary"]

        @tool
        def latest_bitcoin_digest() -> dict | list | str:
            """Fetch the latest indexed Bitcoin Stratigraphy digest, once."""
            # A narrow application-owned tool prevents arbitrary wallet/tool use.
            # LangChain may retry a tool; reuse this successful receipt rather
            # than issue another paid query in this single-query starter.
            if not receipts:
                receipt = client.call_tool(
                    CANONICAL_TOOL, {"target": "latest", "format": "kv"}
                )
                receipts.append(receipt)
                display_receipt(receipt, client.circuit.remaining_msats)
            # Never expose payment preimages to OpenAI or an agent trace.
            return receipts[0].payload

        agent = create_agent(
            model=ChatOpenAI(
                model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
                temperature=0,
                max_tokens=400,
                timeout=30,
                max_retries=0,
            ),
            tools=[latest_bitcoin_digest],
            system_prompt=(
                "Call latest_bitcoin_digest exactly once before answering. "
                "Summarize its indexed date, height and digest in plain English. "
                "Do not call it a live-tip or per-record Bitcoin proof. "
                "Never invent a result if the tool fails."
            ),
        )
        print(
            f"bitcoin-stratigraphy-starter-swarm | {MAX_SPEND_SATS}-sat armor\n"
            f"Canonical tool: {CANONICAL_TOOL} | OpenAI billed separately",
            flush=True,
        )
        result = agent.invoke(
            {"messages": [{"role": "user", "content": "Fetch the latest Bitcoin digest."}]},
            config={"recursion_limit": 6},
        )
        if not receipts:
            raise RuntimeError("The model did not call the canonical tool; no receipt earned.")
        print("Agent summary:\n" + str(result["messages"][-1].content))
    finally:
        if client is not None:
            print(
                "Final circuit breaker budget: "
                f"{Decimal(client.circuit.remaining_msats) / 1000} sats remaining",
                flush=True,
            )
            client.close()
        wallet.close()


if __name__ == "__main__":
    try:
        main()
    except (CircuitBreakerError, FiduciaryTamperingError) as error:
        # These SDK errors have fixed, credential-free messages.
        print(f"Swarm stopped: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Framework/provider exceptions can include request bodies or credentials.
        # Keep the default terminal output safe; do not retry uncertain payments.
        print(
            "Swarm stopped without an unverified result. Check .env, the trusted "
            "server pin, signed API support, and provider status privately. "
            "Do not delete .agent-yield-state or blindly repay an uncertain invoice.",
            file=sys.stderr,
        )
        sys.exit(1)
