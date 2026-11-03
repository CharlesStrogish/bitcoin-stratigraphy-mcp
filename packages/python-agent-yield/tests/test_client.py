import asyncio
import hashlib
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from bitcoinstratigraphy_agent_yield import (
    FiduciaryClient,
    FiduciaryError,
    with_fiduciary_yield,
)
from bitcoinstratigraphy_agent_yield.protocol import solve_pow
from conftest import PAYMENT_HASH, PREIMAGE


def test_wrapper_preserves_config_and_free_tools(setup_client, capsys):
    s = setup_client()
    existing = object()
    config = {"model": "existing", "tools": [existing], "fiduciary": s.policy}
    wrapped = with_fiduciary_yield(config)
    assert config["tools"] == [existing]
    assert wrapped["tools"][0] is existing
    assert wrapped["model"] == "existing"
    assert wrapped["tools"][1].invoke({}) == [{"type": "text", "text": "free"}]
    assert not s.payments
    assert not capsys.readouterr().out


@pytest.mark.parametrize("mode", [{}, {"legacy": True}, {"sse": True}, {"pow": True}])
def test_payment_and_identical_retry(setup_client, mode, capsys):
    s = setup_client(**mode)
    assert s.client.call_tool("proof.verify", {"height": 42}) == {"verified": True}
    assert len(s.payments) == len(s.claims) == 1
    tool_calls = [r for r in s.calls if r.headers["Mcp-Method"] == "tools/call"]
    assert len({r.content for r in tool_calls}) == 1
    assert (
        tool_calls[-1].headers["authorization"] == f"L402 synthetic-macaroon:{PREIMAGE}"
    )
    assert s.events == [{"status": "settled", "amount_msats": "21000"}]
    captured = capsys.readouterr()
    assert not captured.out
    assert "\x1b[33m" in captured.err and "\x1b[32m" in captured.err
    assert "21 Sats" in captured.err
    assert s.invoice not in captured.err and PREIMAGE not in captured.err


@pytest.mark.parametrize(
    "mode",
    [
        {"pending": True},
        {"payment_sent": False},
        {"claim_error": True},
        {"receive_error": True},
        {"receive_amount": 22000},
    ],
)
def test_no_false_earned_receipts(setup_client, capsys, mode):
    s = setup_client(**mode)
    assert s.client.call_tool("proof.verify", {"height": 1}) == {"verified": True}
    assert len(s.payments) == 1
    output = capsys.readouterr()
    assert "Allocated" in output.err and "Earned" not in output.err
    assert "wallet-secret" not in output.err and not output.out


def test_no_receiving_wallet_means_no_claim(setup_client, capsys):
    s = setup_client()
    s.client.wallet.make_invoice = None
    s.client.call_tool("proof.verify", {})
    assert not s.claims and not capsys.readouterr().err


@pytest.mark.parametrize(
    "options,expected",
    [
        ({"bad_proof": True}, "PAYMENT_PROOF_INVALID"),
        ({"uncertain": True}, "PAYMENT_UNCERTAIN"),
        ({"quote": {"amount_sats": 101}}, "QUOTE_MISMATCH"),
        ({"quote": {"payment_hash": "ff" * 32}}, "QUOTE_MISMATCH"),
        ({"quote": {"macaroon": "different"}}, "QUOTE_MISMATCH"),
        ({"challenge": 'L402 macaroon="m", invoice="bad"'}, "INVALID_MAINNET_INVOICE"),
        ({"policy": {"max_payment_sats": 99}}, "SPENDING_LIMIT_EXCEEDED"),
        ({"policy": {"max_total_sats": 109}}, "SPENDING_LIMIT_EXCEEDED"),
        ({"policy": {"wallet": None}}, "AUTHORIZED_WALLET_REQUIRED"),
        ({"tool_error": True}, "MCP_TOOL_FAILED"),
        ({"wrong_id": True}, "MCP_INVALID_RESPONSE"),
        ({"redirect": True}, "MCP_REDIRECT_REFUSED"),
    ],
)
def test_fail_closed(setup_client, capsys, options, expected):
    s = setup_client(**options)
    with pytest.raises(FiduciaryError, match=expected):
        s.client.call_tool("proof.verify", {"height": 7})
    assert not s.claims
    assert "Earned" not in capsys.readouterr().err


@pytest.mark.parametrize(
    "options",
    [
        {"repeat_402": True},
        {"discovery_402": True},
        {"policy": {"headers": {"Authorization": "L402 existing:proof"}}},
        {"policy": {"headers": {"X-Payment": "existing"}}},
    ],
)
def test_never_repay_or_pay_discovery(setup_client, options):
    s = setup_client(**options)
    with pytest.raises(httpx.HTTPStatusError):
        s.client.call_tool("proof.verify", {})
    assert len(s.payments) == (1 if options.get("repeat_402") else 0)


