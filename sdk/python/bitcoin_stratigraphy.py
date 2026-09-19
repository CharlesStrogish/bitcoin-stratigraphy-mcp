"""Dependency-free Bitcoin Stratigraphy L402 client for Python agents."""

from __future__ import annotations

import json
import hashlib
import threading
import time
import struct
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping, Protocol, TypedDict


SettlementAsset = Literal["btc-lightning", "l-btc", "taproot-assets"]

class ZkPublicInputs(TypedDict):
    blockHeight: int
    snapshotDigest: str
    thermodynamicHash: str
    timestamp: int
    valuationSat: int


class ZkProof(TypedDict):
    proof: str
    publicInputs: ZkPublicInputs
    verificationKeyId: str


class ZkVerifyResponse(TypedDict):
    valid: bool
    verifiedAt: str
    computationTimeMs: float


class MeshPeerAttestation(TypedDict):
    pubkey: str
    signature: str
    eventId: str
    createdAt: int
    roundTripLatencyMs: float


class MeshConsensus(TypedDict):
    quorumScore: float
    peerAttestations: list[MeshPeerAttestation]
    merkleRoot: str
    snapshotDigest: str
    threshold: int
    isolationMode: bool
    networkId: str


class MeshStatus(TypedDict):
    nodePubkey: str
    activePeerCount: int
    configuredPeerCount: int
    topologyHealth: Literal["healthy", "degraded", "isolated"]
    crossValidationSuccessRate: float
    averagePropagationLatencyMs: float
    quorumThreshold: int


PaidStratigraphyResponse = dict[str, Any]
StratigraphyTelemetryEnvelope = dict[str, Any]


class WalletAdapter(Protocol):
    def pay_invoice(self, invoice: str) -> str | Mapping[str, Any]:
        """Pay a BOLT11 invoice and return its 32-byte hex preimage."""


@dataclass
class StreamSubscription:
    _stop: threading.Event
    _thread: threading.Thread
    _response_lock: threading.Lock
    _response: Any = None

    def close(self) -> None:
        self._stop.set()
        with self._response_lock:
            if self._response is not None:
                self._response.close()
                self._response = None

    @property
    def closed(self) -> bool:
        return self._stop.is_set()


