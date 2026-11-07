"""Release regressions for native clients/adapters; no network or real payments."""

import asyncio
import base64
import hashlib
import json
from unittest.mock import patch

import httpx
import pytest
from coincurve import PublicKeyXOnly

from bitcoinstratigraphy_agent_yield import (
    ESCROW_TOOL,
    FiduciaryClient,
    Nip98Signer,
    YieldSettings,
    YieldStakingClient,
    __version__,
    with_fiduciary_yield,
)
from conftest import CATALOG, SERVER_PUBLIC_KEY, signed_transport

UTILITY = {
    "name": ESCROW_TOOL,
    "description": "Read the authenticated signer's escrow.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}


def assert_identity(request, signer):
    event = json.loads(base64.b64decode(request.headers["X-Nostr-Authorization"][6:]))
    unsigned = [0, event["pubkey"], event["created_at"], 27235, event["tags"], ""]
    digest = hashlib.sha256(
        json.dumps(unsigned, separators=(",", ":"), ensure_ascii=False).encode()
    ).digest()
    assert event["id"] == digest.hex()
    assert PublicKeyXOnly(bytes.fromhex(event["pubkey"])).verify(
        bytes.fromhex(event["sig"]), digest
    )
    assert event["pubkey"] == signer.public_key
    tags = dict(event["tags"])
    assert tags["u"] == str(request.url)
    assert tags["method"] == request.method
    assert tags["payload"] == hashlib.sha256(request.content).hexdigest()
    return event["id"]


@pytest.mark.parametrize("client_type", [FiduciaryClient, YieldStakingClient])
def test_native_exports_and_free_sync_async_lookup(tmp_path, client_type):
    assert __version__ == "1.1.0"
    signer = Nip98Signer("11" * 32)
    data = {
        "pubkey": signer.public_key,
        "staked_sats": 10001,
        "vip_status": True,
        "unlocked_features": ["zero_latency_routing"],
    }
    requests = []

    def respond(request):
        requests.append(request)
        body = json.loads(request.content)
        assert body["method"] == "tools/call"
        assert body["params"]["name"] == ESCROW_TOOL
        assert body["params"]["arguments"] == {}
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": {"structuredContent": data},
            },
        )

    with httpx.Client(transport=httpx.MockTransport(signed_transport(respond))) as http:
        with client_type(
            yield_settings=YieldSettings("stake", signer),
            http_client=http,
            state_directory=str(tmp_path),
            server_public_key=SERVER_PUBLIC_KEY,
            max_spend_sats=0,
        ) as client:
            assert client.get_escrow() == data
            assert client.call_tool(ESCROW_TOOL, {}).payload == data
            assert asyncio.run(client.acall_tool(ESCROW_TOOL, {})).payload == data
            assert client.circuit.remaining_msats == 0
    assert len({assert_identity(r, signer) for r in requests}) == 3
    assert all(r.headers["X-Yield-Mode"] == "stake" for r in requests)


@pytest.mark.parametrize("mode", ["withdraw", "stake"])
@pytest.mark.parametrize("pow_required", [False, True])
def test_native_payment_identity_claim_policy_and_pow(setup_client, mode, pow_required):
    signer = Nip98Signer("11" * 32)
    fixture = setup_client(
        policy={"yield_settings": YieldSettings(mode, signer)},
        page=lambda params: {"tools": [*CATALOG, UTILITY]},
        pow=pow_required,
    )
    with patch.object(
        fixture.client.wallet, "make_invoice", wraps=fixture.client.wallet.make_invoice
    ) as receiving:
        assert fixture.client.call_tool("proof.verify", {"height": 1}).payload == {
            "verified": True
        }
    assert len(fixture.payments) == 1
    assert len(fixture.claims) == receiving.call_count == (0 if mode == "stake" else 1)
    assert not fixture.errors
    for request in fixture.calls:
        assert request.headers["X-Yield-Mode"] == mode
    attempts = [r for r in fixture.calls if r.headers["Mcp-Method"] == "tools/call"]
    assert len(attempts) == (3 if pow_required else 2)
    assert len({r.content for r in attempts}) == 1
    assert len({assert_identity(r, signer) for r in attempts}) == len(attempts)


def test_framework_adapters_use_the_native_staking_client(setup_client):
    fixture = setup_client(
        policy={"yield_settings": YieldSettings("stake", Nip98Signer("11" * 32))},
        page=lambda params: {"tools": [*CATALOG, UTILITY]},
    )
    config = with_fiduciary_yield({"fiduciary": fixture.policy})
    try:
        assert isinstance(config["fiduciary"], FiduciaryClient)
        assert config["fiduciary"].yield_settings.mode == "stake"
        escrow = next(t for t in config["tools"] if t.canonical_name == ESCROW_TOOL)
        assert escrow.client is config["fiduciary"]
        assert not fixture.payments and not fixture.claims
    finally:
        config["fiduciary"].close()
