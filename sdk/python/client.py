"""Zero-required-dependency MCP client; uses urllib3 when available, otherwise stdlib."""

from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

try:
    import urllib3
except ImportError:
    urllib3 = None


DEFAULT_MCP_SERVER_URL = "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"
WalletHandler = Callable[[str], str | Mapping[str, Any]]
_CHALLENGE = re.compile(r'L402\s+macaroon="([^"\r\n]+)",\s*invoice="([^"\r\n]+)"', re.I)
_PREIMAGE = re.compile(r"[0-9a-fA-F]{64}")
_PAYMENT_HASH = re.compile(r"[0-9a-fA-F]{64}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: Any, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


class BitcoinStratigraphyClient:
    """Call MCP tools; pay one path-bound, single-use L402 invoice per paid call."""

    def __init__(
        self,
        server_url: str = DEFAULT_MCP_SERVER_URL,
        wallet: WalletHandler | None = None,
        timeout: float = 30.0,
    ) -> None:
        if urlsplit(server_url).scheme not in ("http", "https"):
            raise ValueError("MCP server URL must use HTTP or HTTPS")
        self.server_url = server_url
        self.wallet = wallet
        self.timeout = timeout
        self._next_id = 0
        self._http = urllib3.PoolManager() if urllib3 is not None else None
        self._opener = urllib.request.build_opener(_NoRedirect())

    def list_tools(self) -> list[dict[str, Any]]:
        result = self._request("tools/list")
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, list):
            raise ValueError("Invalid MCP tools/list response")
        return tools

    def call_tool(self, name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        result = self._request("tools/call", {"name": name, "arguments": dict(arguments)})
        if not isinstance(result, dict):
            raise ValueError("Invalid MCP tools/call response")
        if result.get("isError"):
            content = result.get("content") or []
            detail = next((item.get("text") for item in content
                           if isinstance(item, dict) and item.get("type") == "text"), None)
            raise RuntimeError(detail or f"{name} failed")
        structured = result.get("structuredContent")
        if not isinstance(structured, dict):
            raise ValueError(f"Missing structuredContent from {name}")
        return structured

    def get_telemetry(self, **filters: Any) -> dict[str, Any]:
        return self.call_tool("stratigraphy.get", filters)

    def list_stratigraphy(self) -> dict[str, Any]:
        return self.call_tool("stratigraphy.list", {})

    def verify_proof(
        self, proof: str, public_inputs: Mapping[str, Any],
        verification_key_id: str, data: Any,
    ) -> dict[str, Any]:
        return self.call_tool("proof.verify", {
            "proof": proof, "publicInputs": dict(public_inputs),
            "verificationKeyId": verification_key_id, "data": data,
        })

    def get_proof_status(
        self, *, proof_hash: str | None = None,
        snapshot_digest: str | None = None, receipt_hash: str | None = None,
    ) -> dict[str, Any]:
        selectors = [
            ("proofHash", proof_hash),
            ("snapshotDigest", snapshot_digest),
            ("receiptHash", receipt_hash),
        ]
        selected = [(key, value) for key, value in selectors if value is not None]
        if len(selected) != 1:
            raise ValueError(
                "Provide exactly one proof_hash, snapshot_digest, or receipt_hash"
            )
        return self.call_tool("proof.get_status", {selected[0][0]: selected[0][1]})

    def list_proofs(self, *, limit: int = 20, offset: int = 0,
                    status: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"limit": limit, "offset": offset}
        if status is not None:
            args["status"] = status
        return self.call_tool("proof.list", args)

    def submit_proof(self, proof: Mapping[str, Any], public_signals: list[str],
                     snapshot_digest: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"proof": dict(proof), "publicSignals": public_signals}
        if snapshot_digest is not None:
            args["snapshotDigest"] = snapshot_digest
        return self.call_tool("proof.submit", args)

    def ground_proof(self, context_hash: str, agent_id: str,
                     metadata: Mapping[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"contextHash": context_hash, "agentId": agent_id}
        if metadata is not None:
            args["metadata"] = dict(metadata)
        return self.call_tool("proof.ground", args)

    def issue_epistemic_receipt(
        self, cid: str, *, nostr_event_id: str | None = None,
        context: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"cid": cid}
        if nostr_event_id is not None:
            args["nostrEventId"] = nostr_event_id
        if context is not None:
            args["context"] = dict(context)
        return self.call_tool("proof.issue_receipt", args)

    def get_mesh_status(self) -> dict[str, Any]:
        return self.call_tool("mesh.get_status", {})

    def broadcast_mesh_signal(self, date: str) -> dict[str, Any]:
        return self.call_tool("mesh.broadcast", {
            "signalType": "telemetry_snapshot", "payload": {"date": date},
        })

    def _request(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        self._next_id += 1
        request_id = self._next_id
        body: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            body["params"] = dict(params)
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        status, headers, data = self._send(encoded)
        if status == 402:
            macaroon, invoice, payment_hash = self._parse_challenge(headers, data)
            if self.wallet is None:
                raise RuntimeError(f"L402 payment required for {method}; provide a wallet callback")
            paid = self.wallet(invoice)
            if isinstance(paid, str):
                preimage = paid
            elif isinstance(paid, Mapping):
                preimage = paid.get("preimage") or paid.get("payment_preimage")
            else:
                preimage = None
            if not isinstance(preimage, str) or not _PREIMAGE.fullmatch(preimage):
                raise ValueError("Wallet did not return a 32-byte hex payment preimage")
            digest = hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
            if digest != payment_hash.lower():
                raise ValueError("Wallet preimage does not match the L402 payment hash")
            status, _, data = self._send(encoded, f"L402 {macaroon}:{preimage.lower()}")
            if status == 402:
                raise RuntimeError("L402 payment was rejected; not paying again")
        if not 200 <= status < 300:
            raise RuntimeError(f"MCP HTTP {status}: {data.decode('utf-8', errors='replace')}")
        try:
            envelope = json.loads(data)
        except (ValueError, UnicodeDecodeError) as exc:
            raise ValueError("Invalid MCP JSON response") from exc
        if not isinstance(envelope, dict) or envelope.get("jsonrpc") != "2.0" or envelope.get("id") != request_id:
            raise ValueError("Invalid MCP JSON-RPC response")
        if "error" in envelope:
            error = envelope["error"]
            raise RuntimeError(f"MCP {error.get('code')}: {error.get('message')}")
        if "result" not in envelope:
            raise ValueError("MCP response has no result")
        return envelope["result"]

    @staticmethod
    def _parse_challenge(headers: Mapping[str, str], data: bytes) -> tuple[str, str, str]:
        header = next((value for key, value in headers.items()
                       if key.lower() == "www-authenticate"), "")
        match = _CHALLENGE.fullmatch(header)
        if not match:
            raise ValueError("HTTP 402 did not include an L402 WWW-Authenticate challenge")
        try:
            body = json.loads(data)
        except (ValueError, UnicodeDecodeError) as exc:
            raise ValueError("Invalid L402 challenge JSON") from exc
        if (not isinstance(body, dict) or body.get("macaroon") != match[1]
                or body.get("invoice") != match[2] or not match[2].startswith("ln")
                or not isinstance(body.get("payment_hash"), str)
                or not _PAYMENT_HASH.fullmatch(body["payment_hash"])):
            raise ValueError("Invalid or conflicting L402 challenge")
        return match[1], match[2], body["payment_hash"]

    def _send(self, body: bytes, authorization: str | None = None
              ) -> tuple[int, Mapping[str, str], bytes]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
        }
        if authorization:
            headers["Authorization"] = authorization
        if self._http is not None:
            response = self._http.request(
                "POST", self.server_url, body=body, headers=headers,
                timeout=self.timeout, retries=False, redirect=False,
            )
            try:
                return response.status, dict(response.headers), response.data
            finally:
                response.release_conn()
        request = urllib.request.Request(
            self.server_url, data=body, headers=headers, method="POST",
        )
        try:
            response = self._opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, dict(response.headers), response.read()


__all__ = ["BitcoinStratigraphyClient", "DEFAULT_MCP_SERVER_URL", "WalletHandler"]