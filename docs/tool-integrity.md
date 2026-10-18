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
in use. Rotation changes the webhook signing key too: callbacks carry a single
signature from the current key, so receivers must update their pin first.
Do not delete local key files or rotate the relevant secret casually.
Never commit private keys. Only public keys, hashes and signatures are served.

## Security boundary

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
