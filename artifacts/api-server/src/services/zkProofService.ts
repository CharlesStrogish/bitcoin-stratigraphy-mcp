import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { publishNip78Attestation } from "./nostrAttestation";
import { loadPoseidon, loadSnarkjs } from "./zkLibraries";

export type ZkPublicInputs = {
  blockHeight: number;
  thermodynamicHash: string;
  timestamp: number;
  valuationSat: number;
  snapshotDigest: string;
};

export type ZkProofPayload = {
  proof: string;
  publicInputs: ZkPublicInputs;
  verificationKeyId: string;
};

const FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);
const BASE_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);
const MAX_SNAPSHOT_BYTES = 1_048_576;
const MAX_FIELD_DIGITS = 77;
const wasmPath = fileURLToPath(
  new URL("./zk/artifacts/telemetry.wasm", import.meta.url),
);
const zkeyPath = fileURLToPath(
  new URL("./zk/artifacts/telemetry_final.zkey", import.meta.url),
);
const verificationKeyUrl = new URL(
  "./zk/artifacts/verification_key.json",
  import.meta.url,
);
const warmupProofUrl = new URL(
  "./zk/artifacts/warmup_proof.json",
  import.meta.url,
);

type Groth16Proof = {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
};

let verificationKeyPromise: Promise<unknown> | undefined;
let verificationKeyIdPromise: Promise<string> | undefined;
let verifierWarmupPromise: Promise<void> | undefined;
const verificationCache = new Map<string, boolean>();
const MAX_VERIFICATION_CACHE_ENTRIES = 1_000;
export type ZkProofLifecycleStatus = {
  status: "verified" | "cached" | "pending" | "invalid";
  verifiedAt: string;
  attestationCount: number;
};
export type ZkProofAttestationRecord = {
  proofHash: string;
  snapshotDigest: string;
  status: ZkProofLifecycleStatus["status"];
  submittedAt: string;
  attestationCount: number;
};
const proofStatusByIdentifier = new Map<string, ZkProofLifecycleStatus>();
const MAX_PROOF_STATUS_ENTRIES = 1_000;
const proofAttestationsByHash = new Map<string, ZkProofAttestationRecord>();
type ArchivedZkProof = {
  kind: "zk-proof";
  hash: string;
  jobId?: string;
  proofPayload: Record<string, unknown>;
  timestamp: string;
  status: ZkProofLifecycleStatus["status"];
};
const proofArchive = new Map<string, ArchivedZkProof>();
const proofHashByJobId = new Map<string, string>();
const MAX_PROOF_ARCHIVE_ENTRIES = 128;

function indexZkProofPayload(
  hash: string,
  proofPayload: Record<string, unknown>,
  timestamp: string,
  jobId?: string,
): void {
  // The HTTP JSON limit and snapshot verifier cap payloads; bound retained process memory too.
  if (Buffer.byteLength(JSON.stringify(proofPayload)) > 2_097_152) {
    throw new RangeError("Proof payload exceeds archive limit");
  }
  const previous = proofArchive.get(hash);
  if (previous?.jobId) proofHashByJobId.delete(previous.jobId);
  proofArchive.delete(hash);
  if (jobId) proofHashByJobId.set(jobId, hash);
  proofArchive.set(hash, {
    kind: "zk-proof",
    hash,
    ...(jobId ? { jobId } : {}),
    proofPayload: structuredClone(proofPayload),
    timestamp,
    status: getZkProofStatus(hash)?.status ?? "pending",
  });
  while (proofArchive.size > MAX_PROOF_ARCHIVE_ENTRIES) {
    const oldestHash = proofArchive.keys().next().value!;
    const oldest = proofArchive.get(oldestHash)!;
    if (oldest.jobId) proofHashByJobId.delete(oldest.jobId);
    proofArchive.delete(oldestHash);
  }
}

export function getZkProofRecord(hash: string): ArchivedZkProof | undefined {
  const normalized =
    proofHashByJobId.get(hash.toLowerCase()) ??
    `0x${hash.replace(/^0x/i, "").toLowerCase()}`;
  const archived = proofArchive.get(normalized);
  if (!archived) return undefined;
  const status = getZkProofStatus(normalized)?.status ?? archived.status;
  return {
    ...archived,
    status,
    proofPayload: structuredClone(archived.proofPayload),
  };
}
const generatedProofCache = new Map<string, Promise<ZkProofPayload>>();
const MAX_GENERATED_PROOF_CACHE_ENTRIES = 256;
const proofLanes = {
  dataset: { queued: 0, tail: Promise.resolve() as Promise<void>, max: 16 },
  stream: { queued: 0, tail: Promise.resolve() as Promise<void>, max: 8 },
};
let queuedVerifications = 0;
let verifierTail: Promise<void> = Promise.resolve();
const MAX_QUEUED_VERIFICATIONS = 32;

