import hashlib
import json
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from bitcoinstratigraphy_agent_yield import (
    CircuitBreakerError,
    FiduciaryClient,
    TruthReceipt,
)
from bitcoinstratigraphy_agent_yield.armor import SpendCircuit
from conftest import make_invoice


def client(tmp_path, limit=5000, uncertain=False):
    counts = {"http": 0, "payments": 0}
    invoices = {}

    class Wallet:
        def pay_invoice(self, text):
            counts["payments"] += 1
            if uncertain:
                raise RuntimeError("unknown outcome")
            return {"preimage": invoices[text]}

    def transport(request):
        counts["http"] += 1
        body = json.loads(request.content)
        if body["method"] == "tools/list":
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {
                        "tools": [
                            {"name": "proof.verify", "inputSchema": {"type": "object"}}
                        ]
                    },
                },
            )
        if "authorization" not in request.headers:
            preimage = hashlib.sha256(body["id"].encode()).hexdigest()
            payment_hash = hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
            text = make_invoice(payment_hash=payment_hash)
            invoices[text] = preimage
            quote = {
                "invoice": text,
                "macaroon": "synthetic",
                "payment_hash": payment_hash,
                "amount_sats": 100,
            }
            return httpx.Response(
                402,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "error": {"code": 402, "data": quote},
                },
                headers={
                    "WWW-Authenticate": f'L402 macaroon="synthetic", invoice="{text}"'
                },
            )
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": {"structuredContent": {"verified": True}},
            },
        )

    http = httpx.Client(transport=httpx.MockTransport(transport))
    sdk = FiduciaryClient(
        wallet=Wallet(),
        max_spend_sats=limit,
        max_payment_sats=500,
        max_total_sats=10000,
        fee_reserve_sats=0,
        state_directory=str(tmp_path),
        http_client=http,
    )
    return sdk, http, counts


def test_receipt_payment_proof_and_cost(tmp_path):
    sdk, http, _ = client(tmp_path)
    with http:
        receipt = sdk.call_tool("proof.verify", {})
    assert isinstance(receipt, TruthReceipt)
    assert receipt.payload == {"verified": True}
    assert receipt.thermodynamic_cost == "100"
    assert receipt.timestamp.endswith("Z")
    assert (
        hashlib.sha256(bytes.fromhex(receipt.cryptographic_proof)).hexdigest()
        == receipt["payment_hash"]
    )
    assert receipt["evidence_scope"] == "payment_only"
    assert json.loads(json.dumps(receipt))["payload"] == receipt.payload


def test_loop_halts_before_any_further_network_or_payment(tmp_path):
    sdk, http, counts = client(tmp_path, 200)
    with http:
        for _ in range(2):
            sdk.call_tool("proof.verify", {})
        before = dict(counts)
        for _ in range(20):
            with pytest.raises(
                CircuitBreakerError,
                match=r"^Maximum authorized thermodynamic spend reached\.$",
            ):
                sdk.call_tool("proof.verify", {})
        assert counts == before and counts["payments"] == 2


def test_oversized_quote_latches_before_payment_or_retry(tmp_path):
    sdk, http, counts = client(tmp_path, 50)
    with http:
        with pytest.raises(CircuitBreakerError):
            sdk.call_tool("proof.verify", {})
        assert counts == {"http": 2, "payments": 0}
        with pytest.raises(CircuitBreakerError):
            sdk.call_tool("proof.verify", {})
        assert counts == {"http": 2, "payments": 0}


def test_parallel_calls_cannot_overspend_session(tmp_path):
    sdk, http, counts = client(tmp_path, 100)

    def call(_):
        try:
            sdk.call_tool("proof.verify", {})
            return True
        except CircuitBreakerError:
            return False

    with http, ThreadPoolExecutor(max_workers=8) as executor:
        assert sum(executor.map(call, range(8))) == 1
    assert counts["payments"] == 1


def test_uncertain_payment_keeps_session_reserved(tmp_path):
    sdk, http, counts = client(tmp_path, 100, True)
    with http:
        with pytest.raises(RuntimeError, match="PAYMENT_UNCERTAIN"):
            sdk.call_tool("proof.verify", {})
        before = dict(counts)
        with pytest.raises(CircuitBreakerError):
            sdk.call_tool("proof.verify", {})
        assert counts == before


def test_default_zero_precise_cost_and_unpaid_receipts():
    assert SpendCircuit().remaining_msats == 5000000
    with pytest.raises(CircuitBreakerError):
        SpendCircuit(0).assert_capacity()
    receipt = TruthReceipt(
        {}, {"amount": 21001, "preimage": "p", "hash": "h", "settled_at": None}
    )
    assert receipt.thermodynamic_cost == "21.001" and receipt.timestamp is None
    free = TruthReceipt({"free": True})
    assert free.cryptographic_proof is None and free.thermodynamic_cost == "0"


@pytest.mark.parametrize("bad", [-1, 1.5, "5000", True])
def test_invalid_session_limits(bad):
    with pytest.raises(RuntimeError, match="INVALID_MAX_SPEND_SATS"):
        SpendCircuit(bad)


def test_fee_headroom_and_excess_fees_latch_session():
    circuit = SpendCircuit(110)
    circuit.reserve("invoice", 110000)
    circuit.settle("invoice", 100000)
    assert circuit.remaining_msats == 10000
    circuit.settle("invoice", 111000)
    assert circuit.remaining_msats == 0
    with pytest.raises(CircuitBreakerError):
        circuit.assert_capacity()


def test_legacy_private_database_upgrade_does_not_invent_settlement_time(tmp_path):
    import sqlite3
    from bitcoinstratigraphy_agent_yield.state import PaymentState

    with sqlite3.connect(tmp_path / "payments.sqlite3") as db:
        db.execute("""CREATE TABLE invoices (
            hash TEXT PRIMARY KEY, binding TEXT NOT NULL, invoice TEXT NOT NULL,
            macaroon TEXT NOT NULL, amount INTEGER NOT NULL, reserved INTEGER NOT NULL,
            status TEXT NOT NULL, preimage TEXT, claim_status TEXT, claim_body TEXT
        )""")
        db.execute(
            "INSERT INTO invoices VALUES (?,?,?,?,?,?,'paid',?,NULL,NULL)",
            ("hash", "binding", "invoice", "macaroon", 100000, 110000, "proof"),
        )
    state = PaymentState(str(tmp_path), "https://bitcoinstratigraphy.com/mcp")
    evidence = state.payment("hash")
    assert evidence["settled_at"] is None
    assert evidence["preimage"] == "proof"
    assert TruthReceipt({"data": True}, evidence).timestamp is None
