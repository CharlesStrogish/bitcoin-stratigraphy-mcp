import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MeshGossipService,
  MeshQuorumError,
  verifyMeshAttestationEvent,
} from "../artifacts/api-server/src/services/meshGossipService";
import { createNostrAttestor } from "../artifacts/api-server/src/services/nostrAttestation";

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
      const body = { event: peer.attestSnapshot(request) };
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