export class ZkVerifierOverloadedError extends Error {
  constructor() {
    super("zk verifier queue is full");
    this.name = "ZkVerifierOverloadedError";
  }
}

function verificationCacheKey(payload: {
  proof: string;
  publicInputs: ZkPublicInputs;
  verificationKeyId?: unknown;
}) {
  return createHash("sha256")
    .update(payload.proof)
    .update("\0")
    .update(canonicalize(payload.publicInputs))
    .update("\0")
    .update(
      typeof payload.verificationKeyId === "string"
        ? payload.verificationKeyId
        : "",
    )
    .digest("hex");
}

function cacheVerification(key: string, valid: boolean) {
  verificationCache.delete(key);
  verificationCache.set(key, valid);
  if (verificationCache.size > MAX_VERIFICATION_CACHE_ENTRIES) {
    verificationCache.delete(verificationCache.keys().next().value!);
  }
}

function proofHash(proof: string): string {
  return `0x${createHash("sha256").update(proof).digest("hex")}`;
}

function cacheProofStatus(
  identifiers: string[],
  status: ZkProofLifecycleStatus,
): void {
  for (const identifier of identifiers) {
    proofStatusByIdentifier.delete(identifier);
    proofStatusByIdentifier.set(identifier, status);
  }
  while (proofStatusByIdentifier.size > MAX_PROOF_STATUS_ENTRIES) {
    proofStatusByIdentifier.delete(
      proofStatusByIdentifier.keys().next().value!,
    );
  }
}

export function getZkProofStatus(
  identifier: string,
): ZkProofLifecycleStatus | undefined {
  const status = proofStatusByIdentifier.get(identifier);
  if (!status) return undefined;
  proofStatusByIdentifier.delete(identifier);
  proofStatusByIdentifier.set(identifier, status);
  return { ...status };
}

function indexProofAttestation(record: ZkProofAttestationRecord): void {
  proofAttestationsByHash.delete(record.proofHash);
  proofAttestationsByHash.set(record.proofHash, record);
  while (proofAttestationsByHash.size > MAX_PROOF_STATUS_ENTRIES) {
    proofAttestationsByHash.delete(
      proofAttestationsByHash.keys().next().value!,
    );
  }
}

export function listZkProofAttestations(input: {
  limit: number;
  offset?: number;
  status?: ZkProofLifecycleStatus["status"];
}): { attestations: ZkProofAttestationRecord[]; total: number } {
  const matching = [...proofAttestationsByHash.values()]
    .filter(
      (record) => input.status === undefined || record.status === input.status,
    )
    .reverse();
  return {
    attestations: matching
      .slice(input.offset ?? 0, (input.offset ?? 0) + input.limit)
      .map((record) => ({ ...record })),
    total: matching.length,
  };
}

