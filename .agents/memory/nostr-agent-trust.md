---
name: Nostr agent trust
description: Trust roots, proof-of-possession, and session-state binding for agent swarm identities.
---

Treat a bare npub as an identifier, not proof of key possession. A standalone Schnorr signature cannot be checked without its complete NIP-01 event. Grant agent trust only along short chains of fresh, network-bound signed vouchers rooted in pinned mesh keys; an ordinary social follow is not an attestation. An agent session event must bind to the exact digest for direct attestations or to a selected source date independently checked by the peer for broadcasts. Do not let one event ID claim different accepted mesh states.

**Why:** Relays distribute untrusted events; popularity and unpinned signatures are not authorization. Some Nostr implementations cache a successful event verification on the object, so copying and mutating a previously verified event can accidentally preserve that verdict.

**How to apply:** Rebuild a clean NIP-01 event from its fields and independently hash and verify it each time trust is evaluated. Keep agent trust separate from the mesh quorum: peers still validate original source attestations and reciprocal membership before signing. Fail closed when relay evidence is missing or the session binding does not match.