import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent,
} from "nostr-tools";
import {
  attachNostrAttestation,
  createCachedNostrAttestor,
  createNostrAttestor,
  signTelemetryPayload,
} from "../artifacts/api-server/src/services/nostrAttestation";

const privateKey = generateSecretKey();
const privateKeyHex = Buffer.from(privateKey).toString("hex");
const payload = {
  observed_at: "2026-09-17T12:00:00.000Z",
  block: { height: 920_000 },
};

test("creates a valid NIP-01 signed NIP-78 telemetry attestation", () => {
  const attestation = signTelemetryPayload(payload, {
    privateKey: privateKeyHex,
    createdAt: 1_789_646_400,
  });
  const content = JSON.stringify(payload);

  assert.equal(attestation.protocol, "nostr");
  assert.equal(attestation.nip, 78);
  assert.equal(attestation.event.kind, 30078);
  assert.equal(attestation.event.created_at, 1_789_646_400);
  assert.equal(attestation.event.pubkey, getPublicKey(privateKey));
  assert.equal(attestation.event.content, content);
  assert.equal(
    attestation.payload_sha256,
    createHash("sha256").update(content).digest("hex"),
  );
  assert.equal(verifyEvent(attestation.event), true);
  assert.deepEqual(
    attestation.event.tags.find(([name]) => name === "x"),
    ["x", attestation.payload_sha256],
  );
});

test("accepts an nsec secret and signs only the unsigned payload", () => {
  const attached = attachNostrAttestation(payload, {
    privateKey: nip19.nsecEncode(privateKey),
    createdAt: 1_789_646_400,
  });

  assert.deepEqual(JSON.parse(attached.attestation.event.content), payload);
  assert.equal("attestation" in JSON.parse(attached.attestation.event.content), false);
  assert.equal(verifyEvent(attached.attestation.event), true);
});

test("removes a stale attestation before re-signing a payload", () => {
  const first = attachNostrAttestation(payload, {
    privateKey: privateKeyHex,
    createdAt: 1_789_646_400,
  });
  const second = attachNostrAttestation(first, {
    privateKey: privateKeyHex,
    createdAt: 1_789_646_401,
  });

  assert.deepEqual(JSON.parse(second.attestation.event.content), payload);
  assert.equal(
    "attestation" in JSON.parse(second.attestation.event.content),
    false,
  );
  assert.equal(verifyEvent(second.attestation.event), true);
});

test("content cache re-signs mutations without changing prior payloads", () => {
  const mutable = {
    observed_at: payload.observed_at,
    block: { height: payload.block.height },
  };
  const cachedAttest = createCachedNostrAttestor(
    createNostrAttestor(privateKeyHex),
  );
  const first = cachedAttest(mutable, 1_789_646_400);
  mutable.block.height += 1;
  const second = cachedAttest(mutable, 1_789_646_401);

  assert.notEqual(first.attestation.event.id, second.attestation.event.id);
  assert.equal(
    (JSON.parse(first.attestation.event.content) as typeof mutable).block.height,
    920_000,
  );
  assert.equal(
    (JSON.parse(second.attestation.event.content) as typeof mutable).block.height,
    920_001,
  );
  assert.equal(
    (first as typeof mutable).block.height,
    920_000,
  );
  assert.equal(verifyEvent(second.attestation.event), true);
});

test("fails closed when NOSTR_PRIVATE_KEY is unavailable", () => {
  const configured = process.env.NOSTR_PRIVATE_KEY;
  delete process.env.NOSTR_PRIVATE_KEY;
  try {
    assert.throws(
      () => signTelemetryPayload(payload),
      /NOSTR_PRIVATE_KEY is not configured/,
    );
  } finally {
    if (configured !== undefined) process.env.NOSTR_PRIVATE_KEY = configured;
  }
});