@pytest.mark.parametrize("failure", ["uncertain", "bad_proof"])
def test_unknown_is_durable_after_restart(setup_client, failure):
    s = setup_client(**{failure: True})
    with pytest.raises(FiduciaryError):
        s.client.call_tool("proof.verify", {})
    restarted = FiduciaryClient(**s.policy)
    # Fix request IDs only for this test so the server's synthetic invoice is
    # the exact same request, like a transport retry after worker replacement.
    with sqlite3.connect(restarted.state.path) as db:
        assert db.execute("SELECT status,reserved FROM invoices").fetchone() == (
            "pending",
            110000,
        )
    with pytest.raises(FiduciaryError, match="PAYMENT_SCOPE_MISMATCH"):
        restarted.call_tool("proof.verify", {})
    assert len(s.payments) == 1


def test_multiple_workers_do_not_double_pay(setup_client):
    s = setup_client()
    clients = [FiduciaryClient(**s.policy) for _ in range(8)]

    def call(client):
        try:
            return client.call_tool("proof.verify", {})
        except FiduciaryError as error:
            return str(error)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(call, clients))
    assert sum(result == {"verified": True} for result in results) == 1
    assert len(s.payments) == 1


def test_oversized_fees_block_further_spending(setup_client):
    s = setup_client(fees=10001)
    s.client.call_tool("proof.verify", {})
    with sqlite3.connect(s.client.state.path) as db:
        assert db.execute("SELECT blocked FROM policy").fetchone()[0] == 1
    with pytest.raises(FiduciaryError, match="SPENDING_LIMIT_EXCEEDED"):
        s.client.state.reserve(
            "ab" * 32, "new", s.invoice, "m", 100000, 10000, 500000, 5000000
        )


def test_async_tools_and_genesis_are_unpaid(setup_client, capsys):
    s = setup_client(free=True)
    assert asyncio.run(s.client.acall_tool("proof.verify", {}))[0]["text"] == "free"
    assert not s.payments and not s.claims and not capsys.readouterr().err


def test_fresh_identity_is_preserved_in_paid_retry(setup_client):
    signed = []

    def signer(url, method, body):
        signed.append((url, method, body))
        return {"Authorization": f"Nostr synthetic-{len(signed)}"}

    s = setup_client(pow=True, policy={"identity_headers": signer})
    s.client.call_tool("proof.verify", {"height": 9})
    requests = [r for r in s.calls if r.headers["Mcp-Method"] == "tools/call"]
    assert len(requests) == 3
    assert requests[0].headers["Authorization"] == "Nostr synthetic-2"
    assert requests[1].headers["Authorization"] == "Nostr synthetic-3"
    assert requests[2].headers["X-Nostr-Authorization"] == "Nostr synthetic-4"
    assert signed[-1][2] == requests[-1].content


def test_recover_only_prepared_claim_and_quiet_at_event_time(
    setup_client, capsys, monkeypatch
):
    s = setup_client(pending=True)
    s.client.call_tool("proof.verify", {})
    capsys.readouterr()
    s.options["pending"] = False
    monkeypatch.setenv("QUIET_STRATIGRAPHY", "true")
    s.client.recover_claim(PAYMENT_HASH)
    assert not capsys.readouterr().err
    assert s.claims[0] == s.claims[1]
    s.client.recover_claim(PAYMENT_HASH)
    assert len(s.payments) == 1 and len(s.claims) == 2
    assert s.events[-1]["status"] == "settled"


def test_receiving_failure_is_not_automatically_recreated(setup_client):
    s = setup_client(receive_error=True)
    s.client.call_tool("proof.verify", {})
    with pytest.raises(FiduciaryError, match="NO_PREPARED_CLAIM"):
        s.client.recover_claim(PAYMENT_HASH)
    assert len(s.payments) == 1


def test_pagination_and_cursor_cycles(setup_client):
    from conftest import CATALOG

    s = setup_client(
        page=lambda p: (
            {"tools": [CATALOG[1]]}
            if p.get("cursor")
            else {"tools": [CATALOG[0]], "nextCursor": "two"}
        )
    )
    assert len(s.client.list_tools()) == 2
    cycle = setup_client(page=lambda p: {"tools": [], "nextCursor": "repeat"})
    with pytest.raises(FiduciaryError, match="INVALID_CURSOR"):
        cycle.client.list_tools()


