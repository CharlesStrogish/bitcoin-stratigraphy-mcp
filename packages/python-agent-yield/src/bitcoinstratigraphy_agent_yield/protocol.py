"""Bounded MCP JSON/Streamable HTTP framing and pre-invoice Hashcash."""

import hashlib
import json
import re
import time
from datetime import datetime

from .errors import FiduciaryError

PROTOCOL_VERSION = "2026-07-28"
MAX_BYTES = 2 * 1024 * 1024


def sse_complete(data, request_id):
    """Stop reading once our response arrives; SSE servers may keep HTTP open."""
    text = data.decode("utf-8", errors="replace")
    for event in re.split(r"\r?\n\r?\n", text)[:-1]:
        lines = "\n".join(
            line[5:].lstrip(" ")
            for line in event.splitlines()
            if line.startswith("data:")
        )
        if not lines:
            continue
        try:
            message = json.loads(lines)
        except ValueError:
            continue
        if (
            isinstance(message, dict)
            and message.get("id") == request_id
            and ("result" in message or "error" in message)
        ):
            return True
    return False


def read_rpc(response, request_id):
    response.raise_for_status()
    try:
        if "text/event-stream" in response.headers.get("content-type", ""):
            messages = []
            for event in re.split(r"\r?\n\r?\n", response.text):
                data = "\n".join(
                    line[5:].lstrip(" ")
                    for line in event.splitlines()
                    if line.startswith("data:")
                )
                if data:
                    messages.append(json.loads(data))
            payload = next(
                (
                    m
                    for m in messages
                    if isinstance(m, dict) and m.get("id") == request_id
                ),
                None,
            )
        else:
            payload = response.json()
        if (
            not isinstance(payload, dict)
            or payload.get("jsonrpc") != "2.0"
            or payload.get("id") != request_id
            or ("error" in payload) == ("result" in payload)
        ):
            raise ValueError()
        if "error" in payload:
            # Never reflect arbitrary server messages (which can contain secrets).
            raise FiduciaryError("MCP_RPC_ERROR")
        return payload["result"]
    except (ValueError, TypeError):
        raise FiduciaryError("MCP_INVALID_RESPONSE") from None


def error_data(response):
    try:
        payload = response.json()
        if not isinstance(payload, dict):
            return {}
        if payload.get("jsonrpc") == "2.0":
            error = payload.get("error")
            return error.get("data", {}) if isinstance(error, dict) else {}
        return payload
    except ValueError:
        return {}


def solve_pow(details):
    try:
        if (
            not isinstance(details, dict)
            or details.get("algorithm") != "sha256"
            or details.get("hash_input") != "challenge:nonce"
            or type(details.get("difficulty")) is not int
            or not 2 <= details["difficulty"] <= 4
            or not isinstance(details.get("challenge"), str)
            or not 1 <= len(details["challenge"]) <= 1024
        ):
            raise ValueError()
        expires = datetime.fromisoformat(details["expires_at"].replace("Z", "+00:00"))
        if expires.tzinfo is None or expires.timestamp() <= time.time():
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise FiduciaryError("UNSUPPORTED_OR_EXPIRED_INVOICE_POW") from None
    deadline = min(
        time.monotonic() + 20, time.monotonic() + expires.timestamp() - time.time()
    )
    for nonce in range(1_000_000):
        if nonce % 256 == 0 and time.monotonic() >= deadline:
            break
        if (
            hashlib.sha256(f"{details['challenge']}:{nonce}".encode())
            .hexdigest()
            .startswith("0" * details["difficulty"])
        ):
            return {
                "X-L402-PoW-Challenge": details["challenge"],
                "X-L402-PoW-Nonce": str(nonce),
            }
    raise FiduciaryError("INVOICE_POW_BUDGET_EXCEEDED")
