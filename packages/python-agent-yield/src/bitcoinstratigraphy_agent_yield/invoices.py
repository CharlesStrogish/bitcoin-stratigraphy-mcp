"""Strict fixed-amount mainnet BOLT11 validation using libsecp256k1."""

import hashlib
import re
from dataclasses import dataclass

from bech32 import bech32_decode, convertbits
from coincurve import PublicKey

from .errors import FiduciaryError


@dataclass(frozen=True)
class Invoice:
    amount_msats: int
    payment_hash: str
    expires_at: int


def _integer(words: list[int]) -> int:
    value = 0
    for word in words:
        value = value * 32 + word
    return value


def _bytes(words: list[int], pad: bool = False) -> bytes:
    result = convertbits(words, 5, 8, pad)
    if result is None:
        raise ValueError("Invalid padding")
    return bytes(result)


def decode_invoice(text: str) -> Invoice:
    """Validate checksum, signature, network, amount, tags and explicit payee."""
    try:
        if not isinstance(text, str) or len(text) > 4096:
            raise ValueError()
        hrp, words = bech32_decode(text)
        amount = re.fullmatch(r"lnbc([1-9]\d*)([munp]?)", hrp or "")
        if not amount or words is None or len(words) < 166:
            raise ValueError()
        value, scale = int(amount[1]), amount[2]
        if scale == "p":
            if value % 10:
                raise ValueError()
            msats = value // 10
        else:
            msats = (
                value
                * {"": 100_000_000_000, "m": 100_000_000, "u": 100_000, "n": 100}[scale]
            )
        if not 0 < msats <= 2**53 - 1:
            raise ValueError()
        end, cursor = len(words) - 104, 7
        tags = {}
        while cursor < end:
            if cursor + 3 > end:
                raise ValueError()
            tag, length = words[cursor], _integer(words[cursor + 1 : cursor + 3])
            cursor += 3
            if cursor + length > end:
                raise ValueError()
            if tag in (1, 6, 19, 13, 23):
                if tag in tags:
                    raise ValueError()
                tags[tag] = words[cursor : cursor + length]
            cursor += length
        payment_hash = _bytes(tags[1])
        if len(tags[1]) != 52 or len(payment_hash) != 32:
            raise ValueError()
        if (13 in tags) + (23 in tags) != 1:
            raise ValueError()
        if 23 in tags and len(_bytes(tags[23])) != 32:
            raise ValueError()
        if 6 in tags and not 1 <= len(tags[6]) <= 10:
            raise ValueError()
        expiry = _integer(tags[6]) if 6 in tags else 3600
        signature = _bytes(words[end:])
        if len(signature) != 65 or signature[-1] > 3:
            raise ValueError()
        message = hashlib.sha256(hrp.encode() + _bytes(words[:end], True)).digest()
        # Recovery validates the ECDSA equation. If n is present it must agree
        # with the recovered signing key, rather than trusting an arbitrary key.
        payee = PublicKey.from_signature_and_message(signature, message, hasher=None)
        if 19 in tags and _bytes(tags[19]) != payee.format(compressed=True):
            raise ValueError()
        return Invoice(msats, payment_hash.hex(), _integer(words[:7]) + expiry)
    except (ValueError, TypeError, KeyError, OverflowError):
        raise FiduciaryError("INVALID_MAINNET_INVOICE") from None


def verify_preimage(preimage: object, payment_hash: str) -> bool:
    return (
        isinstance(preimage, str)
        and re.fullmatch(r"[0-9a-fA-F]{64}", preimage) is not None
        and hashlib.sha256(bytes.fromhex(preimage)).hexdigest() == payment_hash
    )