def test_unknown_tool_does_not_pay(setup_client):
    s = setup_client()
    with pytest.raises(FiduciaryError, match="UNKNOWN_TOOL"):
        s.client.call_tool("does.not.exist", {})
    assert not s.payments


def test_private_storage_and_endpoint_binding(setup_client):
    s = setup_client()
    assert os.stat(s.client.state.path).st_mode & 0o777 == 0o600
    assert os.stat(s.client.state.path.parent).st_mode & 0o777 == 0o700
    with pytest.raises(FiduciaryError, match="STATE_ENDPOINT_MISMATCH"):
        FiduciaryClient(**{**s.policy, "mcp_url": "https://other.invalid/mcp"})


@pytest.mark.parametrize(
    "policy",
    [
        {"max_payment_sats": True},
        {"max_total_sats": -1},
        {"fee_reserve_sats": 0.5},
        {"timeout": 0},
        {"mcp_url": "http://insecure.invalid/mcp"},
    ],
)
def test_policy_validation(setup_client, policy):
    with pytest.raises(FiduciaryError):
        setup_client(policy=policy)


def test_bounded_pow_rejects_unsupported_or_expired():
    with pytest.raises(FiduciaryError, match="UNSUPPORTED"):
        solve_pow({"difficulty": 30})
    with pytest.raises(FiduciaryError, match="EXPIRED"):
        solve_pow(
            {
                "algorithm": "sha256",
                "hash_input": "challenge:nonce",
                "difficulty": 2,
                "challenge": "test",
                "expires_at": "2000-01-01T00:00:00Z",
            }
        )


def test_pow_solution_has_real_hash_prefix(setup_client):
    s = setup_client(pow=True)
    s.client.call_tool("proof.verify", {})
    request = next(r for r in s.calls if "X-L402-PoW-Nonce" in r.headers)
    value = f"{request.headers['X-L402-PoW-Challenge']}:{request.headers['X-L402-PoW-Nonce']}"
    assert hashlib.sha256(value.encode()).hexdigest().startswith("00")


def test_distinct_invoice_reservations_share_atomic_budget(setup_client):
    s = setup_client()

    def reserve(index):
        try:
            s.client.state.reserve(
                f"{index:064x}",
                str(index),
                "signed-test",
                "m",
                100000,
                10000,
                100000,
                330000,
            )
            return True
        except FiduciaryError:
            return False

    with ThreadPoolExecutor(max_workers=8) as executor:
        assert sum(executor.map(reserve, range(1, 9))) == 3
    restarted = FiduciaryClient(**s.policy)
    with pytest.raises(FiduciaryError, match="SPENDING_LIMIT_EXCEEDED"):
        restarted.state.reserve(
            "ff" * 32, "new", "signed-test", "m", 100000, 10000, 100000, 330000
        )


def test_held_sse_connection_is_closed_after_matching_response(setup_client):
    s = setup_client()
    closed = []

    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            yield b": heartbeat\r\n\r\n"
            yield b'data: {"jsonrpc":"2.0","id":"response","result":{"tools":[]}}\r\n\r\n'
            raise AssertionError("Client tried to read past its complete SSE response")

        def close(self):
            closed.append(True)

    with httpx.Client(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200, headers={"Content-Type": "text/event-stream"}, stream=Stream()
            )
        )
    ) as http:
        s.client._http = http
        response = s.client._send(s.client.url, b'{"id":"response"}', {})
        assert response.status_code == 200 and closed


def test_response_limit_and_bad_signer(setup_client):
    s = setup_client(
        policy={
            "identity_headers": lambda *args: {"Authorization": "L402 injected:proof"}
        }
    )
    with pytest.raises(FiduciaryError, match="NIP98_ONLY"):
        s.client.list_tools()
    large = setup_client()
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, content=b"x" * (2 * 1024 * 1024 + 1))
        )
    ) as http:
        large.client._http = http
        with pytest.raises(FiduciaryError, match="RESPONSE_LIMIT"):
            large.client.list_tools()


def test_identity_signer_never_overwrites_existing_payment(setup_client):
    s = setup_client(
        policy={
            "headers": {"Authorization": "L402 existing:proof"},
            "identity_headers": lambda *args: {"Authorization": "Nostr fresh"},
        }
    )
    with pytest.raises(httpx.HTTPStatusError):
        s.client.call_tool("proof.verify", {})
    assert not s.payments
    request = s.calls[-1]
    assert request.headers["Authorization"] == "L402 existing:proof"
    assert request.headers["X-Nostr-Authorization"] == "Nostr fresh"
