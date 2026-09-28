import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeEvent, getPublicKey, nip19, type Event } from "nostr-tools";
import {
  canonicalMeshJson,
  MeshGossipService,
  MeshQuorumError,
  verifyMeshAttestationEvent,
} from "../artifacts/api-server/src/services/meshGossipService";
import { createNostrAttestor } from "../artifacts/api-server/src/services/nostrAttestation";
import { NostrWebOfTrust, verifyAgentSessionEvent } from "../artifacts/api-server/src/services/nostrWebOfTrust";
import { createHash } from "node:crypto";

const localKey = "01".padStart(64, "0");
const peerKey = "02".padStart(64, "0");

function peerFetch(
  peer: MeshGossipService,
  mutate?: (body: Record<string, unknown>) => Record<string, unknown>,
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/mesh/status")) {
      return Response.json(peer.status());
    }
    if (url.endsWith("/api/v1/mesh/attest")) {
      const request = JSON.parse(String(init?.body)) as {
        snapshot: unknown;
        snapshotDigest: string;
        networkId: string;
        originPubkey: string;
      };
      const body = { event: await peer.attestSnapshot(request) };
      return Response.json(mutate ? mutate(body) : body);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

test("discovers peers and aggregates a threshold consensus certificate", async () => {
  const localIdentity = new MeshGossipService({ privateKey: localKey, peers: [] });
  const peer = new MeshGossipService({
    privateKey: peerKey,
    peers: [{ url: "https://local.example", pubkey: localIdentity.nodePubkey }],
  });
  const mesh = new MeshGossipService({
    privateKey: localKey,
    peers: [{ url: "https://peer.example", pubkey: peer.nodePubkey }],
    threshold: 2,
    fetch: peerFetch(peer),
  });

  const discovered = await mesh.discoverPeers();
  assert.deepEqual(discovered, [
    { url: "https://peer.example", pubkey: peer.nodePubkey },
  ]);

  const snapshot = createNostrAttestor(localKey)({
    height: 920_000,
    signal: "validated",
  });
  const consensus = await mesh.createConsensus(snapshot);
  assert.equal(consensus.isolationMode, false);
  assert.equal(consensus.threshold, 2);
  assert.equal(consensus.quorumScore, 1);
  assert.equal(consensus.peerAttestations.length, 2);
  assert.equal(new Set(consensus.peerAttestations.map((item) => item.pubkey)).size, 2);
  assert.match(consensus.merkleRoot, /^[0-9a-f]{64}$/);
  assert.equal(mesh.status().topologyHealth, "healthy");
  assert.equal(mesh.status().crossValidationSuccessRate, 1);
});

test("rejects malicious or tampered peer signatures from quorum", async () => {
  const localIdentity = new MeshGossipService({ privateKey: localKey, peers: [] });
  const peer = new MeshGossipService({
    privateKey: peerKey,
    peers: [{ url: "https://local.example", pubkey: localIdentity.nodePubkey }],
  });
  const mesh = new MeshGossipService({
    privateKey: localKey,
    peers: [{ url: "https://malicious.example", pubkey: peer.nodePubkey }],
    threshold: 2,
    fetch: peerFetch(peer, (body) => {
      const event = body.event as { sig: string };
      return {
        event: {
          ...event,
          sig: `${event.sig.slice(0, -1)}${event.sig.endsWith("0") ? "1" : "0"}`,
        },
      };
    }),
  });

  const snapshot = createNostrAttestor(localKey)({ height: 920_001 });
  await assert.rejects(
    mesh.createConsensus(snapshot),
    (error: unknown) =>
      error instanceof MeshQuorumError &&
      error.received === 1 &&
      error.required === 2,
  );
  assert.equal(mesh.status().crossValidationSuccessRate, 0);

  const digest = "ab".repeat(32);
  const event = peer.signDigest(digest);
  assert.equal(verifyMeshAttestationEvent(event, digest, peer.nodePubkey), true);
  assert.equal(
    verifyMeshAttestationEvent(
      { ...event, content: JSON.stringify({ snapshotDigest: "cd".repeat(32) }) },
      digest,
      peer.nodePubkey,
    ),
    false,
  );
});

test("emits a locally verifiable certificate in single-node isolation mode", async () => {
  const mesh = new MeshGossipService({ privateKey: localKey, peers: [] });
  const consensus = await mesh.createConsensus(
    createNostrAttestor(localKey)({ height: 920_002 }),
  );

  assert.equal(consensus.isolationMode, true);
  assert.equal(consensus.threshold, 1);
  assert.equal(consensus.quorumScore, 1);
  assert.equal(consensus.peerAttestations.length, 1);
  assert.equal(mesh.status().activePeerCount, 1);
  assert.equal(mesh.status().topologyHealth, "isolated");
  assert.equal(mesh.status().crossValidationSuccessRate, 1);
});

test("verifies NIP-01 agent identity, NIP-01 profile, and network-bound trust depth", async () => {
  const trusted = getPublicKey(Uint8Array.from(Buffer.from(localKey, "hex")));
  const agentKey = "03".padStart(64, "0");
  const intermediaryKey = "04".padStart(64, "0");
  const agent = getPublicKey(Uint8Array.from(Buffer.from(agentKey, "hex")));
  const intermediary = getPublicKey(Uint8Array.from(Buffer.from(intermediaryKey, "hex")));
  const now = Math.floor(Date.now() / 1_000);
  const sign = (key: string, kind: number, content: string, tags: string[][] = [], created_at = now) =>
    finalizeEvent({ kind, content, tags, created_at }, Uint8Array.from(Buffer.from(key, "hex")));
  const profile = sign(agentKey, 0, JSON.stringify({ name: "Alice", about: "Agent operator" }), [], now - 100);
  const first = sign(localKey, 30079, "", [["p", intermediary], ["n", "bitcoin-stratigraphy-mainnet-v1"]]);
  const vouch = sign(intermediaryKey, 30079, "", [["p", agent], ["n", "bitcoin-stratigraphy-mainnet-v1"]]);
  const fake = sign(intermediaryKey, 30079, "", [["p", agent], ["n", "wrong-network"]]);
  const session = sign(agentKey, 20079, JSON.stringify({
    networkId: "bitcoin-stratigraphy-mainnet-v1", snapshotDigest: "ab".repeat(32),
  }));
  const identity = new NostrWebOfTrust({
    trustedPubkeys: [trusted], networkId: "bitcoin-stratigraphy-mainnet-v1",
    loadEvents: async (filter) =>
      [profile, first, vouch, fake].filter((event) =>
        (!filter.authors || filter.authors.includes(event.pubkey)) &&
        (!filter.kinds || filter.kinds.includes(event.kind)) &&
        (!filter["#p"] || event.tags.some((tag) => tag[0] === "p" && filter["#p"]!.includes(tag[1]!))),
      ),
  });
  const result = await identity.verify({ event: session, signature: session.sig });
  assert.equal(result.pubkey, agent);
  assert.equal(result.isValidSignature, true);
  assert.equal(result.attestationCount, 1);
  assert.equal(result.trustScore, 0.2);
  assert.equal(result.attestationDepth, 2);
  assert.equal(result.firstSeenTimestamp, now - 100);
  assert.equal(result.metadata.name, "Alice");
  const keyOnly = await identity.verify({ pubkey: nip19.npubEncode(agent) });
  assert.equal(keyOnly.isValidSignature, false);
  assert.equal(keyOnly.trustScore, 0.2);
  const forged = await identity.verify({ event: { ...session, content: "forged" } });
  assert.equal(forged.trustScore, 0);
  assert.equal(forged.isValidSignature, false);
  const badSignature = await identity.verify({
    event: { ...session, sig: "00".repeat(64) },
  });
  assert.equal(badSignature.isValidSignature, false);
  assert.equal(badSignature.trustScore, 0);
  await assert.rejects(identity.verify({ pubkey: agent, signature: session.sig }), /complete NIP-01 event/);
  assert.equal(verifyAgentSessionEvent(session, {
    networkId: "bitcoin-stratigraphy-mainnet-v1", snapshotDigest: "cd".repeat(32),
  }), false);
});

test("accepts only a trusted, state-bound agent session before indexing mesh state", async () => {
  const agentKey = "05".padStart(64, "0");
  const agent = getPublicKey(Uint8Array.from(Buffer.from(agentKey, "hex")));
  const meshIdentity = new MeshGossipService({ privateKey: localKey, peers: [] });
  const vouch = finalizeEvent({
    kind: 30079, content: "", tags: [["p", agent], ["n", meshIdentity.networkId]],
    created_at: Math.floor(Date.now() / 1_000),
  }, Uint8Array.from(Buffer.from(localKey, "hex")));
  const trust = new NostrWebOfTrust({
    trustedPubkeys: [meshIdentity.nodePubkey], networkId: meshIdentity.networkId,
    loadEvents: async (filter) => [vouch].filter((event) =>
      filter.authors?.includes(event.pubkey) && filter.kinds?.includes(event.kind) &&
      (!filter["#p"] || filter["#p"].includes(agent))),
  });
  const mesh = new MeshGossipService({ privateKey: localKey, peers: [], identityService: trust });
  const snapshot = createNostrAttestor(localKey)({ height: 920_000 });
  const digest = createHash("sha256").update(canonicalMeshJson(snapshot)).digest("hex");
  const sign = (snapshotDigest: string): Event => finalizeEvent({
    kind: 20079,
    content: JSON.stringify({ networkId: mesh.networkId, snapshotDigest }),
    tags: [], created_at: Math.floor(Date.now() / 1_000),
  }, Uint8Array.from(Buffer.from(agentKey, "hex")));
  const session = { event: sign(digest) };
  await assert.rejects(mesh.createConsensus(snapshot, { event: sign("ab".repeat(32)) }), /does not bind/);
  assert.equal(mesh.getSessionState(digest), undefined);
  const consensus = await mesh.createConsensus(snapshot, session);
  assert.equal(consensus.snapshotDigest, digest);
  assert.equal(mesh.getSessionState(digest)?.pubkey, agent);
  const unknownKey = "06".padStart(64, "0");
  const untrusted = finalizeEvent({
    kind: 20079, content: JSON.stringify({ networkId: mesh.networkId, snapshotDigest: digest }),
    tags: [], created_at: Math.floor(Date.now() / 1_000),
  }, Uint8Array.from(Buffer.from(unknownKey, "hex")));
  await assert.rejects(mesh.createConsensus(snapshot, { event: untrusted }), /no trusted/);
  const dateEvent = finalizeEvent({
    kind: 20079, content: JSON.stringify({ networkId: mesh.networkId, date: "2026-09-09" }),
    tags: [], created_at: Math.floor(Date.now() / 1_000),
  }, Uint8Array.from(Buffer.from(agentKey, "hex")));
  await mesh.createConsensus(snapshot, { event: dateEvent, date: "2026-09-09" });
  const differentSnapshot = createNostrAttestor(localKey)({ height: 920_001 });
  await assert.rejects(
    mesh.createConsensus(differentSnapshot, { event: dateEvent, date: "2026-09-09" }),
    /already bound/,
  );
  assert.equal((await mesh.attestSnapshot({
    snapshot, snapshotDigest: digest, networkId: mesh.networkId,
    originPubkey: mesh.nodePubkey, agentSession: session,
  }).catch(() => null)), null, "unconfigured peer origins cannot attest even with a trusted agent");
});