export async function submitZkProof(input: {
  proof: unknown;
  publicSignals: string[];
  snapshotDigest?: string;
}): Promise<{
  proofHash: string;
  jobId: string;
  status: "verified" | "invalid";
  submittedAt: string;
  attestationStatus: string;
}> {
  const submittedAt = new Date().toISOString();
  const canonicalProof = canonicalize(input.proof);
  const fingerprint = `0x${createHash("sha256")
    .update(canonicalProof)
    .digest("hex")}`;
  const jobId = randomUUID();
  const signalDigest = input.publicSignals[4];
  const identifiers = [
    fingerprint,
    jobId,
    ...(typeof signalDigest === "string" ? [signalDigest] : []),
    ...(input.snapshotDigest ? [input.snapshotDigest] : []),
  ];
  cacheProofStatus(identifiers, {
    status: "pending",
    verifiedAt: submittedAt,
    attestationCount: 0,
  });
  indexProofAttestation({
    proofHash: fingerprint,
    snapshotDigest: input.snapshotDigest ?? signalDigest ?? "",
    status: "pending",
    submittedAt,
    attestationCount: 0,
  });

  const [blockHeight, thermodynamicHash, timestamp, valuationSat, snapshot] =
    input.publicSignals;
  const normalizedProof = {
    ...(input.proof as Record<string, unknown>),
    protocol: "groth16",
    curve: "bn128",
  };
  const payload = {
    proof: base64UrlEncode(JSON.stringify(normalizedProof)),
    publicInputs: {
      blockHeight: Number(blockHeight),
      thermodynamicHash,
      timestamp: Number(timestamp),
      valuationSat: Number(valuationSat),
      snapshotDigest: snapshot,
    },
  };
  const valid =
    input.publicSignals.length === 5 &&
    (input.snapshotDigest === undefined || input.snapshotDigest === snapshot) &&
    (await verifyZkProof(payload));
  let attestationStatus = "not_broadcast_invalid_proof";
  let attestationCount = 0;
  if (valid) {
    attestationStatus = await publishNip78Attestation({
      proofHash: fingerprint,
      publicSignals: input.publicSignals,
      snapshotDigest: input.snapshotDigest ?? snapshot,
      submittedAt,
    });
    attestationCount = attestationStatus === "broadcast_confirmed" ? 1 : 0;
  }
  cacheProofStatus(identifiers, {
    status: valid ? "verified" : "invalid",
    verifiedAt: submittedAt,
    attestationCount,
  });
  indexProofAttestation({
    proofHash: fingerprint,
    snapshotDigest: input.snapshotDigest ?? snapshot ?? "",
    status: valid ? "verified" : "invalid",
    submittedAt,
    attestationCount,
  });
  indexZkProofPayload(
    fingerprint,
    {
      proof: input.proof,
      publicSignals: input.publicSignals,
      ...(input.snapshotDigest ? { snapshotDigest: input.snapshotDigest } : {}),
    },
    submittedAt,
    jobId,
  );
  return {
    proofHash: fingerprint,
    jobId,
    status: valid ? "verified" : "invalid",
    submittedAt,
    attestationStatus,
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function sha256Field(value: string): bigint {
  return (
    BigInt(`0x${createHash("sha256").update(value).digest("hex")}`) %
    FIELD_MODULUS
  );
}

export function zkSnapshotDigest(snapshot: unknown): string {
  const snapshotJson = canonicalize(snapshot);
  if (Buffer.byteLength(snapshotJson, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("zk telemetry snapshot exceeds 1 MiB");
  }
  return sha256Field(snapshotJson).toString();
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 32_768) {
    return undefined;
  }
  try {
    const padded =
      value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function validPublicInputs(value: unknown): value is ZkPublicInputs {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const validInteger = (input: unknown, max: number) =>
    typeof input === "number" &&
    Number.isSafeInteger(input) &&
    input >= 0 &&
    input <= max;
  if (!validInteger(candidate.blockHeight, 2 ** 32 - 1)) return false;
  if (!validInteger(candidate.timestamp, 2 ** 48 - 1)) return false;
  if (!validInteger(candidate.valuationSat, 2 ** 48 - 1)) return false;
  if (
    typeof candidate.snapshotDigest !== "string" ||
    !/^[0-9]+$/.test(candidate.snapshotDigest) ||
    candidate.snapshotDigest.length > MAX_FIELD_DIGITS ||
    BigInt(candidate.snapshotDigest) >= FIELD_MODULUS
  ) {
    return false;
  }
  return (
    typeof candidate.thermodynamicHash === "string" &&
    /^[0-9]+$/.test(candidate.thermodynamicHash) &&
    candidate.thermodynamicHash.length <= MAX_FIELD_DIGITS &&
    BigInt(candidate.thermodynamicHash) < FIELD_MODULUS
  );
}

function validGroth16Proof(value: unknown): value is Groth16Proof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<Groth16Proof>;
  const validCoordinate = (item: unknown) =>
    typeof item === "string" &&
    /^(0|[1-9][0-9]{0,76})$/.test(item) &&
    BigInt(item) < BASE_FIELD_MODULUS;
  return (
    Array.isArray(proof.pi_a) &&
    proof.pi_a.length === 3 &&
    proof.pi_a.every(validCoordinate) &&
    Array.isArray(proof.pi_b) &&
    proof.pi_b.length === 3 &&
    proof.pi_b.every(
      (pair) =>
        Array.isArray(pair) && pair.length === 2 && pair.every(validCoordinate),
    ) &&
    Array.isArray(proof.pi_c) &&
    proof.pi_c.length === 3 &&
    proof.pi_c.every(validCoordinate) &&
    proof.protocol === "groth16" &&
    proof.curve === "bn128"
  );
}

async function prove(
  witness: Record<string, string>,
  laneName: keyof typeof proofLanes,
) {
  const lane = proofLanes[laneName];
  if (lane.queued >= lane.max) {
    throw new Error("zk proof generation queue is full");
  }
  lane.queued += 1;
  const run = lane.tail.then(async () =>
    (await loadSnarkjs()).groth16.fullProve(
      witness,
      wasmPath,
      zkeyPath,
      undefined,
      undefined,
      { singleThread: true },
    ),
  );
  lane.tail = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return (await run) as { proof: Groth16Proof };
  } finally {
    lane.queued -= 1;
  }
}

async function verifyCryptographically(
  publicSignals: string[],
  proof: Groth16Proof,
): Promise<boolean> {
  if (queuedVerifications >= MAX_QUEUED_VERIFICATIONS) {
    throw new ZkVerifierOverloadedError();
  }
  queuedVerifications += 1;
  const run = verifierTail.then(async () => {
    try {
      const { groth16 } = await loadSnarkjs();
      return await groth16.verify(
        await verificationKey(),
        publicSignals,
        proof,
      );
    } finally {
      if (process.env.NODE_ENV === "test") {
        await shutdownZkVerifier();
      }
    }
  });
  verifierTail = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } finally {
    queuedVerifications -= 1;
  }
}

export async function shutdownZkVerifier(): Promise<void> {
  const globals = globalThis as typeof globalThis & {
    curve_bn128?: { terminate(): Promise<void> } | null;
  };
  const curve = globals.curve_bn128;
  globals.curve_bn128 = null;
  await curve?.terminate();
}

async function verificationKey(): Promise<unknown> {
  verificationKeyPromise ??= readFile(verificationKeyUrl, "utf8").then((raw) =>
    JSON.parse(raw),
  );
  return verificationKeyPromise;
}

async function verificationKeyId(): Promise<string> {
  verificationKeyIdPromise ??= readFile(verificationKeyUrl).then(
    (raw) =>
      `zk-telemetry-v1-${createHash("sha256").update(raw).digest("hex")}`,
  );
  return verificationKeyIdPromise;
}

async function generateZkProofUncached(input: {
  snapshot: unknown;
  blockHeight: number;
  timestamp: number;
  valuationMultiplier: number;
  lane?: keyof typeof proofLanes;
}): Promise<ZkProofPayload> {
  if (
    !Number.isSafeInteger(input.blockHeight) ||
    input.blockHeight < 0 ||
    input.blockHeight > 2 ** 32 - 1 ||
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp < 0 ||
    input.timestamp > 2 ** 48 - 1 ||
    !Number.isFinite(input.valuationMultiplier) ||
    input.valuationMultiplier < 0 ||
    input.valuationMultiplier > 2 ** 32 / 1_000_000
  ) {
    throw new Error("Invalid zk telemetry proof inputs");
  }
  const valuationMultiplierMicros = Math.round(
    input.valuationMultiplier * 1_000_000,
  );
  const valuationSat = valuationMultiplierMicros * 100;
  const snapshotDigest = BigInt(zkSnapshotDigest(input.snapshot));
  const { poseidon5 } = await loadPoseidon();
  const thermodynamicHash = poseidon5([
    BigInt(input.blockHeight),
    BigInt(input.timestamp),
    BigInt(valuationSat),
    snapshotDigest,
    BigInt(valuationMultiplierMicros),
  ]).toString();
  const publicInputs = {
    blockHeight: input.blockHeight,
    thermodynamicHash,
    timestamp: input.timestamp,
    valuationSat,
    snapshotDigest: snapshotDigest.toString(),
  };
  const witness = {
    blockHeight: String(input.blockHeight),
    thermodynamicHash,
    timestamp: String(input.timestamp),
    valuationSat: String(valuationSat),
    snapshotDigest: snapshotDigest.toString(),
    snapshotWitnessDigest: snapshotDigest.toString(),
    valuationMultiplier: String(valuationMultiplierMicros),
  };
  const result = await prove(witness, input.lane ?? "dataset");
  const payload = {
    proof: base64UrlEncode(JSON.stringify(result.proof)),
    publicInputs,
    verificationKeyId: await verificationKeyId(),
  };
  const verified = await verifyCryptographically(
    [
      String(publicInputs.blockHeight),
      publicInputs.thermodynamicHash,
      String(publicInputs.timestamp),
      String(publicInputs.valuationSat),
      publicInputs.snapshotDigest,
    ],
    result.proof,
  );
  if (!verified) {
    throw new Error("generated zk telemetry proof failed self-verification");
  }
  cacheVerification(verificationCacheKey(payload), true);
  return payload;
}

export async function generateZkProof(input: {
  snapshot: unknown;
  blockHeight: number;
  timestamp: number;
  valuationMultiplier: number;
  lane?: keyof typeof proofLanes;
}): Promise<ZkProofPayload> {
  const key = [
    input.blockHeight,
    input.timestamp,
    input.valuationMultiplier,
    input.lane ?? "dataset",
    zkSnapshotDigest(input.snapshot),
  ].join(":");
  const cached = generatedProofCache.get(key);
  if (cached) {
    generatedProofCache.delete(key);
    generatedProofCache.set(key, cached);
    return cached;
  }
  const pending = generateZkProofUncached(input);
  generatedProofCache.set(key, pending);
  if (generatedProofCache.size > MAX_GENERATED_PROOF_CACHE_ENTRIES) {
    generatedProofCache.delete(generatedProofCache.keys().next().value!);
  }
  try {
    return await pending;
  } catch (error) {
    generatedProofCache.delete(key);
    throw error;
  }
}

export async function verifyZkProof(payload: unknown): Promise<boolean> {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.proof !== "string" ||
    !validPublicInputs(candidate.publicInputs) ||
    (candidate.verificationKeyId !== undefined &&
      (typeof candidate.verificationKeyId !== "string" ||
        candidate.verificationKeyId !== (await verificationKeyId())))
  ) {
    return false;
  }
  const key = verificationCacheKey({
    proof: candidate.proof,
    publicInputs: candidate.publicInputs,
    verificationKeyId: candidate.verificationKeyId,
  });
  const cached = verificationCache.get(key);
  if (cached !== undefined) {
    verificationCache.delete(key);
    verificationCache.set(key, cached);
    return cached;
  }
  const decoded = base64UrlDecode(candidate.proof);
  if (!decoded) return false;
  let proof: unknown;
  try {
    proof = JSON.parse(decoded);
  } catch {
    return false;
  }
  if (!validGroth16Proof(proof)) return false;
  try {
    const valid = await verifyCryptographically(
      [
        String(candidate.publicInputs.blockHeight),
        candidate.publicInputs.thermodynamicHash,
        String(candidate.publicInputs.timestamp),
        String(candidate.publicInputs.valuationSat),
        candidate.publicInputs.snapshotDigest,
      ],
      proof,
    );
    cacheVerification(key, valid);
    return valid;
  } catch (error) {
    if (error instanceof ZkVerifierOverloadedError) throw error;
    return false;
  }
}

