import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../lib/logger";

export type ProvenanceAnchor = {
  headHash: string;
  merkleRoot: string;
  totalDepth: number;
  otsProof: string;
  otsStatus: "pending_calendar" | "bitcoin_block_attested";
  updatedAt: string;
};

type AnchorState = Pick<
  ProvenanceAnchor,
  "headHash" | "merkleRoot" | "totalDepth"
>;
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
// Each stamp attempt submits to one calendar. The CLI waits up to
// STAMP_CALENDAR_WAIT_SECONDS for that calendar's reply; the whole attempt,
// including the CLI's own start-up, is capped at STAMP_ATTEMPT_TIMEOUT_MS.
const STAMP_CALENDAR_WAIT_SECONDS = 5;
const STAMP_ATTEMPT_TIMEOUT_MS = 15_000;
const UPGRADE_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 10_000;
// `ots info` only parses a local receipt, but every CLI run first imports the
// client's whole Python module tree. On a freshly published machine that
// start-up alone took more than 10 seconds, so inspections get a wider limit.
const INSPECT_TIMEOUT_MS = 30_000;
// The background warm-up is a single run that nothing waits on.
const PREWARM_TIMEOUT_MS = 60_000;
const INSPECTION_CACHE_ENTRIES = 128;
/** Standard public calendars, tried in this order until one accepts a stamp. */
export const STAMP_CALENDARS = [
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://alice.btc.calendar.opentimestamps.org",
] as const;
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
    throw new TypeError(
      "Provenance headHash must be a 32-byte hexadecimal hash",
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(state.merkleRoot)) {
    throw new TypeError(
      "Provenance merkleRoot must be a 32-byte hexadecimal hash",
    );
  }
  if (!Number.isSafeInteger(state.totalDepth) || state.totalDepth < 0) {
    throw new TypeError(
      "Provenance totalDepth must be a non-negative safe integer",
    );
  }
}

function digestRootBytes(rootBytes: Buffer): string {
  return createHash("sha256").update(rootBytes).digest("hex");
}

function checkedProof(proof: Buffer): Buffer {
  if (proof.length === 0 || proof.length > MAX_PROOF_BYTES) {
    throw new Error(
      "OpenTimestamps proof is empty or exceeds the maximum size",
    );
  }
  return proof;
}

/** The OpenTimestamps CLI did not finish within its time limit. */
export class OtsCliTimeoutError extends Error {
  constructor() {
    super("OpenTimestamps CLI operation timed out");
    this.name = "OtsCliTimeoutError";
  }
}

/** The OpenTimestamps CLI exited with a failure status. */
export class OtsCliExitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(exitCode: number | null, stderr: string) {
    const excerpt = stderr.slice(0, 1_024);
    super(`OpenTimestamps CLI failed (${exitCode}): ${excerpt}`);
    this.name = "OtsCliExitError";
    this.exitCode = exitCode;
    this.stderr = excerpt;
  }
}

export type CalendarFailure = {
  calendar: string;
  reason: "timed_out" | "no_attestation";
};

/**
 * No calendar accepted a commitment in time. Public calendars are sometimes
 * briefly unreachable, so this is a transient outage, not a fault.
 */
export class OtsCalendarsUnavailableError extends Error {
  readonly failures: readonly CalendarFailure[];

  constructor(failures: readonly CalendarFailure[]) {
    super(
      `No OpenTimestamps calendar accepted the commitment: ${failures
        .map(({ calendar, reason }) => `${calendar} (${reason})`)
        .join(", ")}`,
    );
    this.name = "OtsCalendarsUnavailableError";
    this.failures = failures;
  }
}

// How the CLI reports a calendar that did not reply in time, refused the
// connection or returned an error, before exiting with status 1.
const NO_CALENDAR_ATTESTATION =
  /Failed to create timestamp: need at least \d+ attestations? but received \d+/;

function calendarFailureReason(
  error: unknown,
): CalendarFailure["reason"] | undefined {
  if (error instanceof OtsCliTimeoutError) return "timed_out";
  if (
    error instanceof OtsCliExitError &&
    NO_CALENDAR_ATTESTATION.test(error.stderr)
  ) {
    return "no_attestation";
  }
  return undefined;
}

