import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from bitcoinstratigraphy_agent_yield import FiduciaryClient, FiduciaryTamperingError
from conftest import SERVER_PUBLIC_KEY, signed_transport


@pytest.mark.parametrize(
    "mode",
    [
        "valid",
        "tampered",
        "missing",
        "malformed",
        "wrong-key",
        "no-pin",
        "wrong-request",
        "sse",
    ],
)
def test_strict_payload_provenance(tmp_path, mode):
    def transport(request):
        import json

        body = json.loads(request.content)
        result = (
            {"tools": [{"name": "free", "inputSchema": {"type": "object"}}]}
            if body["method"] == "tools/list"
            else {"structuredContent": {"amount": 21, "unicode": "₿"}, "content": []}
        )
        reply = {"jsonrpc": "2.0", "id": body["id"], "result": result}
        if mode == "sse" and body["method"] == "tools/call":
            return httpx.Response(
                200,
                content=f"data: {json.dumps(reply)}\n\n",
                headers={"Content-Type": "text/event-stream"},
            )
        return httpx.Response(200, json=reply)

    signed = signed_transport(transport)

    def altered(request):
        response = signed(request)
        if mode == "missing":
            del response.headers["X-Stratigraphy-Signature"]
        if mode == "malformed":
            response.headers["X-Stratigraphy-Signature"] = "v1,invalid"
        content = response.content
        if mode == "tampered":
            content = content.replace(b'"amount":21', b'"amount":22')
        if mode == "wrong-request":
            # A valid signature for different request bytes cannot be replayed.
            response = signed(
                httpx.Request("POST", request.url, content=request.content + b" ")
            )
            content = response.content
        return httpx.Response(200, content=content, headers=response.headers)

    public_key = SERVER_PUBLIC_KEY
    if mode == "no-pin":
        public_key = None
    if mode == "wrong-key":
        public_key = (
            Ed25519PrivateKey.generate()
            .public_key()
            .public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
        )
    with httpx.Client(transport=httpx.MockTransport(altered)) as http:
        client = FiduciaryClient(
            server_public_key=public_key,
            http_client=http,
            state_directory=str(tmp_path),
        )
        if mode in ("valid", "sse"):
            receipt = client.call_tool("free")
            assert receipt["provenance_verified"] is True
            assert receipt.provenance_verified is True
            assert receipt.payload == {"amount": 21, "unicode": "₿"}
        else:
            with pytest.raises(
                FiduciaryTamperingError,
                match=r"^Data payload signature verification failed\.$",
            ):
                client.call_tool("free")
