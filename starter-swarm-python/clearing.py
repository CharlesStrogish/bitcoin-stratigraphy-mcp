"""Isolated A2A tools over the pinned SDK transport and shared payment armor."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import time
import uuid

import httpx
from coincurve import PublicKey
from bitcoinstratigraphy_agent_yield.provenance import verify_payload
from bitcoinstratigraphy_agent_yield.protocol import PROTOCOL_VERSION, read_rpc
from bitcoinstratigraphy_agent_yield.invoices import decode_invoice, verify_preimage

CREATE = "clearing.create_contract"
SETTLE = "clearing.settle_contract"
VERIFIER_PENDING = (
    "The ZK execution verifier is pending deployment. "
    "This contract has not been settled and no ZK-Indemnity Receipt was issued."
)
SAFE_FAILURE = (
    "Clearing request could not be confirmed. Inspect the private SDK ledger; "
    "do not delete it or blindly retry an uncertain payment."
)


class ClearingTools:
    """No changes to FiduciaryClient.call_tool, its data registry, or get_escrow."""

    def __init__(self, client, nwc_wallet=None):
        self.client = client
        # A separate payer view shares durable/session budgets, HTTP transport
        # and identity, but NEVER replaces the original data-tools' LND wallet.
        self._funding = copy.copy(client)
        self._funding.wallet = nwc_wallet
        self._funding._owns_http = False
        self.registry = {CREATE: self.create_contract, SETTLE: self.settle_contract}
        with client.state.transaction() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS clearing_requests (
                job TEXT PRIMARY KEY, body TEXT NOT NULL,
                contract TEXT, funded_escrow_id TEXT
            )""")

    def _body(self, name: str, args: dict) -> bytes:
        return json.dumps(
            {
                "jsonrpc": "2.0",
                "id": uuid.uuid4().hex,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": args,
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            },
            separators=(",", ":"),
            allow_nan=False,
        ).encode()

    def _headers(self, name: str):
        headers = httpx.Headers(self.client._headers)
        for key in (
            "Authorization",
            "X-Nostr-Authorization",
            "PAYMENT-SIGNATURE",
            "X-Payment",
        ):
            headers.pop(key, None)
        headers.update(
            {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "MCP-Protocol-Version": PROTOCOL_VERSION,
                "Mcp-Method": "tools/call",
                "Mcp-Name": name,
            }
        )
        return headers

    def _send(self, name: str, body: bytes):
        signer = self.client.yield_settings.signer
        if signer is None:
            raise ValueError("NIP-98 identity required")
        headers = self._headers(name)
        headers.update(signer.headers(self.client.url, "POST", body))
        return self.client._send(self.client.url, body, headers)

    def _creation(self, response, body: bytes, amount: int) -> dict:
        if not response.is_success:
            raise ValueError("Clearing contract creation unavailable")
        verify_payload(response, body, self.client.server_public_key)
        result = read_rpc(response, json.loads(body)["id"])
        if not isinstance(result, dict) or result.get("isError"):
            raise ValueError("Invalid clearing result")
        data = result.get("structuredContent")
        if (
            not isinstance(data, dict)
            or str(uuid.UUID(data["escrow_id"])) != data["escrow_id"]
            or data.get("status") != "pending"
            or type(data.get("amount_sats")) is not int
            or data["amount_sats"] != amount
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,24000}", data.get("macaroon", ""))
        ):
            raise ValueError("Invalid clearing quote")
        invoice = decode_invoice(data["invoice"])
        if (
            invoice.payment_hash != data.get("payment_hash")
            or invoice.amount_msats != amount * 1000
            or invoice.expires_at <= time.time() + self.client.timeout + 5
        ):
            raise ValueError("Invalid clearing invoice")
        return data

    def create_contract(
        self, worker_pubkey: str, task_hash: str, amount_sats: int
    ) -> str:
        """Create and silently fund a contract; return only its escrow ID.

        Funding spends real sats even while execution settlement is disabled.
        Repeating the same buyer/worker/task/amount resumes the same contract.
        """
        try:
            if not re.fullmatch(r"[0-9a-f]{64}", worker_pubkey):
                raise ValueError
            PublicKey(bytes.fromhex("02" + worker_pubkey))
            if (
                not re.fullmatch(r"[0-9a-f]{64}", task_hash)
                or type(amount_sats) is not int
                or amount_sats <= 0
            ):
                raise ValueError
            signer = self.client.yield_settings.signer
            if signer is None or self._funding.wallet is None:
                return "Clearing funding requires an agent NIP-98 identity and NWC_URI."
            args = {
                "worker_pubkey": worker_pubkey,
                "task_hash": task_hash,
                "amount_sats": amount_sats,
            }
            job = hashlib.sha256(
                json.dumps(
                    [self.client.url, signer.public_key, args],
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
            with self.client.state.transaction() as db:
                db.execute(
                    "INSERT OR IGNORE INTO clearing_requests(job,body) VALUES (?,?)",
                    (job, self._body(CREATE, args).decode()),
                )
                saved = dict(
                    db.execute(
                        "SELECT * FROM clearing_requests WHERE job=?", (job,)
                    ).fetchone()
                )
            if saved["funded_escrow_id"]:
                return saved["funded_escrow_id"]
            body = saved["body"].encode()
            # The server's invoice is returned in a successful signed MCP result.
            # Cache that exact result before wallet I/O, so a paid retry does not
            # depend on an invoice that the server now considers expired.
            if saved["contract"]:
                data = json.loads(saved["contract"])
                try:
                    paid = self.client.state.payment(data["payment_hash"])
                except Exception:
                    paid = None
                if paid is not None:
                    headers = self._headers(CREATE)
                    binding_headers = sorted(
                        (k, v)
                        for k, v in headers.multi_items()
                        if k not in ("authorization", "x-nostr-authorization")
                    )
                    binding = hashlib.sha256(
                        f"POST\n{self.client.url}\n".encode()
                        + body
                        + json.dumps(binding_headers).encode()
                    ).hexdigest()
                    if (
                        paid["binding"] != binding
                        or paid["invoice"] != data["invoice"]
                        or paid["macaroon"] != data["macaroon"]
                        or paid["amount"] != amount_sats * 1000
                        or not verify_preimage(paid["preimage"], data["payment_hash"])
                    ):
                        raise ValueError("Invalid stored payment proof")
                    self._funded(job, data["escrow_id"])
                    return data["escrow_id"]
            self.client.circuit.assert_capacity()
            if amount_sats * 1000 > self.client.limit:
                raise ValueError("Payment exceeds configured limit")
            if not saved["contract"]:
                data = self._creation(self._send(CREATE, body), body, amount_sats)
                with self.client.state.transaction() as db:
                    # A concurrent server response must not replace this quote.
                    db.execute(
                        "UPDATE clearing_requests SET contract=? WHERE job=? AND contract IS NULL",
                        (json.dumps(data, separators=(",", ":")), job),
                    )
                    data = json.loads(
                        db.execute(
                            "SELECT contract FROM clearing_requests WHERE job=?", (job,)
                        ).fetchone()[0]
                    )
            # Reuse the SDK's exact-amount, hash-bound, cross-process payment
            # admission. Do not call its paid data tool or 21% yield claim paths.
            challenge = httpx.Response(
                402,
                headers={
                    "WWW-Authenticate": f'L402 macaroon="{data["macaroon"]}", invoice="{data["invoice"]}"',
                },
                json={
                    key: data[key]
                    for key in ("macaroon", "invoice", "payment_hash", "amount_sats")
                },
            )
            self._funding._payment(challenge, body, self._headers(CREATE))
            paid = self.client.state.payment(data["payment_hash"])
            if not verify_preimage(paid["preimage"], data["payment_hash"]):
                raise ValueError("Invalid payment proof")
            self._funded(job, data["escrow_id"])
            return data["escrow_id"]
        except Exception:
            return SAFE_FAILURE

    def _funded(self, job: str, escrow_id: str):
        with self.client.state.transaction() as db:
            db.execute(
                "UPDATE clearing_requests SET funded_escrow_id=? WHERE job=?",
                (escrow_id, job),
            )

    def settle_contract(self, escrow_id: str, execution_trace: str) -> str:
        """Request worker settlement; report pending verification without raising."""
        try:
            if (
                str(uuid.UUID(escrow_id)) != escrow_id
                or not isinstance(execution_trace, str)
                or not 0 < len(execution_trace) <= 65536
            ):
                raise ValueError
            body = self._body(
                SETTLE, {"escrow_id": escrow_id, "execution_trace": execution_trace}
            )
            response = self._send(SETTLE, body)
            if response.status_code == 503:
                envelope = response.json()
                if (
                    isinstance(envelope, dict)
                    and envelope.get("jsonrpc") == "2.0"
                    and envelope.get("id") == json.loads(body)["id"]
                    and "result" not in envelope
                    and isinstance(envelope.get("error"), dict)
                    and envelope["error"].get("message")
                    == "CLEARING_EXECUTION_VERIFIER_UNAVAILABLE"
                ):
                    return VERIFIER_PENDING
            # No verifier/receipt contract is defined in this scaffold. Do not
            # turn an arbitrary 200 or a caller-supplied "verified" flag into success.
            return "Clearing settlement was not confirmed. No verified ZK receipt is available."
        except Exception:
            return SAFE_FAILURE

    def langchain_tools(self):
        """Framework-safe names retain exact dotted MCP names in metadata."""
        from langchain_core.tools import StructuredTool

        return [
            StructuredTool.from_function(
                func=fn,
                name=name.replace(".", "_"),
                description=fn.__doc__ or name,
                metadata={"canonical_name": name},
            )
            for name, fn in self.registry.items()
        ]