/**
 * Submits a commitment to each calendar in turn, each attempt with its own
 * time limit, and returns the first receipt. A calendar that times out or
 * gives no attestation is skipped. Any other failure, such as a missing CLI,
 * is not a calendar outage and is thrown at once.
 */
export async function stampWithCalendarFallback(
  attempt: (calendar: string) => Promise<Buffer>,
  calendars: readonly string[] = STAMP_CALENDARS,
): Promise<Buffer> {
  const failures: CalendarFailure[] = [];
  for (const calendar of calendars) {
    try {
      return await attempt(calendar);
    } catch (error) {
      const reason = calendarFailureReason(error);
      if (!reason) throw error;
      failures.push({ calendar, reason });
      logger.info(
        { calendar, reason },
        "OpenTimestamps calendar did not accept the stamp",
      );
    }
  }
  throw new OtsCalendarsUnavailableError(failures);
}

export function otsCliEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // The Nix CLI must use its own dependency closure, not workspace Python packages.
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  return env;
}

function runOts(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ots", ["--no-cache", ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: otsCliEnvironment(),
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
        finish(
          new Error("OpenTimestamps CLI output exceeded the maximum size"),
        );
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new OtsCliTimeoutError());
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0) finish(undefined, stdout);
      else finish(new OtsCliExitError(code, stderr));
    });
  });
}

async function inTempDirectory<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
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

/**
 * Runs the OpenTimestamps CLI once without touching a receipt. `--version`
 * imports the same module tree as every other command, so later CLI calls
 * start from a warm interpreter and file cache.
 */
export async function prewarmOtsCli(): Promise<void> {
  await runOts(["--version"], tmpdir(), PREWARM_TIMEOUT_MS);
}

/**
 * Reuses successful receipt inspections. `ots info` output depends only on
 * the receipt bytes, so results are keyed by their SHA-256; concurrent
 * inspections of the same bytes share one CLI run. Failures, including
 * timeouts and non-approved calendars, are never cached.
 */
export function cacheReceiptInspections(
  inspect: (proof: Buffer) => Promise<string>,
  limit = INSPECTION_CACHE_ENTRIES,
): (proof: Buffer) => Promise<string> {
  const inspections = new Map<string, Promise<string>>();
  return (proof) => {
    const key = createHash("sha256").update(proof).digest("hex");
    const cached = inspections.get(key);
    if (cached) {
      inspections.delete(key);
      inspections.set(key, cached);
      return cached;
    }
    const inspection = inspect(proof);
    inspections.set(key, inspection);
    if (inspections.size > limit) {
      inspections.delete(inspections.keys().next().value!);
    }
    inspection.catch(() => {
      if (inspections.get(key) === inspection) inspections.delete(key);
    });
    return inspection;
  };
}

async function inspectReceiptDigest(proof: Buffer): Promise<string> {
  return inTempDirectory(async (directory) => {
    const proofPath = join(directory, "anchor.ots");
    await writeFile(proofPath, checkedProof(proof), { flag: "wx" });
    const info = await runOts(
      ["info", proofPath],
      directory,
      INSPECT_TIMEOUT_MS,
    );
    const digest = /^File sha256 hash: ([0-9a-f]{64})$/im.exec(info)?.[1];
    if (!digest) {
      throw new Error(
        "OpenTimestamps receipt does not contain a SHA-256 file digest",
      );
    }
    const referencedCalendars: string[] = [
      ...(info.match(/https?:\/\/[^\s]+/g) ?? []),
    ];
    if (
      referencedCalendars.some(
        (url) => !PUBLIC_CALENDAR_SET.has(url.replace(/[\])},.;'"]+$/, "")),
      )
    ) {
      throw new Error(
        "OpenTimestamps receipt references a non-approved calendar",
      );
    }
    return digest;
  });
}