class BitcoinStratigraphyClient:
    def __init__(
        self,
        base_url: str,
        wallet: WalletAdapter,
        tier: str = "1-day",
        settlement_asset: SettlementAsset = "btc-lightning",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.wallet = wallet
        self.tier = tier
        self.settlement_asset = settlement_asset
        self.timeout = timeout
        self._credential: dict[str, Any] | None = None
        self._credential_lock = threading.Lock()

    def get_cost(self) -> dict[str, Any]:
        return self._json_request("/api/v1/cost")

    def get_latest(self) -> PaidStratigraphyResponse:
        self.get_cost()
        return self._authorized_json("/api/v1/stratigraphy")

    def get_mesh_status(self) -> MeshStatus:
        return self._json_request("/api/v1/mesh/status")  # type: ignore[return-value]

    def verify_zk_proof(
        self,
        zk_proof: ZkProof,
        data: Any,
    ) -> ZkVerifyResponse:
        payload = {
            "proof": zk_proof["proof"],
            "publicInputs": zk_proof["publicInputs"],
            "verificationKeyId": zk_proof["verificationKeyId"],
            "data": data,
        }
        request = urllib.request.Request(
            f"{self.base_url}/api/v1/zk/verify",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.load(response)

    def subscribe_stream(
        self,
        on_telemetry: Callable[[dict[str, Any]], None],
        on_error: Callable[[Exception], None] = lambda _error: None,
    ) -> StreamSubscription:
        stop = threading.Event()
        response_lock = threading.Lock()
        subscription: StreamSubscription

        def run() -> None:
            delay = 1.0
            while not stop.is_set():
                try:
                    response = self._open_authorized(
                        "/api/v1/stratigraphy/stream"
                    )
                    with response_lock:
                        subscription._response = response
                    with response:
                        delay = 1.0
                        event = "message"
                        data: list[str] = []
                        while not stop.is_set():
                            raw = response.readline()
                            if not raw:
                                raise ConnectionError(
                                    "Bitcoin Stratigraphy stream closed"
                                )
                            line = raw.decode("utf-8").rstrip("\r\n")
                            if not line:
                                if event == "telemetry" and data:
                                    on_telemetry(json.loads("\n".join(data)))
                                event, data = "message", []
                            elif line.startswith("event:"):
                                event = line[6:].strip()
                            elif line.startswith("data:"):
                                data.append(line[5:].lstrip())
                except Exception as error:
                    if stop.is_set():
                        break
                    on_error(error)
                    stop.wait(delay)
                    delay = min(delay * 2, 30.0)
                finally:
                    with response_lock:
                        subscription._response = None

        thread = threading.Thread(
            target=run,
            name="bitcoin-stratigraphy-sse",
            daemon=True,
        )
        subscription = StreamSubscription(stop, thread, response_lock)
        thread.start()
        return subscription

    def _authorized_json(self, path: str) -> Any:
        with self._open_authorized(path) as response:
            return json.load(response)

    def _open_authorized(self, path: str):
        headers: dict[str, str] = {
            "X-Settlement-Asset": self.settlement_asset
        }
        credential = self._current_credential()
        sent_authorization: str | None = None
        if credential:
            sent_authorization = self._authorization(credential)
            headers["Authorization"] = sent_authorization
        try:
            return self._open(path, headers)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                current = self._current_credential()
                if (
                    current is None
                    or self._authorization(current) == sent_authorization
                ):
                    self._credential = None
            if error.code != 402:
                raise
            challenge = json.loads(error.read().decode("utf-8"))
            credential = self._pay_challenge(
                challenge, sent_authorization
            )
            return self._open(
                path,
                {
                    "Authorization": self._authorization(credential),
                    "X-Settlement-Asset": self.settlement_asset,
                },
            )

    def _pay_challenge(
        self,
        challenge: Mapping[str, Any],
        rejected_authorization: str | None,
    ) -> dict[str, Any]:
        with self._credential_lock:
            cached = self._current_credential()
            if (
                cached
                and self._authorization(cached) != rejected_authorization
            ):
                return cached
            selected = next(
                (
                    item
                    for item in challenge.get("passes", [])
                    if item.get("tier") == self.tier
                ),
                None,
            )
            if not selected:
                raise ValueError(
                    f"L402 challenge did not include tier {self.tier}"
                )
            if selected.get("payment_asset") != self.settlement_asset:
                raise ValueError(
                    "L402 challenge did not match the requested settlement asset"
                )
            result = self.wallet.pay_invoice(selected["invoice"])
            if isinstance(result, str):
                preimage = result
            else:
                preimage = result.get("preimage") or result.get(
                    "payment_preimage"
                )
            if not isinstance(preimage, str) or len(preimage) != 64:
                raise ValueError(
                    "Wallet did not return a 32-byte payment preimage"
                )
            int(preimage, 16)
            payment_hash = selected.get("payment_hash")
            computed_hash = hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
            if (
                not isinstance(payment_hash, str)
                or computed_hash != payment_hash.lower()
            ):
                raise ValueError(
                    "Wallet preimage does not match the L402 payment hash"
                )
            self._credential = {
                "macaroon": selected["macaroon"],
                "preimage": preimage.lower(),
                "valid_until": selected["valid_until"],
                "payment_asset": selected["payment_asset"],
            }
            return self._credential

    def _current_credential(self) -> dict[str, Any] | None:
        if (
            self._credential
            and self._credential["valid_until"] > int(time.time())
        ):
            return self._credential
        self._credential = None
        return None

    @staticmethod
    def _authorization(credential: Mapping[str, Any]) -> str:
        return (
            f"L402 {credential['macaroon']}:{credential['preimage']}"
        )

    def _json_request(self, path: str) -> dict[str, Any]:
        with self._open(
            path, {"X-Settlement-Asset": self.settlement_asset}
        ) as response:
            return json.load(response)

    def _open(self, path: str, headers: Mapping[str, str]):
        request = urllib.request.Request(
            f"{self.base_url}{path}", headers=dict(headers)
        )
        return urllib.request.urlopen(request, timeout=self.timeout)


def _mesh_merkle_root(event_ids: list[str]) -> str:
    if not event_ids:
        return hashlib.sha256(b"").hexdigest()
    level = sorted(event_ids)
    while len(level) > 1:
        next_level: list[str] = []
        for index in range(0, len(level), 2):
            left = level[index]
            right = level[index + 1] if index + 1 < len(level) else left
            next_level.append(
                hashlib.sha256((left + right).encode("utf-8")).hexdigest()
            )
        level = next_level
    return level[0]


def _canonical_mesh_value(value: Any) -> Any:
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["bool", 1 if value else 0]
    if isinstance(value, str):
        return ["str", value]
    if isinstance(value, (int, float)):
        number = float(value)
        if number != number or number in (float("inf"), float("-inf")):
            raise ValueError("Mesh snapshot numbers must be finite")
        return ["f64", struct.pack(">d", number).hex()]
    if isinstance(value, list):
        return ["array", [_canonical_mesh_value(item) for item in value]]
    if isinstance(value, dict):
        return [
            "object",
            [
                [key, _canonical_mesh_value(value[key])]
                for key in sorted(value)
            ],
        ]
    raise TypeError("Mesh snapshot must be JSON serializable")


def _canonical_mesh_json(value: Any) -> str:
    return json.dumps(
        _canonical_mesh_value(value),
        separators=(",", ":"),
        ensure_ascii=False,
    )


def validate_mesh_consensus(
    consensus: MeshConsensus,
    snapshot: Any,
    verify_schnorr: Callable[[Mapping[str, Any]], bool],
    trusted_pubkeys: set[str],
    threshold: int,
    network_id: str,
    allow_isolation: bool = False,
    now_seconds: int | None = None,
    max_age_seconds: int = 300,
) -> bool:
    serialized = _canonical_mesh_json(snapshot)
    snapshot_digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    unique_pubkeys: set[str] = set()
    valid_count = 0
    for attestation in consensus["peerAttestations"]:
        pubkey = attestation["pubkey"]
        if pubkey in unique_pubkeys or pubkey not in trusted_pubkeys:
            continue
        if abs((now_seconds or int(time.time())) - attestation["createdAt"]) > max_age_seconds:
            continue
        unique_pubkeys.add(pubkey)
        event = {
            "id": attestation["eventId"],
            "pubkey": pubkey,
            "created_at": attestation["createdAt"],
            "kind": 20078,
            "tags": [
                ["d", f"bitcoin-stratigraphy-mesh:{snapshot_digest}"],
                ["t", "bitcoin-stratigraphy"],
                ["t", "mesh-cross-validation"],
                ["x", snapshot_digest],
                ["n", network_id],
            ],
            "content": _canonical_mesh_json(
                {
                    "networkId": network_id,
                    "snapshotDigest": snapshot_digest,
                }
            ),
            "sig": attestation["signature"],
        }
        if verify_schnorr(event):
            valid_count += 1
    effective_threshold = (
        1 if consensus["isolationMode"] and allow_isolation else threshold
    )
    expected_score = min(1.0, valid_count / effective_threshold)
    return (
        valid_count >= effective_threshold
        and consensus["threshold"] == effective_threshold
        and consensus["networkId"] == network_id
        and (not consensus["isolationMode"] or allow_isolation)
        and snapshot_digest == consensus["snapshotDigest"]
        and _mesh_merkle_root(
            [item["eventId"] for item in consensus["peerAttestations"]]
        ) == consensus["merkleRoot"]
        and abs(expected_score - consensus["quorumScore"]) < 1e-12
    )


__all__ = [
    "BitcoinStratigraphyClient",
    "StreamSubscription",
    "WalletAdapter",
    "SettlementAsset",
    "ZkPublicInputs",
    "ZkProof",
    "ZkVerifyResponse",
    "MeshPeerAttestation",
    "MeshConsensus",
    "MeshStatus",
    "validate_mesh_consensus",
    "PaidStratigraphyResponse",
    "StratigraphyTelemetryEnvelope",
]