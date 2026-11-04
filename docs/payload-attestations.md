# Server-signed payload attestations

MCP POST responses carry a separate Ed25519 signature over their exact final
HTTP entity bytes. This complements, and does not replace, the existing signed
tool-result envelopes, tool-description manifest, webhook signatures or L402
payment evidence.

## Server identity

For an explicitly managed identity, configure `STRATIGRAPHY_PAYLOAD_PRIVATE_KEY`
as an Ed25519 PKCS#8 PEM private key in Secrets. Never put it in source control.
Malformed or non-Ed25519 configured keys fail closed rather than generating a
replacement.

Without that setting, the server derives a **separate, domain-separated**
Ed25519 key from its existing persistent `SESSION_SECRET`. This preserves
identity across deployments without reusing the session secret as a signing key.
Without either secret, development/standalone installations use an atomically
created owner-only key under `.keys/payload` (override the directory with
`STRATIGRAPHY_PAYLOAD_KEYS_DIR`). Production refuses the filesystem fallback.

`GET /mcp/payload-key` returns the public SPKI PEM and SHA-256 SPKI DER fingerprint.
An enterprise administrator must authenticate this identity through an
independently trusted channel and distribute the pin to clients. The SDKs never
automatically trust a key supplied by a response or discovery endpoint.

Coordinate private-key or source-secret rotation with new client pin
distribution. The new HTTP signing identity is separate from the existing
manifest/envelope/webhook identity; introducing it does not rotate those keys.

## Wire protocol v1

Header:

```text
X-Stratigraphy-Signature: v1,<base64 Ed25519 signature>
X-Stratigraphy-Key-Id: <lowercase SHA-256 hex of public key SPKI DER>
```

The signed message is this concatenation, with literal LF newlines:

```text
UTF8("bitcoinstratigraphy/payload/v1\n")
+ UTF8(lowercase_hex(SHA256(exact_request_body_bytes)))
+ UTF8("\n")
+ exact_response_body_bytes
```

Response bytes include the full JSON-RPC wrapper, errors, metadata and all
results in a batch/pipeline. The protocol signs entity bytes before any HTTP
transfer/content compression. Finite SSE responses include their SSE framing.
No client JSON reserialization is used; Unicode, object ordering, whitespace,
and numeric serialization differences cannot affect verification.

Finite responses are buffered up to 8 MiB before headers are committed, including
when the underlying transport calls `writeHead` first. Oversize responses fail
closed with HTTP 503 rather than exposing an unsigned result. Signing setup
failures likewise return HTTP 503. CORS exposes both public attestation headers.

## SDK enforcement

Configure `FiduciaryOptions.serverPublicKey` in Node or `server_public_key` in
Python with the independently trusted public SPKI PEM. Tool calls with no
trusted key cannot return a receipt. This deliberately breaks compatibility
with unsigned older servers. Deploy signing support and distribute the pin
before upgrading SDK consumers.

Both SDKs verify the complete response and its request binding before parsing
tool results. Successful tool and framework-adapter calls return a
`TruthReceipt` with `provenance_verified: true`, including free calls. Missing,
malformed, invalid, wrong-key or changed-body signatures throw:

```text
FiduciaryTamperingError: Data payload signature verification failed.
```

Public catalog discovery remains usable without a pin. Generic low-level fetch
is not a receipt-producing interface. Direct construction of a receipt does not
verify anything and defaults to `provenance_verified: false`.

The receipt's preimage, payment hash and `evidence_scope` still describe
**payment evidence only**; the local `payload_sha256` is not the signed wire
digest. Signature verification is a distinct data-provenance check.

## Guarantee boundaries

Verification proves the trusted server signed the exact response bytes for the
corresponding request body. It does not prove factual accuracy, freshness, Bitcoin
anchoring or absence of malicious data at the server. Repeated identical requests
can have identical request bindings; this is not a general replay/freshness
protocol. It cannot prevent an AI from making a false statement later, changing
an exported object or fabricating its own `provenance_verified` flag. Treat the
SDK verification step, not an unverified boolean supplied by an AI, as the trust
boundary. Preserve the exact request, response and signature when retaining
independently verifiable audit evidence.
