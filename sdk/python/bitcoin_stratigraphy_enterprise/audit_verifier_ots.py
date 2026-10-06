# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Free OpenTimestamps upgrades and Bitcoin verification; no application SDK."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import ssl
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

from opentimestamps.calendar import DEFAULT_CALENDAR_WHITELIST
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.serialize import (
    BytesDeserializationContext,
    BytesSerializationContext,
)
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

MAX_PROOF = 512 * 1024
EXPLORERS = ("https://blockstream.info/api", "https://mempool.space/api")


class EvidenceMismatch(ValueError):
    """A digest or Bitcoin Merkle commitment does not match."""


class VerificationUnavailable(RuntimeError):
    """Verification could not establish the required external facts."""


@dataclass
class Verdict:
    status: str
    detail: str = ""
    height: int | None = None
    proof: bytes | None = None


def deserialize(proof: bytes, digest: str) -> DetachedTimestampFile:
    if not proof or len(proof) > MAX_PROOF:
        raise EvidenceMismatch("Invalid OTS receipt size")
    try:
        context = BytesDeserializationContext(proof)
        receipt = DetachedTimestampFile.deserialize(context)
        context.assert_eof()
    except Exception as error:
        raise EvidenceMismatch("Malformed OTS receipt") from error
    if (
        not isinstance(receipt.file_hash_op, OpSHA256)
        or receipt.file_digest.hex() != digest
    ):
        raise EvidenceMismatch("OTS receipt does not match the execution trace SHA-256")
    return receipt


def serialize(receipt: DetachedTimestampFile) -> bytes:
    context = BytesSerializationContext()
    receipt.serialize(context)
    proof = context.getbytes()
    if len(proof) > MAX_PROOF:
        raise VerificationUnavailable("Upgraded receipt exceeded its size limit")
    return proof


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise VerificationUnavailable("Network redirect refused")


class PublicNetwork:
    """Only official calendar roots and two fixed Bitcoin sources are reachable."""

    def __init__(self, timeout: float = 10):
        self.timeout = timeout
        # Avoid inherited HTTP proxies and redirects to arbitrary/MCP endpoints.
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )

    @staticmethod
    def calendar_root(uri: str) -> str | None:
        try:
            parsed = urlsplit(uri)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.port not in (None, 443)
                or parsed.path not in ("", "/")
                or parsed.query
                or parsed.fragment
            ):
                return None
            root = f"https://{parsed.hostname}"
            return root if root in DEFAULT_CALENDAR_WHITELIST else None
        except ValueError:
            return None

    def get(self, url: str, limit: int) -> bytes:
        parsed = urlsplit(url)
        root = f"https://{parsed.hostname}"
        calendar = self.calendar_root(root)
        permitted_calendar = calendar and re.fullmatch(
            r"/timestamp/[0-9a-f]+", parsed.path
        )
        permitted_explorer = any(url.startswith(base + "/") for base in EXPLORERS)
        if (
            parsed.scheme != "https"
            or parsed.port not in (None, 443)
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not (permitted_calendar or permitted_explorer)
        ):
            raise VerificationUnavailable("Network destination is not permitted")
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Article12-Audit-Verifier/1",
                "Accept": "application/vnd.opentimestamps.v1, text/plain",
            },
        )
        deadline = time.monotonic() + self.timeout
        with self.opener.open(request, timeout=self.timeout) as response:
            if response.status != 200:
                raise VerificationUnavailable("Public source did not return success")
            pieces, length = [], 0
            while length <= limit:
                if time.monotonic() > deadline:
                    raise TimeoutError("Public source read deadline exceeded")
                piece = response.read1(min(4096, limit + 1 - length))
                if not piece:
                    break
                length += len(piece)
                pieces.append(piece)
            if length > limit:
                raise VerificationUnavailable(
                    "Public source response exceeded its size limit"
                )
        return b"".join(pieces)

    def timestamp(self, root: str, commitment: bytes) -> Timestamp:
        data = self.get(f"{root}/timestamp/{commitment.hex()}", MAX_PROOF)
        context = BytesDeserializationContext(data)
        stamp = Timestamp.deserialize(context, commitment)
        context.assert_eof()
        return stamp


