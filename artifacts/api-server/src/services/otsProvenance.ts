import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProvenanceAnchor = {
  headHash: string;
  merkleRoot: string;
  totalDepth: number;
  otsProof: string;
  otsStatus: "pending_calendar" | "bitcoin_block_attested";
  updatedAt: string;
};

type AnchorState = Pick<ProvenanceAnchor, "headHash" | "merkleRoot" | "totalDepth">;
type StoredAnchor = Omit<ProvenanceAnchor, "otsProof" | "updatedAt"> & {
  otsProof: Buffer;
  updatedAt: Date;
};

type AnchorStore = {
  get(headHash: string): Promise<StoredAnchor | undefined>;
  save(anchor: StoredAnchor): Promise<void>;
};

type OtsCli = {
  stamp(rootBytes: Buffer): Promise<Buffer>;
  upgrade(proof: Buffer): Promise<Buffer>;
  inspectDigest(proof: Buffer): Promise<string>;
  verifyDigest(proof: Buffer, digest: string): Promise<boolean>;
};

const MAX_PROOF_BYTES = 512 * 1024;
const MAX_CLI_OUTPUT_BYTES = 64 * 1024;
const STAMP_TIMEOUT_MS = 20_000;
const UPGRADE_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 10_000;
const PUBLIC_CALENDARS = [
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://a.pool.eternitywall.com",
  "https://ots.btc.catallaxy.com",
] as const;
// Pool submissions return receipts addressed to the underlying public
// calendars, rather than to the pool URLs that accepted the stamp.
const PUBLIC_CALENDAR_SET = new Set<string>([
  ...PUBLIC_CALENDARS,
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
  "https://btc.calendar.catallaxy.com",
]);

function validateState(state: AnchorState): void {
  if (!/^[0-9a-f]{64}$/i.test(state.headHash)) {
    throw new TypeError("Provenance headHash must be a 32-byte hexadecimal hash");
  }
  if (!/^[0-9a-f]{64}$/i.test(state.merkleRoot)) {
    throw new TypeError("Provenance merkleRoot must be a 32-byte hexadecimal hash");
  }
  if (!Number.isSafeInteger(state.totalDepth) || state.totalDepth < 0) {
    throw new TypeError("Provenance totalDepth must be a non-negative safe integer");
  }
}

function digestRootBytes(rootBytes: Buffer): string {
  return createHash("sha256").update(rootBytes).digest("hex");
}

function checkedProof(proof: Buffer): Buffer {
  if (proof.length === 0 || proof.length > MAX_PROOF_BYTES) {
    throw new Error("OpenTimestamps proof is empty or exceeds the maximum size");
  }
  return proof;
}

function runOts(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ots", ["--no-cache", ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? "");
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CLI_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("OpenTimestamps CLI output exceeded the maximum size"));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("OpenTimestamps CLI operation timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0) finish(undefined, stdout);
      else finish(new Error(`OpenTimestamps CLI failed (${code}): ${stderr.slice(0, 1_024)}`));
    });
  });
}

async function inTempDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ots-provenance-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function calendarArgs(): string[] {
  return PUBLIC_CALENDARS.flatMap((url) => ["-c", url]);
}

const otsCli: OtsCli = {
  async stamp(rootBytes) {
    return inTempDirectory(async (directory) => {
      const inputPath = join(directory, "merkle-root");
      await writeFile(inputPath, rootBytes, { flag: "wx" });
      await runOts(
        ["stamp", "--timeout", "4", ...calendarArgs(), inputPath],
        directory,
        STAMP_TIMEOUT_MS,
      );
      return checkedProof(await readFile(`${inputPath}.ots`));
    });
  },
  async upgrade(proof) {
    return inTempDirectory(async (directory) => {
      const proofPath = join(directory, "anchor.ots");
      await writeFile(proofPath, checkedProof(proof), { flag: "wx" });
      try {
        await runOts(
          ["upgrade", ...calendarArgs(), proofPath],
          directory,
          UPGRADE_TIMEOUT_MS,
        );
        return checkedProof(await readFile(proofPath));
      } catch {
        // Upgrade can fail transiently when public calendars are unreachable.
        // The original serialized receipt remains genuine and is retained.
        return proof;
      }
    });
  },
  async inspectDigest(proof) {
    return inTempDirectory(async (directory) => {
      const proofPath = join(directory, "anchor.ots");
      await writeFile(proofPath, checkedProof(proof), { flag: "wx" });
      const info = await runOts(["info", proofPath], directory, VERIFY_TIMEOUT_MS);
      const digest = /^File sha256 hash: ([0-9a-f]{64})$/mi.exec(info)?.[1];
      if (!digest) {
        throw new Error("OpenTimestamps receipt does not contain a SHA-256 file digest");
      }
      const referencedCalendars: string[] = [...(info.match(/https?:\/\/[^\s]+/g) ?? [])];
      if (
        referencedCalendars.some((url) =>
          !PUBLIC_CALENDAR_SET.has(url.replace(/[\])},.;'"]+$/, ""))
        )
      ) {
        throw new Error("OpenTimestamps receipt references a non-approved calendar");
      }
      return digest;
    });
  },
  async verifyDigest(proof, digest) {
    return inTempDirectory(async (directory) => {
      const proofPath = join(directory, "anchor.ots");
      await writeFile(proofPath, checkedProof(proof), { flag: "wx" });
      try {
        await runOts(
          ["verify", "-d", digest, proofPath],
          directory,
          VERIFY_TIMEOUT_MS,
        );
        return true;
      } catch {
        return false;
      }
    });
  },
};

