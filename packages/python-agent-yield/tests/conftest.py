import hashlib
import json
import time
import base64
from types import SimpleNamespace

import httpx
import pytest
from bech32 import bech32_encode, convertbits
from coincurve import PrivateKey
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from bitcoinstratigraphy_agent_yield import FiduciaryClient

SIGNING_KEY = Ed25519PrivateKey.generate()
SERVER_PUBLIC_KEY = (
    SIGNING_KEY.public_key()
    .public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    .decode()
)


def signed_transport(transport):
    def send(request):
        response = transport(request)
        if response.is_success:
            response.read()
            prefix = f"bitcoinstratigraphy/payload/v1\n{hashlib.sha256(request.content).hexdigest()}\n".encode()
            response.headers["X-Stratigraphy-Signature"] = (
                "v1,"
                + base64.b64encode(SIGNING_KEY.sign(prefix + response.content)).decode()
            )
        return response

    return send


PREIMAGE = "01" * 32
PAYMENT_HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()
SCHEMA = {
    "type": "object",
    "properties": {"height": {"type": "integer", "minimum": 0}},
    "required": ["height"],
    "additionalProperties": False,
}
CATALOG = [
    {
        "name": "stratigraphy.list",
        "description": "Free catalog",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {"name": "proof.verify", "description": "Paid verification", "inputSchema": SCHEMA},
]


def make_invoice(
    amount_msats=100000,
    *,
    payment_hash=PAYMENT_HASH,
    network="bc",
    date=None,
    expiry=3600,
    explicit_payee=False,
    wrong_payee=False,
):
    """Locally signed synthetic BOLT11; not connected to a real Lightning node."""

    def integer_words(value):
        result = []
        while value:
            result.insert(0, value & 31)
            value >>= 5
        return result or [0]

    def tag(number, data):
        return [number, len(data) // 32, len(data) % 32, *data]

    key = PrivateKey(bytes.fromhex("11" * 32))
    hrp = f"ln{network}{amount_msats * 10}p"
    timestamp = int(time.time()) if date is None else date
    words = [(timestamp >> (5 * shift)) & 31 for shift in range(6, -1, -1)]
    words += tag(1, convertbits(bytes.fromhex(payment_hash), 8, 5, True))
    words += tag(13, convertbits(b"synthetic SDK test invoice", 8, 5, True))
    words += tag(6, integer_words(expiry))
    if explicit_payee or wrong_payee:
        payee = (
            PrivateKey(bytes.fromhex("12" * 32)).public_key
            if wrong_payee
            else key.public_key
        ).format()
        words += tag(19, convertbits(payee, 8, 5, True))
    digest = hashlib.sha256(
        hrp.encode() + bytes(convertbits(words, 5, 8, True))
    ).digest()
    signature = key.sign_recoverable(digest, hasher=None)
    return bech32_encode(hrp, words + convertbits(signature, 8, 5, True))


@pytest.fixture
def setup_client(tmp_path):
    opened = []

    def setup(**options):
        calls, payments, claims, errors, events = [], [], [], [], []
        invoice = make_invoice()

        class Wallet:
            def pay_invoice(self, text):
                payments.append(text)
                if options.get("uncertain"):
                    raise RuntimeError("wallet-secret-never-reflect")
                if options.get("on_pay"):
                    options["on_pay"]()
                return {
                    "preimage": "02" * 32 if options.get("bad_proof") else PREIMAGE,
                    "fees_paid": options.get("fees", 0),
                }

            def make_invoice(self, amount):
                if options.get("receive_error"):
                    raise RuntimeError("wallet-secret-never-reflect")
                return {"invoice": make_invoice(options.get("receive_amount", amount))}

        def transport(request):
            payload = json.loads(request.content)
            if request.url.path == "/api/claim-yield":
                claims.append(payload)
                if options.get("claim_error"):
                    raise httpx.ReadTimeout("secret", request=request)
                status = 202 if options.get("pending") else 200
                return httpx.Response(
                    status,
                    json={
                        "status": "PENDING" if options.get("pending") else "SETTLED",
                        "payment_sent": options.get(
                            "payment_sent", not options.get("pending")
                        ),
                    },
                )
            calls.append(request)
            assert request.headers["MCP-Protocol-Version"] == "2026-07-28"
            assert request.headers["Mcp-Method"] == payload["method"]
            assert (
                payload["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"]
                == "2026-07-28"
            )
            if payload["method"] == "tools/list":
                if options.get("discovery_402"):
                    return httpx.Response(402, json={"error": "pay"})
                page = options.get("page")
                return httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "result": page(payload["params"])
                        if page
                        else {"tools": CATALOG},
                    },
                )
            assert request.headers["Mcp-Name"] == payload["params"]["name"]
            if options.get("pow") and "X-L402-PoW-Nonce" not in request.headers:
                return httpx.Response(
                    400,
                    json={
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "error": {
                            "code": 400,
                            "data": {
                                "proof_of_work": {
                                    "algorithm": "sha256",
                                    "hash_input": "challenge:nonce",
                                    "difficulty": 2,
                                    "challenge": "python-sdk-test",
                                    "expires_at": "2099-01-01T00:00:00Z",
                                },
                            },
                        },
                    },
                )
            if options.get("redirect"):
                return httpx.Response(
                    307, headers={"Location": "https://evil.invalid/mcp"}
                )
            if options.get("free") or payload["params"]["name"] == "stratigraphy.list":
                return httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "result": {"content": [{"type": "text", "text": "free"}]},
                    },
                    headers={
                        "X-Genesis-Grant": "9 calls remaining before L402 activation"
                    },
                )
            authorization = request.headers.get("authorization", "")
            if authorization != f"L402 synthetic-macaroon:{PREIMAGE}" or options.get(
                "repeat_402"
            ):
                quote = {
                    "macaroon": "synthetic-macaroon",
                    "invoice": invoice,
                    "payment_hash": PAYMENT_HASH,
                    "amount_sats": 100,
                    **options.get("quote", {}),
                }
                data = (
                    quote
                    if options.get("legacy")
                    else {
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "error": {"code": 402, "data": quote},
                    }
                )
                return httpx.Response(
                    402,
                    json=data,
                    headers={
                        "WWW-Authenticate": options.get("challenge")
                        or f'L402 macaroon="synthetic-macaroon", invoice="{invoice}"',
                    },
                )
            assert authorization == f"L402 synthetic-macaroon:{PREIMAGE}"
            reply = {
                "jsonrpc": "2.0",
                "id": "wrong" if options.get("wrong_id") else payload["id"],
                "result": {
                    "content": [],
                    "structuredContent": {"verified": True},
                    **({"isError": True} if options.get("tool_error") else {}),
                },
            }
            if options.get("sse"):
                return httpx.Response(
                    200,
                    text=": heartbeat\n\ndata: " + json.dumps(reply) + "\n\n",
                    headers={"Content-Type": "text/event-stream"},
                )
            return httpx.Response(200, json=reply)

        http = httpx.Client(transport=httpx.MockTransport(signed_transport(transport)))
        opened.append(http)
        policy = {
            "server_public_key": SERVER_PUBLIC_KEY,
            "wallet": Wallet(),
            "max_payment_sats": 500,
            "max_total_sats": 5000,
            "state_directory": str(tmp_path / str(len(opened))),
            "http_client": http,
            "on_error": errors.append,
            "on_yield_claim": events.append,
            **options.get("policy", {}),
        }
        client = FiduciaryClient(**policy)
        return SimpleNamespace(
            client=client,
            policy=policy,
            calls=calls,
            payments=payments,
            claims=claims,
            errors=errors,
            events=events,
            invoice=invoice,
            options=options,
        )

    yield setup
    for http in opened:
        http.close()
