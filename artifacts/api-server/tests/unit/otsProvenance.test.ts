import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createOtsProvenanceService,
  verifyOtsProofRecord,
  type ProvenanceAnchor,
} from "../../src/services/otsProvenance";

const headHash = "11".repeat(32);
const merkleRoot = "22".repeat(32);
const rootDigest = createHash("sha256")
  .update(Buffer.from(merkleRoot, "hex"))
  .digest("hex");

test("verifies OTS digest, Bitcoin attestation, and canonical header without trusting calendar receipts", async () => {
  const proof = Buffer.from([0x4f, 0x54, 0x53, 1]).toString("base64");
  const called = { verify: 0, header: 0 };
  const dependencies = {
    inspectDigest: async () => rootDigest,
    verifyDigest: async () => { called.verify++; return true; },
    inspectHeights: async () => [920_000],
    readHeaderHash: async () => { called.header++; return "ab".repeat(32); },
  };
  assert.deepEqual(await verifyOtsProofRecord({ otsProof: proof, targetHash: rootDigest }, dependencies), {
    valid: true, status: "bitcoin_block_attested",
    blockHeight: 920_000, bitcoinHeaderHash: "ab".repeat(32),
  });
  assert.deepEqual(await verifyOtsProofRecord({ otsProof: proof, targetHash: "cd".repeat(32) }, dependencies), {
    valid: false, status: "unverified", blockHeight: null, bitcoinHeaderHash: null,
  });
  assert.equal(called.verify, 1, "Mismatched target must not proceed to Bitcoin lookup");
  assert.equal(called.header, 1);
  assert.equal((await verifyOtsProofRecord({ otsProof: proof, targetHash: rootDigest }, {
    ...dependencies, verifyDigest: async () => false,
  })).valid, false, "A pending calendar proof must not pass");
  await assert.rejects(verifyOtsProofRecord({ otsProof: "not a receipt", targetHash: rootDigest }), TypeError);
});

function makeService(verify: boolean | (() => boolean) = false) {
  type Row = {
    headHash: string;
    merkleRoot: string;
    totalDepth: number;
    otsProof: Buffer;
    otsStatus: "pending_calendar" | "bitcoin_block_attested";
    updatedAt: Date;
  };
  const rows = new Map<string, Row>();
  const proofDigests = new Map<string, string>();
  const calls = { stamp: 0, upgrade: 0, verify: 0 };
  const store = {
    async get(key: string) {
      const row = rows.get(key);
      return row ? { ...row, otsProof: Buffer.from(row.otsProof) } : undefined;
    },
    async save(row: Row) {
      rows.set(row.headHash, { ...row, otsProof: Buffer.from(row.otsProof) });
    },
  };
  const cli = {
    async stamp(bytes: Buffer) {
      calls.stamp++;
      const proof = Buffer.from([0x4f, 0x54, 0x53, calls.stamp]);
      proofDigests.set(proof.toString("hex"), createHash("sha256").update(bytes).digest("hex"));
      return proof;
    },
    async upgrade(proof: Buffer) {
      calls.upgrade++;
      const upgraded = Buffer.concat([proof, Buffer.from([0x55])]);
      proofDigests.set(upgraded.toString("hex"), rootDigest);
      return upgraded;
    },
    async inspectDigest(proof: Buffer) {
      return proofDigests.get(proof.toString("hex")) ?? "";
    },
    async verifyDigest(_proof: Buffer, digest: string) {
      calls.verify++;
      return (typeof verify === "function" ? verify() : verify) && digest === rootDigest;
    },
  };
  const service = createOtsProvenanceService({
    store,
    cli,
    now: () => new Date("2025-01-02T03:04:05.000Z"),
  });
  return { service, calls, rows };
}

test("stamps root bytes and persists a real binary receipt as base64", async () => {
  const { service, calls, rows } = makeService();
  const anchor = await service.anchorProvenance({ headHash, merkleRoot, totalDepth: 7 });

  assert.equal(calls.stamp, 1);
  assert.equal(anchor.otsStatus, "pending_calendar");
  assert.equal(anchor.otsProof, Buffer.from([0x4f, 0x54, 0x53, 1]).toString("base64"));
  assert.equal(anchor.updatedAt, "2025-01-02T03:04:05.000Z");
  assert.equal(rows.get(headHash)?.merkleRoot, merkleRoot);
});

test("upgrades the existing receipt and only attests after CLI verification", async () => {
  let verified = false;
  const { service, calls } = makeService(() => verified);
  await service.anchorProvenance({ headHash, merkleRoot, totalDepth: 7 });
  verified = true;
  const repeated = await service.anchorProvenance({ headHash, merkleRoot, totalDepth: 7 });

  assert.equal(calls.stamp, 1);
  assert.equal(calls.upgrade, 1);
  assert.equal(calls.verify, 2);
  assert.equal(repeated.otsStatus, "bitcoin_block_attested");
  assert.equal(Buffer.from(repeated.otsProof, "base64").at(-1), 0x55);
  verified = false; // A later node outage cannot revoke prior Bitcoin confirmation.
  const confirmed = await service.anchorProvenance({ headHash, merkleRoot, totalDepth: 7 });
  assert.equal(confirmed.otsStatus, "bitcoin_block_attested");
  assert.equal(calls.upgrade, 1);
  assert.equal(calls.verify, 2);
});

test("rejects stored proofs that are not bound to the requested root", async () => {
  const { service, rows } = makeService();
  await service.anchorProvenance({ headHash, merkleRoot, totalDepth: 7 });
  const row = rows.get(headHash)!;
  row.otsProof = Buffer.from("unrelated proof");

  await assert.rejects(service.getProvenanceAnchor(headHash), /not bound to its Merkle root/);
});

test("does not assert Bitcoin attestation when verify fails", async () => {
  const { service } = makeService(false);
  const anchor: ProvenanceAnchor = await service.anchorProvenance({
    headHash,
    merkleRoot,
    totalDepth: 7,
  });
  assert.equal(anchor.otsStatus, "pending_calendar");
});