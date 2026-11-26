# Signed A2A discovery

`/.well-known/agent-card.json` describes the existing MCP interface using a
custom protocol-binding URI. It does **not** advertise a native A2A JSON-RPC,
gRPC or HTTP+JSON message endpoint, streaming, push notifications, or an extended
card. The AI Catalog links both the minimal MCP card and this signed card.

## Signing identity and fallback

The application passes the **same loaded Ed25519 KeyObject** used by
`/.well-known/integrity.json` to the new discovery builder. The `kid` is the
SHA-256 hex digest of its public SPKI DER, matching the integrity `key_id`.
Existing Article 12, waiver, revocation, tool and webhook signature formats and
key loaders are unchanged.

The existing integrity loader prefers a configured dedicated PEM key, otherwise
derives a domain-separated key from the persistent session secret. Without
either configuration, its existing standalone/dev fallback persists an
owner-only local key. That filesystem fallback is not a guarantee of identity
continuity on ephemeral hosts. Tests and navigation audits inject synthetic keys.
This feature adds no new key, secret, private-key export, or fallback.

## Verification

1. Remove only the top-level `signatures` field from the parsed card.
2. Canonicalize the unsigned JSON using RFC 8785 JCS.
3. Decode the protected header and require `alg: EdDSA`, `typ: JOSE`, the
   expected `kid`, and the expected canonical-domain `jku`.
4. Obtain the matching public OKP Ed25519 JWK from `/.well-known/jwks.json`.
5. Verify Ed25519 over ASCII `protected + "." + base64url(UTF8(JCS(unsigned)))`
   using the base64url-decoded `signature`. The payload is detached, not
   RFC 7797 unencoded payload.

JWKS distributes public keys; it is not independent evidence that a key is
trusted. Retain an independently authenticated key pin. Fetching a card and key
from the same compromised origin cannot establish identity on its own.

JCS uses UTF-16 code-unit ordering and ECMAScript finite-number/string
serialization without Unicode normalization. Undefined object properties are
omitted; undefined roots/array items, sparse arrays, unsupported objects,
accessors, cycles, non-finite numbers and unpaired surrogates fail closed.
The new canonicalizer is not substituted into any existing signature format.
