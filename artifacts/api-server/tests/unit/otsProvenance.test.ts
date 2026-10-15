import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createOtsProvenanceService,
  OtsCalendarsUnavailableError,
  OtsCliExitError,
  OtsCliTimeoutError,
  otsCliEnvironment,
  STAMP_CALENDARS,
  stampWithCalendarFallback,
  verifyOtsProofRecord,
  type ProvenanceAnchor,
} from "../../src/services/otsProvenance";

const headHash = "11".repeat(32);
const merkleRoot = "22".repeat(32);
const rootDigest = createHash("sha256")
  .update(Buffer.from(merkleRoot, "hex"))
  .digest("hex");

test("isolates the Nix OTS CLI from workspace Python imports without changing other settings", () => {
  const inherited = {
    PATH: "/nix/bin",
    PYTHONPATH: "/workspace/python-packages",
    PYTHONHOME: "/workspace/python",
    NODE_ENV: "test",
    KEEP_SETTING: "unchanged",
  };
  assert.deepEqual(otsCliEnvironment(inherited), {
    PATH: "/nix/bin",
    NODE_ENV: "test",
    KEEP_SETTING: "unchanged",
  });
  assert.equal(inherited.PYTHONPATH, "/workspace/python-packages");
  assert.equal(inherited.PYTHONHOME, "/workspace/python");
});

// What the CLI prints, then exits 1, when its calendar gives no attestation.
const NO_ATTESTATION =
  "Failed to create timestamp: need at least 1 attestation but received 0 within timeout\n";

test("stamps through the standard calendars in order, skipping any that time out or give no attestation", async () => {
  assert.deepEqual(
    [...STAMP_CALENDARS],
    [
      "https://a.pool.opentimestamps.org",
      "https://b.pool.opentimestamps.org",
      "https://alice.btc.calendar.opentimestamps.org",
    ],
  );
  const receipt = Buffer.from([0x4f, 0x54, 0x53, 9]);
  const tried: string[] = [];
  const stamped = await stampWithCalendarFallback(async (calendar) => {
    tried.push(calendar);
    if (tried.length === 1) throw new OtsCliTimeoutError();
    if (tried.length === 2) throw new OtsCliExitError(1, NO_ATTESTATION);
    return receipt;
  });
  assert.equal(stamped, receipt);
  assert.deepEqual(tried, [...STAMP_CALENDARS]);

  tried.length = 0;
  await stampWithCalendarFallback(async (calendar) => {
    tried.push(calendar);
    return receipt;
  });
  assert.deepEqual(
    tried,
    [STAMP_CALENDARS[0]],
    "the first receipt ends the search",
  );
});