// One verification of the bundled proof loads snarkjs and the verification
// key and builds the bn128 curve, so the first uncached verification after it
// skips that set-up. The pairing runs on the calling thread, so callers keep
// this away from startup. Verification never depends on it having run.
export function prewarmZkVerifier(): Promise<void> {
  verifierWarmupPromise ??= readFile(warmupProofUrl, "utf8")
    .then((raw) => JSON.parse(raw) as unknown)
    .then(async (payload) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("zk verifier warm-up proof is malformed");
      }
      const candidate = payload as Record<string, unknown>;
      if (
        typeof candidate.proof !== "string" ||
        !validPublicInputs(candidate.publicInputs) ||
        candidate.verificationKeyId !== (await verificationKeyId())
      ) {
        throw new Error("zk verifier warm-up proof metadata is invalid");
      }
      const decoded = base64UrlDecode(candidate.proof);
      if (!decoded) throw new Error("zk verifier warm-up proof is malformed");
      const proof = JSON.parse(decoded) as unknown;
      if (!validGroth16Proof(proof)) {
        throw new Error("zk verifier warm-up proof coordinates are invalid");
      }
      const signals = [
        String(candidate.publicInputs.blockHeight),
        candidate.publicInputs.thermodynamicHash,
        String(candidate.publicInputs.timestamp),
        String(candidate.publicInputs.valuationSat),
        candidate.publicInputs.snapshotDigest,
      ];
      if (!(await verifyCryptographically(signals, proof))) {
        throw new Error("zk verifier warm-up proof was rejected");
      }
    })
    .catch((error) => {
      verifierWarmupPromise = undefined;
      throw error;
    });
  return verifierWarmupPromise;
}

