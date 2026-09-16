"""Dependency-free Bitcoin Stratigraphy L402 client for Python agents."""

from __future__ import annotations

import json
import hashlib
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol


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
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.wallet = wallet
        self.tier = tier
        self.timeout = timeout
        self._credential: dict[str, Any] | None = None
        self._credential_lock = threading.Lock()

    def get_cost(self) -> dict[str, Any]:
        return self._json_request("/api/v1/cost")

    def get_latest(self) -> list[dict[str, Any]]:
        self.get_cost()
        return self._authorized_json("/api/v1/stratigraphy")

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
        headers: dict[str, str] = {}
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
                path, {"Authorization": self._authorization(credential)}
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
        with self._open(path, {}) as response:
            return json.load(response)

    def _open(self, path: str, headers: Mapping[str, str]):
        request = urllib.request.Request(
            f"{self.base_url}{path}", headers=dict(headers)
        )
        return urllib.request.urlopen(request, timeout=self.timeout)


__all__ = [
    "BitcoinStratigraphyClient",
    "StreamSubscription",
    "WalletAdapter",
]