test("reports a calendar outage only when every calendar fails, and rethrows other failures at once", async () => {
  await assert.rejects(
    stampWithCalendarFallback(async (calendar) => {
      throw calendar === STAMP_CALENDARS[1]
        ? new OtsCliExitError(1, NO_ATTESTATION)
        : new OtsCliTimeoutError();
    }),
    (error: unknown) => {
      assert.ok(error instanceof OtsCalendarsUnavailableError);
      assert.deepEqual(error.failures, [
        { calendar: STAMP_CALENDARS[0], reason: "timed_out" },
        { calendar: STAMP_CALENDARS[1], reason: "no_attestation" },
        { calendar: STAMP_CALENDARS[2], reason: "timed_out" },
      ]);
      return true;
    },
  );
  const missingCli = Object.assign(new Error("spawn ots ENOENT"), {
    code: "ENOENT",
  });
  for (const failure of [
    missingCli,
    new OtsCliExitError(1, "Error! merkle-root-1.ots already exists"),
    new TypeError("OpenTimestamps proof is empty"),
  ]) {
    let attempts = 0;
    await assert.rejects(
      stampWithCalendarFallback(async () => {
        attempts += 1;
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(attempts, 1, `${failure.message} is not a calendar outage`);
  }
});

test("verifies OTS digest, Bitcoin attestation, and canonical header without trusting calendar receipts", async () => {
  const proof = Buffer.from([0x4f, 0x54, 0x53, 1]).toString("base64");
  const called = { verify: 0, header: 0 };
  const dependencies = {
    inspectDigest: async () => rootDigest,
    verifyDigest: async () => {
      called.verify++;
      return true;
    },
    inspectHeights: async () => [920_000],
    readHeaderHash: async () => {
      called.header++;
      return "ab".repeat(32);
    },
  };
  assert.deepEqual(
    await verifyOtsProofRecord(
      { otsProof: proof, targetHash: rootDigest },
      dependencies,
    ),
    {
      valid: true,
      status: "bitcoin_block_attested",
      blockHeight: 920_000,
      bitcoinHeaderHash: "ab".repeat(32),
    },
  );
  assert.deepEqual(
    await verifyOtsProofRecord(
      { otsProof: proof, targetHash: "cd".repeat(32) },
      dependencies,
    ),
    {
      valid: false,
      status: "unverified",
      blockHeight: null,
      bitcoinHeaderHash: null,
    },
  );
  assert.equal(
    called.verify,
    1,
    "Mismatched target must not proceed to Bitcoin lookup",
  );
  assert.equal(called.header, 1);
  assert.equal(
    (
      await verifyOtsProofRecord(
        { otsProof: proof, targetHash: rootDigest },
        {
          ...dependencies,
          verifyDigest: async () => false,
        },
      )
    ).valid,
    false,
    "A pending calendar proof must not pass",
  );
  await assert.rejects(
    verifyOtsProofRecord({ otsProof: "not a receipt", targetHash: rootDigest }),
    TypeError,
  );
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
      proofDigests.set(
        proof.toString("hex"),
        createHash("sha256").update(bytes).digest("hex"),
      );
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
      return (
        (typeof verify === "function" ? verify() : verify) &&
        digest === rootDigest
      );
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
  const anchor = await service.anchorProvenance({
    headHash,
    merkleRoot,
    totalDepth: 7,
  });

  assert.equal(calls.stamp, 1);
  assert.equal(anchor.otsStatus, "pending_calendar");
  assert.equal(
    anchor.otsProof,
    Buffer.from([0x4f, 0x54, 0x53, 1]).toString("base64"),
  );
  assert.equal(anchor.updatedAt, "2025-01-02T03:04:05.000Z");
  assert.equal(rows.get(headHash)?.merkleRoot, merkleRoot);
});

test("upgrades the existing receipt and only attests after CLI verification", async () => {
  let verified = false;
  const { service, calls } = makeService(() => verified);
  await service.anchorProvenance({ headHash, merkleRoot, totalDepth: 7 });
  verified = true;
  const repeated = await service.anchorProvenance({
    headHash,
    merkleRoot,
    totalDepth: 7,
  });

  assert.equal(calls.stamp, 1);
  assert.equal(calls.upgrade, 1);
  assert.equal(calls.verify, 2);
  assert.equal(repeated.otsStatus, "bitcoin_block_attested");
  assert.equal(Buffer.from(repeated.otsProof, "base64").at(-1), 0x55);
  verified = false; // A later node outage cannot revoke prior Bitcoin confirmation.
  const confirmed = await service.anchorProvenance({
    headHash,
    merkleRoot,
    totalDepth: 7,
  });
  assert.equal(confirmed.otsStatus, "bitcoin_block_attested");
  assert.equal(calls.upgrade, 1);
  assert.equal(calls.verify, 2);
});

test("rejects stored proofs that are not bound to the requested root", async () => {
  const { service, rows } = makeService();
  await service.anchorProvenance({ headHash, merkleRoot, totalDepth: 7 });
  const row = rows.get(headHash)!;
  row.otsProof = Buffer.from("unrelated proof");

  await assert.rejects(
    service.getProvenanceAnchor(headHash),
    /not bound to its Merkle root/,
  );
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