function semanticInputsMatch(
  publicInputs: ZkPublicInputs,
  snapshot: unknown,
): boolean {
  const multiplierToValuation = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value * 1_000_000) * 100
      : 0;

  if (Array.isArray(snapshot)) {
    if (snapshot.length === 0 || publicInputs.blockHeight !== 0) return false;
    const last = snapshot.at(-1) as Record<string, unknown> | undefined;
    const quantitative = last?.quantitative_alpha as
      Record<string, unknown> | undefined;
    if (
      publicInputs.valuationSat !==
      multiplierToValuation(quantitative?.target_multiplier)
    ) {
      return false;
    }
    const attestationTimes = snapshot.map((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const attestation = (entry as Record<string, unknown>).attestation as
        Record<string, unknown> | undefined;
      const event = attestation?.event as Record<string, unknown> | undefined;
      return typeof event?.created_at === "number" &&
        Number.isSafeInteger(event.created_at)
        ? event.created_at
        : false;
    });
    return (
      attestationTimes.every((value) => value !== false) &&
      publicInputs.timestamp ===
        Math.max(...(attestationTimes as number[])) * 1_000
    );
  }

  if (!snapshot || typeof snapshot !== "object") return false;
  const record = snapshot as Record<string, unknown>;
  const observedAt = record.observed_at;
  if (
    typeof observedAt !== "string" ||
    Date.parse(observedAt) !== publicInputs.timestamp
  ) {
    return false;
  }
  const block = record.block as Record<string, unknown> | undefined;
  const expectedHeight =
    typeof block?.height === "number" && Number.isSafeInteger(block.height)
      ? block.height
      : 0;
  if (publicInputs.blockHeight !== expectedHeight) return false;
  const thermodynamic = record.thermodynamic as
    Record<string, unknown> | undefined;
  return (
    publicInputs.valuationSat ===
    multiplierToValuation(thermodynamic?.target_multiplier)
  );
}