def checked_header(raw_hex: str, expected_hash: str):
    """Check header hash, mainnet PoW limit and claimed proof of work."""
    if not re.fullmatch(r"[0-9a-fA-F]{160}", raw_hex):
        raise VerificationUnavailable("Malformed public Bitcoin header")
    raw = bytes.fromhex(raw_hex)
    block_hash = hashlib.sha256(hashlib.sha256(raw).digest()).digest()
    if block_hash[::-1].hex() != expected_hash:
        raise VerificationUnavailable("Public header does not match its block hash")
    bits = struct.unpack_from("<I", raw, 72)[0]
    exponent, mantissa = bits >> 24, bits & 0x7FFFFF
    target = (
        mantissa >> (8 * (3 - exponent))
        if exponent <= 3
        else mantissa << (8 * (exponent - 3))
    )
    mainnet_limit = 0xFFFF << (8 * (0x1D - 3))
    if (
        bits & 0x800000
        or not target
        or target > mainnet_limit
        or int.from_bytes(block_hash, "little") > target
    ):
        raise VerificationUnavailable("Invalid Bitcoin proof of work")
    return SimpleNamespace(
        hashMerkleRoot=raw[36:68], nTime=struct.unpack_from("<I", raw, 68)[0]
    )


class PublicBitcoin:
    """Corroborated headers, NOT a locally validated complete Bitcoin chain."""

    def __init__(self, network: PublicNetwork):
        self.network, self.cache = network, {}

    def verify(self, message: bytes, attestation: BitcoinBlockHeaderAttestation) -> int:
        height = attestation.height
        if height not in self.cache:
            values = []
            for base in EXPLORERS:
                block_hash = (
                    self.network.get(f"{base}/block-height/{height}", 128)
                    .decode("ascii")
                    .strip()
                )
                if not re.fullmatch(r"[0-9a-f]{64}", block_hash):
                    raise VerificationUnavailable("Invalid public block-hash response")
                raw = (
                    self.network.get(f"{base}/block/{block_hash}/header", 256)
                    .decode("ascii")
                    .strip()
                )
                values.append((block_hash, raw))
            if values[0] != values[1]:
                raise VerificationUnavailable("Independent Bitcoin sources disagree")
            self.cache[height] = checked_header(values[0][1], values[0][0])
        # Timestamp.deserialize evaluated every operation in the Merkle path.
        try:
            attestation.verify_against_blockheader(message, self.cache[height])
        except Exception as error:
            raise EvidenceMismatch(
                "Bitcoin Merkle commitment does not match"
            ) from error
        return height


class BitcoinCore:
    """The official OTS CLI verifies against the auditor's configured Bitcoin Core."""

    def __init__(self, timeout: float = 30):
        self.timeout = timeout

    def verify_receipt(self, proof: bytes, digest: str, heights: set[int]) -> int:
        command = shutil.which("ots")
        if not command:
            raise VerificationUnavailable(
                "Install the official ots CLI for Bitcoin Core verification"
            )
        # Do not pass application/payment/model secrets to an external executable.
        # Nix CLI must not import another Python ABI's workspace packages.
        allowed = {
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "SSL_CERT_FILE",
            "NIX_PROFILES",
            "XDG_CONFIG_HOME",
        }
        env = {key: value for key, value in os.environ.items() if key in allowed}
        env["PYTHONNOUSERSITE"] = "1"
        with tempfile.TemporaryDirectory(prefix="article12-verify-") as directory:
            path = Path(directory) / "receipt.ots"
            path.write_bytes(proof)
            path.chmod(0o600)
            with tempfile.TemporaryFile() as log:
                completed = subprocess.run(
                    [
                        command,
                        "--no-cache",
                        "--no-default-whitelist",
                        "verify",
                        "-d",
                        digest,
                        str(path),
                    ],
                    env=env,
                    stdout=log,
                    stderr=log,
                    timeout=self.timeout,
                    check=False,
                )
                log.seek(0)
                output = log.read(65537)
        if len(output) > 65536:
            raise VerificationUnavailable("OTS verification output exceeded its limit")
        text = output.decode("utf-8", errors="replace")
        # No --no-bitcoin, testnet, or 'assuming valid' shortcut is permitted.
        found = re.search(
            r"Success! Bitcoin block ([0-9]+) attests existence as of ", text
        )
        if completed.returncode == 0 and found and int(found[1]) in heights:
            return int(found[1])
        if "Digest does not match merkleroot" in text:
            raise EvidenceMismatch("Bitcoin Core rejected the Merkle commitment")
        raise VerificationUnavailable(
            "Bitcoin Core verification unavailable; check CLI/node configuration"
        )


