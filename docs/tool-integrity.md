# MCP tool description integrity

`GET /.well-known/integrity.json` is public JSON, also available under
`/api/.well-known/integrity.json`. It is generated once per process startup,
after the canonical 16-tool registry's description overrides have finished.
No MCP tool, schema, price, payment gate or execution path is changed.
The same key also signs asynchronous webhook callbacks; see
[Webhook callback signatures](#webhook-callback-signatures).

## Verify independently

1. Obtain and pin the server's Ed25519 public key through a trusted channel.
   The manifest's `key_id` is SHA-256 of the SPKI DER public key bytes.
2. Fetch the manifest and `POST /mcp` with
   `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`.
3. Require exactly the same 16 unique tool names in both responses.
4. SHA-256 each tool's exact UTF-8 `description`: do not trim, normalize Unicode,
   reserialize it as JSON, or add a newline. Compare its lowercase hex digest
   with `description_hash`.
5. Decode `signature` from base64. Verify Ed25519 over the **raw 32-byte digest**,
   not the 64-character hexadecimal text, with the pinned SPKI PEM public key.
6. Reject mismatches before exposing the description to an agent.

Node.js example (use a locally pinned PEM file, not an untrusted manifest key):

```js
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const pinnedKey = createPublicKey(readFileSync("trusted-integrity-public.pem"));
const manifestKey = createPublicKey(manifest.server_public_key);
const der = (key) => key.export({ type: "spki", format: "der" });
if (!der(pinnedKey).equals(der(manifestKey))) throw new Error("Unexpected key");
if (
  manifest.algorithm !== "Ed25519" ||
  manifest.hash_algorithm !== "SHA-256" ||
  manifest.signature_encoding !== "base64"
)
  throw new Error("Unexpected format");
const entries = new Map(manifest.tools.map((entry) => [entry.name, entry]));
if (
  manifest.tools.length !== 16 ||
  entries.size !== 16 ||
  listedTools.length !== 16 ||
  new Set(listedTools.map((t) => t.name)).size !== 16
) {
  throw new Error("Unexpected catalog");
}
for (const tool of listedTools) {
  const entry = entries.get(tool.name);
  const digest = createHash("sha256").update(tool.description, "utf8").digest();
  if (
    !entry ||
    digest.toString("hex") !== entry.description_hash ||
    !verify(null, digest, pinnedKey, Buffer.from(entry.signature, "base64"))
  ) {
    throw new Error(`Untrusted description: ${tool.name}`);
  }
}
```

## Webhook callback signatures

The same Ed25519 key signs every asynchronous callback sent for a `webhook_url`
call (`stratigraphy.get_range` and `proof.submit`), using the asymmetric scheme
of the [Standard Webhooks](https://www.standardwebhooks.com/) specification.
There is nothing to configure: receivers verify with the `server_public_key`
published in `/.well-known/integrity.json`. Each callback `POST` carries:

| Header              | Value                                                            |
| ------------------- | ---------------------------------------------------------------- |
| `Webhook-Id`        | The `task_id` from the 202 acknowledgement; the same on retries. |
| `Webhook-Timestamp` | Integer Unix seconds at which this delivery attempt was signed.  |
| `Webhook-Signature` | `v1a,` followed by the base64-encoded 64-byte Ed25519 signature. |

The signed content is the UTF-8 string `<Webhook-Id>.<Webhook-Timestamp>.<body>`,
where `<body>` is the exact request body. `v1a` is the Standard Webhooks
identifier for Ed25519 signatures; `v1` denotes HMAC-SHA256 and is never sent.
The header is a space-delimited list, so ignore entries with other identifiers.
Every retry is signed again with a new timestamp.

To verify a callback:

1. Fetch `https://bitcoinstratigraphy.com/.well-known/integrity.json` once and
   pin its `server_public_key` (SPKI PEM) as described above; `key_id` is
   SHA-256 of the DER public key bytes. Do not refetch it for every callback,
   and never accept a key supplied by the callback request itself.
2. Reject a `Webhook-Timestamp` more than five minutes from your own clock.
3. Verify the signature from a `v1a` entry against
   `<Webhook-Id>.<Webhook-Timestamp>.` followed by the raw body bytes. Do this
   before parsing: parsing and re-serializing the JSON can change the bytes.
4. Require the body's `task_id` to equal `Webhook-Id` and to be a `task_id` you
   received in a 202, and process each `Webhook-Id` only once.

Node.js example (`rawBody` is a `Buffer` of the exact request body, `headers`
uses lowercase names as in Node's `IncomingMessage`):

```js
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

// server_public_key from integrity.json, pinned locally.
const publicKey = createPublicKey(readFileSync("trusted-integrity-public.pem"));

export function verifyWebhook(headers, rawBody, toleranceSeconds = 300) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  if (!id || !/^\d+$/.test(timestamp ?? "")) throw new Error("Missing headers");
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) {
    throw new Error("Timestamp outside tolerance");
  }
  const content = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), rawBody]);
  const entries = (headers["webhook-signature"] ?? "").split(" ");
  const valid = entries.some((entry) => {
    const [version, signature] = entry.split(",");
    return (
      version === "v1a" &&
      signature !== undefined &&
      verify(null, content, publicKey, Buffer.from(signature, "base64"))
    );
  });
  if (!valid) throw new Error("Invalid webhook signature");
  const payload = JSON.parse(rawBody.toString("utf8"));
  if (payload.task_id !== id) throw new Error("Webhook-Id mismatch");
  return payload;
}
```

Description signatures cover a raw 32-byte digest, while webhook signatures
cover strings that are always longer, so a signature made for one purpose
cannot verify for the other. A valid webhook signature shows that this server's
key signed that body for that task and time. It does not guarantee delivery,
and it shows who sent the result, not that the result is correct.

## Signed synchronous tool responses

Every successful synchronous `tools/call` result, free or paid and on either
protocol version, includes `_meta.responseSignature`:

```json
{
  "algorithm": "Ed25519",
  "keyId": "<SHA-256 of the trusted SPKI DER public key>",
  "timestamp": 1792454400,
  "contentSha256": "<64 lowercase hex characters>",
  "signature": "v1a,<base64 Ed25519 signature>"
}
```

This is additional metadata, not a replacement for `content` or
`structuredContent`. Other metadata, including stateless server information, is
preserved. JSON-RPC/payment errors, tool results marked `isError`, discovery
responses, and HTTP 202 async acknowledgements are not signed this way. Async
callbacks keep the separate webhook format above.

### Canonical bytes

1. Select an object with the `content` member and, **only if present**, the
   `structuredContent` member from the tool result.
2. Normalize to JSON wire values: omit undefined object members, use JSON `null`
   for undefined array values and non-finite numbers, and serialize any `toJSON`
   values before sorting. Parsed HTTP JSON is already normalized.
3. Recursively sort object keys in JavaScript string order (UTF-16 code units).
   Serialize keys and primitive values with `JSON.stringify`; preserve array
   order and exact string contents. Join object/array members with commas and
   colons, without whitespace or a trailing newline. This is this server's
   deterministic JSON scheme, not a claim of full RFC 8785 compatibility.
4. SHA-256 hash the UTF-8 bytes of that serialization, producing lowercase hex.
5. Verify Ed25519 over the UTF-8 string
   `tool_name.timestamp.contentSha256`. The tool name is the exact name sent in
   the request, including a supported legacy alias. The signature has the `v1a,`
   prefix; the prefix itself is not part of the signed string.

Example canonical bytes:

```text
{"content":[{"text":"ok","type":"text"}],"structuredContent":{"a":1,"b":2}}
```

Hash **both** representations when both exist. Replacing a displayed text byte
or changing a structured value invalidates verification. `_meta`, `resultType`,
cache hints and other transport fields are outside the signed payload.

The exported TypeScript helper
`artifacts/api-server/src/lib/mcp-response-signature.ts` exposes
`canonicalResultContent`, `signToolResponse`, and `verifyToolResponse`.
For code running in this repository:

```ts
import { createPublicKey } from "node:crypto";
import { verifyToolResponse } from "./artifacts/api-server/src/lib/mcp-response-signature";

// Persist server_public_key after independently authenticating its fingerprint.
const pinnedKey = createPublicKey(trustedPublicKeyPem);
const valid = verifyToolResponse(requestedToolName, rpcResponse.result, pinnedKey);
if (!valid) throw new Error("Tool result signature or freshness check failed");
```

The verifier requires the SHA-256 SPKI DER fingerprint to match `keyId`, verifies
the digest and signature, and rejects timestamps more than 300 seconds in the
past or future by default. Its optional `nowSeconds` and `toleranceSeconds`
arguments let callers apply an explicit verification-time policy. Archive
verification needs a separate trusted time/retention policy, not a casually
disabled freshness check. Never choose a trusted key based only on `keyId` or
fetch a replacement key from the same untrusted response.

These signatures establish server origin and content integrity. They do not
prove factual correctness, Bitcoin confirmation, payment settlement, a legal
identity, or that this payload was produced for a particular request. The
envelope has no request nonce or arguments hash; a fresh same-tool result can
be replayed within the clock window. Consumers must match expected inputs and
their own request-level replay policy separately.

## Prepaid batch discovery

Both cost-quote methods at `/api/v1/cost` and
`stratigraphy://catalog/overview` return `batchSettlement` with the request
header, supported sizes, price multiplier, scope and upfront-settlement
instructions. The existing gate accepts **only `X-L402-Batch-Size: 100`**:
100 times the tool's per-call price buys a single tool-scoped 100-call pass.
Send that header on the initial paid tool challenge, pay the exact returned
Lightning invoice once, then reuse its macaroon/preimage credential for
authorized calls. No cross-tool aggregate invoice, x402 batch, or arbitrary
10–1000-call range is advertised. Discovery never creates an invoice.
Payment-proof caching avoids repeated Lightning settlement checks while
expiry, revocation and every inherited attenuation budget remain enforced.

## Key persistence and operations

Key source priority:

- `TOOL_INTEGRITY_PRIVATE_KEY`: dedicated Ed25519 PKCS#8 PEM private key supplied
  through the deployment's secret manager. Invalid keys stop startup; no silent
  regeneration occurs.
- Otherwise, a dedicated Ed25519 seed is derived from the existing persistent
  `SESSION_SECRET` using HKDF-SHA-256, salt
  `bitcoin-stratigraphy/tool-integrity/v1`, and info `ed25519-signing-seed`.
  The key remains stable across restarts, instances and republishes while that
  secret is unchanged. This avoids relying on an ephemeral published filesystem.
  Use a high-entropy session secret; do not publish or log it.
- With neither secret, generate an Ed25519 key on first startup in
  `.keys/tool-integrity-ed25519.pem` relative to the process working directory.
  `TOOL_INTEGRITY_KEYS_DIR` can select a persistent volume instead.
  The directory is owner-only (`0700`), the private key is owner-only (`0600`),
  and atomic publication prevents simultaneous starts from using different keys.
  The public key is derived from the stored private key. Malformed, symlinked or
  unreadable key files fail startup rather than rotating identity silently.
  This standalone mode requires persistent disk; never rely on ephemeral local
  files for production identity. `.keys` directories are excluded from Git and
  publishing.

For independent key rotation, configure the dedicated private-key secret and
distribute the new public-key pin through a trusted channel **before** rollout.
Changing `SESSION_SECRET` also changes the integrity key when derived mode is
in use. Rotation changes the synchronous-response and webhook signing key too: callbacks carry a single
signature from the current key, so receivers must update their pin first.
Do not delete local key files or rotate the relevant secret casually.
Never commit private keys. Only public keys, hashes and signatures are served.

## Description-signature security boundary

This is **signed description integrity**, not a guarantee of safe descriptions or
safe LLM behavior. Clients must actually verify a trusted pin; trusting a key
from the same untrusted response defeats replacement detection. The signing key
or server being compromised defeats the attestation. Legitimate server code
changes are re-signed at startup, so signatures do not distinguish an authorized
description change from compromised release code.

As requested, each signature covers only the description digest: not the tool
name, input/output schemas, implementation, catalog membership, or timestamp.
Names are lookup labels, not cryptographically signed bindings. Two descriptions
can be relabeled together with their valid signatures by an attacker who can
replace both discovery documents. The generation timestamp is informational, not
a signed freshness guarantee; old signed descriptions can be replayed. Clients
needing identity binding or anti-rollback must additionally pin expected
name-to-description hashes/version policy through a trusted channel.