export type OtsVerificationResult = {
  valid: boolean;
  status: "bitcoin_block_attested" | "unverified";
  blockHeight: number | null;
  bitcoinHeaderHash: string | null;
};

/** Verify the SHA-256 digest committed by a serialized OTS receipt. A
 * calendar-only receipt is never reported as Bitcoin-attested. */
export async function verifyOtsProofRecord(
  input: { otsProof: string; targetHash: string },
  dependencies: {
    inspectDigest?: (proof: Buffer) => Promise<string>;
    verifyDigest?: (proof: Buffer, digest: string) => Promise<boolean>;
    inspectHeights?: (proof: Buffer) => Promise<number[]>;
    readHeaderHash?: (height: number) => Promise<string>;
  } = {},
): Promise<OtsVerificationResult> {
  const targetHash = input.targetHash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(targetHash)) {
    throw new TypeError("targetHash must be a 32-byte SHA-256 hex digest");
  }
  const encoded = input.otsProof;
  const hex = /^(?:[0-9a-fA-F]{2})+$/.test(encoded);
  if (!hex && (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)) {
    throw new TypeError("otsProof must be a base64 or hex-encoded OTS receipt");
  }
  const proof = checkedProof(Buffer.from(encoded, hex ? "hex" : "base64"));
  if (!hex && proof.toString("base64") !== encoded) {
    throw new TypeError("otsProof is not canonical base64");
  }
  const inspectDigest = dependencies.inspectDigest ?? otsCli.inspectDigest;
  const verifyDigest = dependencies.verifyDigest ?? otsCli.verifyDigest;
  const digest = await inspectDigest(proof);
  const unverified: OtsVerificationResult = {
    valid: false, status: "unverified", blockHeight: null, bitcoinHeaderHash: null,
  };
  if (digest.toLowerCase() !== targetHash || !(await verifyDigest(proof, targetHash))) {
    return unverified;
  }
  const inspectHeights = dependencies.inspectHeights ?? (async (bytes: Buffer) =>
    inTempDirectory(async (directory) => {
      const proofPath = join(directory, "anchor.ots");
      await writeFile(proofPath, bytes, { flag: "wx" });
      const info = await runOts(["info", proofPath], directory, VERIFY_TIMEOUT_MS);
      return [...info.matchAll(/BitcoinBlockHeaderAttestation\((\d+)\)/g)]
        .map((match) => Number(match[1]));
    }));
  const heights = [...new Set(await inspectHeights(proof))];
  if (heights.length !== 1 || !Number.isSafeInteger(heights[0]) || heights[0]! <= 0) {
    return unverified;
  }
  const height = heights[0]!;
  const readHeaderHash = dependencies.readHeaderHash ?? (async (blockHeight: number) => {
    const response = await fetch(`https://mempool.space/api/block-height/${blockHeight}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Bitcoin header provider is unavailable");
    if (!response.body) throw new Error("Bitcoin header provider returned no body");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 128) throw new Error("Bitcoin header response exceeds size limit");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const value = Buffer.concat(chunks).toString("utf8").trim().toLowerCase();
    if (value.length > 64) throw new Error("Bitcoin header response exceeds size limit");
    return value;
  });
  const bitcoinHeaderHash = (await readHeaderHash(height)).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bitcoinHeaderHash)) {
    throw new Error("Bitcoin header provider returned an invalid hash");
  }
  return {
    valid: true, status: "bitcoin_block_attested", blockHeight: height, bitcoinHeaderHash,
  };
}

const postgresStore: AnchorStore = {
  async get(headHash) {
    const [{ db, otsProvenanceAnchorsTable }, { eq }] = await Promise.all([
      import("@workspace/db"),
      import("drizzle-orm"),
    ]);
    const [row] = await db
      .select()
      .from(otsProvenanceAnchorsTable)
      .where(eq(otsProvenanceAnchorsTable.headHash, headHash))
      .limit(1);
    return row
      ? {
          ...row,
          otsProof: Buffer.from(row.otsProof),
          updatedAt: row.updatedAt,
        }
      : undefined;
  },
  async save(anchor) {
    const { db, otsProvenanceAnchorsTable } = await import("@workspace/db");
    await db
      .insert(otsProvenanceAnchorsTable)
      .values(anchor)
      .onConflictDoUpdate({
        target: otsProvenanceAnchorsTable.headHash,
        set: {
          merkleRoot: anchor.merkleRoot,
          totalDepth: anchor.totalDepth,
          otsProof: anchor.otsProof,
          otsStatus: anchor.otsStatus,
          updatedAt: anchor.updatedAt,
        },
      });
  },
};

export function createOtsProvenanceService(
  dependencies: { store: AnchorStore; cli: OtsCli; now?: () => Date } = {
    store: postgresStore,
    cli: otsCli,
  },
) {
  const now = dependencies.now ?? (() => new Date());

  async function asPublicAnchor(row: StoredAnchor): Promise<ProvenanceAnchor> {
    const proof = checkedProof(Buffer.from(row.otsProof));
    const rootBytes = Buffer.from(row.merkleRoot, "hex");
    const expectedDigest = digestRootBytes(rootBytes);
    if (await dependencies.cli.inspectDigest(proof) !== expectedDigest) {
      throw new Error("Stored OpenTimestamps receipt is not bound to its Merkle root");
    }
    if (row.otsStatus !== "pending_calendar" && row.otsStatus !== "bitcoin_block_attested") {
      throw new Error("Stored OpenTimestamps receipt has an invalid status");
    }
    return {
      headHash: row.headHash,
      merkleRoot: row.merkleRoot,
      totalDepth: row.totalDepth,
      otsProof: proof.toString("base64"),
      otsStatus: row.otsStatus,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  return {
    async getProvenanceAnchor(headHash: string): Promise<ProvenanceAnchor | undefined> {
      const row = await dependencies.store.get(headHash);
      return row ? asPublicAnchor(row) : undefined;
    },
    async anchorProvenance(state: AnchorState): Promise<ProvenanceAnchor> {
      validateState(state);
      const rootBytes = Buffer.from(state.merkleRoot, "hex");
      const expectedDigest = digestRootBytes(rootBytes);
      const previous = await dependencies.store.get(state.headHash);
      let proof: Buffer;

      if (
        previous?.otsStatus === "bitcoin_block_attested" &&
        previous.merkleRoot.toLowerCase() === state.merkleRoot.toLowerCase() &&
        previous.totalDepth === state.totalDepth
      ) {
        // A receipt already confirmed against Bitcoin needs no more calendar
        // upgrades. Do not regress it when a later node/calendar check is offline.
        return asPublicAnchor(previous);
      }

      if (
        previous &&
        previous.merkleRoot.toLowerCase() === state.merkleRoot.toLowerCase() &&
        previous.totalDepth === state.totalDepth
      ) {
        proof = checkedProof(Buffer.from(previous.otsProof));
        if (await dependencies.cli.inspectDigest(proof) !== expectedDigest) {
          throw new Error("Stored OpenTimestamps receipt is not bound to its Merkle root");
        }
        proof = checkedProof(await dependencies.cli.upgrade(proof));
      } else {
        proof = checkedProof(await dependencies.cli.stamp(rootBytes));
      }

      if (await dependencies.cli.inspectDigest(proof) !== expectedDigest) {
        throw new Error("OpenTimestamps CLI produced a receipt for a different Merkle root");
      }
      const otsStatus = await dependencies.cli.verifyDigest(proof, expectedDigest)
        ? "bitcoin_block_attested"
        : "pending_calendar";
      const row: StoredAnchor = {
        ...state,
        merkleRoot: state.merkleRoot.toLowerCase(),
        otsProof: proof,
        otsStatus,
        updatedAt: now(),
      };
      await dependencies.store.save(row);
      return asPublicAnchor(row);
    },
  };
}

const service = createOtsProvenanceService();

export async function getProvenanceAnchor(
  headHash: string,
): Promise<ProvenanceAnchor | undefined> {
  return service.getProvenanceAnchor(headHash);
}

export async function anchorProvenance(
  state: { headHash: string; merkleRoot: string; totalDepth: number },
): Promise<ProvenanceAnchor> {
  return service.anchorProvenance(state);
}