class OtsVerifier:
    def __init__(
        self, *, offline=False, bitcoin_core=False, timeout=10, max_calendars=8
    ):
        self.offline, self.max_calendars = offline, max_calendars
        self.network = PublicNetwork(timeout)
        self.bitcoin = (
            BitcoinCore(max(30, timeout))
            if bitcoin_core
            else PublicBitcoin(self.network)
        )

    def verify(self, proof: bytes, digest: str) -> Verdict:
        receipt = deserialize(proof, digest)
        notes = []
        complete = any(
            isinstance(a, BitcoinBlockHeaderAttestation)
            for _, a in receipt.timestamp.all_attestations()
        )
        if not complete and not self.offline:
            # Snapshot the graph: calendar merges must not invalidate iteration.
            nodes, attempts = list(self._nodes(receipt.timestamp)), set()
            for node in nodes:
                for attestation in list(node.attestations):
                    if not isinstance(attestation, PendingAttestation):
                        continue
                    root = self.network.calendar_root(attestation.uri)
                    if not root:
                        notes.append("calendar not in the official HTTPS whitelist")
                        continue
                    key = (root, node.msg)
                    if key in attempts:
                        continue
                    if len(attempts) >= self.max_calendars:
                        notes.append("calendar request limit reached")
                        break
                    attempts.add(key)
                    try:
                        node.merge(self.network.timestamp(root, node.msg))
                    except urllib.error.HTTPError as error:
                        notes.append(
                            "calendar commitment not ready"
                            if error.code == 404
                            else "calendar unavailable"
                        )
                    except Exception:
                        notes.append("calendar unavailable or malformed upgrade")
        upgraded = serialize(receipt)
        attestations = [
            (message, a)
            for message, a in receipt.timestamp.all_attestations()
            if isinstance(a, BitcoinBlockHeaderAttestation)
        ]
        if not attestations:
            pending = any(
                isinstance(a, PendingAttestation)
                for _, a in receipt.timestamp.all_attestations()
            )
            return Verdict(
                "pending" if pending else "unavailable",
                "; ".join(sorted(set(notes)))
                or ("offline" if self.offline else "no Bitcoin attestation yet"),
                proof=upgraded,
            )
        if self.offline:
            return Verdict(
                "unavailable",
                "Bitcoin header checks disabled by --offline",
                proof=upgraded,
            )
        try:
            if isinstance(self.bitcoin, BitcoinCore):
                height = self.bitcoin.verify_receipt(
                    upgraded, digest, {a.height for _, a in attestations}
                )
            else:
                errors = []
                for message, attestation in sorted(
                    attestations, key=lambda pair: pair[1].height
                ):
                    try:
                        height = self.bitcoin.verify(message, attestation)
                        break
                    except Exception as error:
                        errors.append(error)
                else:
                    if any(isinstance(error, EvidenceMismatch) for error in errors):
                        raise EvidenceMismatch(
                            "No Bitcoin attestation matched its commitment"
                        )
                    raise VerificationUnavailable(
                        "Independent Bitcoin headers unavailable"
                    )
            return Verdict("verified", height=height, proof=upgraded)
        except EvidenceMismatch as error:
            return Verdict("tamper", str(error), proof=upgraded)
        except Exception:
            return Verdict(
                "unavailable", "Bitcoin verification unavailable", proof=upgraded
            )

    @staticmethod
    def _nodes(node):
        yield node
        for child in node.ops.values():
            yield from OtsVerifier._nodes(child)