const otsCli: OtsCli = {
  async stamp(rootBytes) {
    return inTempDirectory(async (directory) => {
      let attempts = 0;
      return stampWithCalendarFallback(async (calendar) => {
        // Every attempt stamps a fresh copy of the same bytes: the CLI will
        // not overwrite a receipt left behind by an interrupted attempt.
        attempts += 1;
        const inputPath = join(directory, `merkle-root-${attempts}`);
        await writeFile(inputPath, rootBytes, { flag: "wx" });
        await runOts(
          [
            "stamp",
            "-m",
            "1",
            "--timeout",
            String(STAMP_CALENDAR_WAIT_SECONDS),
            "-c",
            calendar,
            inputPath,
          ],
          directory,
          STAMP_ATTEMPT_TIMEOUT_MS,
        );
        return checkedProof(await readFile(`${inputPath}.ots`));
      });
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
  // Public anchor reads inspect the stored receipt on every request.
  inspectDigest: cacheReceiptInspections(inspectReceiptDigest),
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
  if (
    !hex &&
    (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
  ) {
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
    valid: false,
    status: "unverified",
    blockHeight: null,
    bitcoinHeaderHash: null,
  };
  if (
    digest.toLowerCase() !== targetHash ||
    !(await verifyDigest(proof, targetHash))
  ) {
    return unverified;
  }
  const inspectHeights =
    dependencies.inspectHeights ??
    (async (bytes: Buffer) =>
      inTempDirectory(async (directory) => {
        const proofPath = join(directory, "anchor.ots");
        await writeFile(proofPath, bytes, { flag: "wx" });
        const info = await runOts(
          ["info", proofPath],
          directory,
          INSPECT_TIMEOUT_MS,
        );
        return [
          ...info.matchAll(/BitcoinBlockHeaderAttestation\((\d+)\)/g),
        ].map((match) => Number(match[1]));
      }));
  const heights = [...new Set(await inspectHeights(proof))];
  if (
    heights.length !== 1 ||
    !Number.isSafeInteger(heights[0]) ||
    heights[0]! <= 0
  ) {
    return unverified;
  }
  const height = heights[0]!;
  const readHeaderHash =
    dependencies.readHeaderHash ??
    (async (blockHeight: number) => {
      const response = await fetch(
        `https://mempool.space/api/block-height/${blockHeight}`,
        {
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok)
        throw new Error("Bitcoin header provider is unavailable");
      if (!response.body)
        throw new Error("Bitcoin header provider returned no body");
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 128)
            throw new Error("Bitcoin header response exceeds size limit");
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const value = Buffer.concat(chunks).toString("utf8").trim().toLowerCase();
      if (value.length > 64)
        throw new Error("Bitcoin header response exceeds size limit");
      return value;
    });
  const bitcoinHeaderHash = (await readHeaderHash(height)).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bitcoinHeaderHash)) {
    throw new Error("Bitcoin header provider returned an invalid hash");
  }
  return {
    valid: true,
    status: "bitcoin_block_attested",
    blockHeight: height,
    bitcoinHeaderHash,
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
    if ((await dependencies.cli.inspectDigest(proof)) !== expectedDigest) {
      throw new Error(
        "Stored OpenTimestamps receipt is not bound to its Merkle root",
      );
    }
    if (
      row.otsStatus !== "pending_calendar" &&
      row.otsStatus !== "bitcoin_block_attested"
    ) {
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
    async getProvenanceAnchor(
      headHash: string,
    ): Promise<ProvenanceAnchor | undefined> {
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
        if ((await dependencies.cli.inspectDigest(proof)) !== expectedDigest) {
          throw new Error(
            "Stored OpenTimestamps receipt is not bound to its Merkle root",
          );
        }
        proof = checkedProof(await dependencies.cli.upgrade(proof));
      } else {
        proof = checkedProof(await dependencies.cli.stamp(rootBytes));
      }

      if ((await dependencies.cli.inspectDigest(proof)) !== expectedDigest) {
        throw new Error(
          "OpenTimestamps CLI produced a receipt for a different Merkle root",
        );
      }
      const otsStatus = (await dependencies.cli.verifyDigest(
        proof,
        expectedDigest,
      ))
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

export async function anchorProvenance(state: {
  headHash: string;
  merkleRoot: string;
  totalDepth: number;
}): Promise<ProvenanceAnchor> {
  return service.anchorProvenance(state);
}
