import { createHash } from "node:crypto";
import { getPublicKey, verifyEvent } from "nostr-tools";
import { canonicalMeshJson, meshMerkleRoot } from "./meshGossipService";
import {
  signTelemetryPayload,
  parsePrivateKey,
  type NostrAttestation,
} from "./nostrAttestation";

const BLOCK_SIZE_BYTES = 1_024;
const SCHEMA = "bitcoin-stratigraphy/cryptographic-attestation/v1";

export type CryptographicAttestation = {
  schema: typeof SCHEMA;
  payload: unknown;
  proof: {
    algorithm: "sha256";
    payloadSha256: string;
    blockSizeBytes: number;
    blockHashes: string[];
    merkleRoot: string;
    timestamp: number;
  };
  signature: NostrAttestation;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function payloadCommitment(payload: unknown, timestamp: number) {
  const serialized = Buffer.from(canonicalMeshJson(payload));
  const blockHashes: string[] = [];
  for (let offset = 0; offset < serialized.length; offset += BLOCK_SIZE_BYTES) {
    blockHashes.push(
      sha256(serialized.subarray(offset, offset + BLOCK_SIZE_BYTES)),
    );
  }
  if (blockHashes.length === 0) blockHashes.push(sha256(""));
  return {
    schema: SCHEMA,
    algorithm: "sha256" as const,
    payloadSha256: sha256(serialized),
    blockSizeBytes: BLOCK_SIZE_BYTES,
    blockHashes,
    merkleRoot: meshMerkleRoot(blockHashes),
    timestamp,
  };
}

export function generateCryptographicAttestation(
  payload: unknown,
  options: { privateKey?: string; timestamp?: number } = {},
): CryptographicAttestation {
  const timestamp = options.timestamp ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new RangeError("Attestation timestamp must be a positive integer");
  }
  const commitment = payloadCommitment(payload, timestamp);
  return {
    schema: SCHEMA,
    payload,
    proof: {
      algorithm: commitment.algorithm,
      payloadSha256: commitment.payloadSha256,
      blockSizeBytes: commitment.blockSizeBytes,
      blockHashes: commitment.blockHashes,
      merkleRoot: commitment.merkleRoot,
      timestamp,
    },
    signature: signTelemetryPayload(commitment, {
      privateKey: options.privateKey,
      createdAt: Math.floor(timestamp / 1_000),
    }),
  };
}

export function verifyCryptographicAttestation(
  value: unknown,
  options: { issuerPublicKey?: string } = {},
): value is CryptographicAttestation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CryptographicAttestation>;
  const proof = candidate.proof;
  const signature = candidate.signature;
  if (
    candidate.schema !== SCHEMA ||
    !proof ||
    proof.algorithm !== "sha256" ||
    proof.blockSizeBytes !== BLOCK_SIZE_BYTES ||
    !Number.isSafeInteger(proof.timestamp) ||
    proof.timestamp <= 0 ||
    !Array.isArray(proof.blockHashes) ||
    proof.blockHashes.length === 0 ||
    !proof.blockHashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)) ||
    !/^[0-9a-f]{64}$/.test(proof.payloadSha256) ||
    !/^[0-9a-f]{64}$/.test(proof.merkleRoot) ||
    !signature ||
    signature.protocol !== "nostr" ||
    signature.nip !== 78
  ) {
    return false;
  }
  try {
    if (!verifyEvent(signature.event)) return false;
  } catch {
    return false;
  }
  let issuerPublicKey = options.issuerPublicKey;
  if (!issuerPublicKey) {
    const privateKey = process.env.NOSTR_PRIVATE_KEY;
    if (!privateKey) return false;
    try {
      issuerPublicKey = getPublicKey(parsePrivateKey(privateKey));
    } catch {
      return false;
    }
  }
  if (!/^[0-9a-f]{64}$/.test(issuerPublicKey)) return false;
  let expected;
  try {
    expected = payloadCommitment(candidate.payload, proof.timestamp);
  } catch {
    return false;
  }
  const signedCommitment = {
    schema: SCHEMA,
    algorithm: proof.algorithm,
    payloadSha256: proof.payloadSha256,
    blockSizeBytes: proof.blockSizeBytes,
    blockHashes: proof.blockHashes,
    merkleRoot: proof.merkleRoot,
    timestamp: proof.timestamp,
  };
  const signedContent = JSON.stringify(signedCommitment);
  const expectedPayloadDigest = sha256(signedContent);
  const expectedTags = [
    ["d", `bitcoin-stratigraphy:${expectedPayloadDigest}`],
    ["t", "bitcoin-stratigraphy"],
    ["t", "telemetry"],
    ["x", expectedPayloadDigest],
  ];
  return (
    expected.payloadSha256 === proof.payloadSha256 &&
    expected.merkleRoot === proof.merkleRoot &&
    expected.blockHashes.length === proof.blockHashes.length &&
    expected.blockHashes.every(
      (hash, index) => hash === proof.blockHashes[index],
    ) &&
    signature.event.kind === 30_078 &&
    signature.event.pubkey === issuerPublicKey &&
    signature.event.created_at === Math.floor(proof.timestamp / 1_000) &&
    signature.event.content === signedContent &&
    signature.payload_sha256 === expectedPayloadDigest &&
    JSON.stringify(signature.event.tags) === JSON.stringify(expectedTags)
  );
}