export async function verifyZkProofForSnapshot(
  payload: unknown,
  snapshot: unknown,
): Promise<boolean> {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  if (!validPublicInputs(candidate.publicInputs)) return false;
  const snapshotDigest = candidate.publicInputs.snapshotDigest;
  const proof = typeof candidate.proof === "string" ? candidate.proof : "";
  const fingerprint = proofHash(proof);
  const submittedAt = new Date().toISOString();
  const identifiers = [snapshotDigest, fingerprint];
  const wasPreviouslyVerified = identifiers.some((identifier) => {
    const prior = proofStatusByIdentifier.get(identifier);
    return prior?.status === "verified" || prior?.status === "cached";
  });
  const attestationCount = Array.isArray(snapshot)
    ? snapshot.filter((entry) =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).attestation,
        ),
      ).length
    : snapshot &&
        typeof snapshot === "object" &&
        (snapshot as Record<string, unknown>).attestation
      ? 1
      : 0;
  cacheProofStatus(identifiers, {
    status: "pending",
    verifiedAt: submittedAt,
    attestationCount,
  });
  indexProofAttestation({
    proofHash: fingerprint,
    snapshotDigest,
    status: "pending",
    submittedAt,
    attestationCount,
  });
  const finish = (valid: boolean): boolean => {
    const status = valid
      ? wasPreviouslyVerified
        ? "cached"
        : "verified"
      : "invalid";
    cacheProofStatus(identifiers, {
      status,
      verifiedAt: new Date().toISOString(),
      attestationCount,
    });
    indexProofAttestation({
      proofHash: fingerprint,
      snapshotDigest,
      status,
      submittedAt,
      attestationCount,
    });
    indexZkProofPayload(
      fingerprint,
      {
        proof: candidate.proof,
        publicInputs: candidate.publicInputs,
        verificationKeyId: candidate.verificationKeyId,
        data: snapshot,
      },
      submittedAt,
    );
    return valid;
  };
  try {
    if (zkSnapshotDigest(snapshot) !== snapshotDigest) {
      return finish(false);
    }
    if (!semanticInputsMatch(candidate.publicInputs, snapshot)) {
      return finish(false);
    }
  } catch {
    return finish(false);
  }
  return finish(await verifyZkProof(payload));
}

export function isZkProofPayload(value: unknown): value is ZkProofPayload {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as ZkProofPayload).proof === "string" &&
    validPublicInputs((value as ZkProofPayload).publicInputs) &&
    typeof (value as ZkProofPayload).verificationKeyId === "string",
  );
}
