---
name: Tool integrity trust
description: Trust and key-rotation constraints for the signed MCP description manifest.
---

Treat signed tool descriptions as a provenance mechanism, not a guarantee that
LLMs cannot be poisoned. Never imply client enforcement merely because the server
publishes signatures.

**Why:** The requested scope signs description digests only. A client must verify
an independently trusted pin; accepting a replacement key from an untrusted
manifest provides no replacement protection. Tool names, schemas and freshness
also need separate trust if a future feature claims full catalog integrity.

**How to apply:** Preserve the existing description-signature contract when
adding stronger envelopes or client enforcement. Keep the distinction explicit
in documentation and claims.

Coordinate signing-key rotation with client pin distribution. Do not treat
ordinary secret rotation or an ephemeral published filesystem as a harmless
integrity-key storage change. The same key signs synchronous MCP response
envelopes and async webhook callbacks (Standard Webhooks `v1a`), so rotation
affects response verifiers and webhook receivers as well as description verifiers.

**Why:** Published local files do not survive republishing. Persistent-secret
derivation was deliberately selected to keep this deployment's key stable
without introducing a new credential requirement. Its tradeoff is that rotating
the source secret changes the public signing identity unless a dedicated key is
configured first.

**How to apply:** Check the active key-source policy before changing secrets or
deployment storage. Use the secure secret flow for a dedicated key and plan pin
updates before switching identity; never copy private keys into Git or memory.
