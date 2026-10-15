import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadPoseidon, loadSnarkjs } from "./zkLibraries";
import { verifyGroth16OffThread } from "./zkVerifierWorker";

const wasmPath = fileURLToPath(
  new URL("./zk/artifacts/drift_js/drift.wasm", import.meta.url),
);
const zkeyPath = fileURLToPath(
  new URL("./zk/artifacts/drift_final.zkey", import.meta.url),
);
const verificationKeyPath = fileURLToPath(
  new URL("./zk/artifacts/drift_verification_key.json", import.meta.url),
);
// This key was generated from a local single-party setup, not a public MPC ceremony.
// Proofs are genuine Groth16 proofs, but setup trust is limited until an independent
// multi-party ceremony replaces this key and publishes independently checked parameters.
const MAX_BLOCK_RESPONSE_BYTES = 32 * 1024;
const BLOCK_REQUEST_TIMEOUT_MS = 5_000;
const MAX_PROOF_QUEUE = 4;
const DEFAULT_ENTROPY_THRESHOLD = 0.85;
const FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);
const BASE_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);
const HASH_256_LIMIT = 1n << 256n;

export type DriftProof = {
  circuit: "zk.drift.v1";
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  publicSignals: string[];
  verificationKeyId: string;
};

type Block = { height: number; hash: string; bits: number };
type DriftDependencies = {
  readBlock?: (height?: number) => Promise<Block>;
};
type Groth16Proof = {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
};

let verificationKeyPromise: Promise<unknown> | undefined;
let verificationKeyIdPromise: Promise<string> | undefined;
let proofQueueTail: Promise<void> = Promise.resolve();
let queuedProofs = 0;

function strictContextHalves(hash: string): { high: bigint; low: bigint } {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(
      "sessionContextHash must be exactly 64 hexadecimal characters",
    );
  }
  return {
    high: BigInt(`0x${hash.slice(0, 32)}`),
    low: BigInt(`0x${hash.slice(32)}`),
  };
}

function parseBlockHeight(value?: number | string): number | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "number" ? String(value) : value;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error("blockHeight must be a non-negative integer");
  }
  const height = Number(text);
  if (!Number.isSafeInteger(height) || height > 0xffff_ffff) {
    throw new Error("blockHeight is outside the supported range");
  }
  return height;
}

function parseThreshold(value?: number): number {
  const threshold = value ?? DEFAULT_ENTROPY_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("entropyThreshold must be between 0 and 1");
  }
  return threshold;
}

function decodeCompactTarget(bits: number): bigint {
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > 0xffff_ffff) {
    throw new Error("Block compact target bits are invalid");
  }
  const exponent = bits >>> 24;
  const mantissa = bits & 0x007f_ffff;
  const negative = (bits & 0x0080_0000) !== 0;
  if (negative || mantissa === 0) {
    throw new Error("Block compact target must encode a positive target");
  }
  const target =
    exponent <= 3
      ? BigInt(mantissa) >> BigInt(8 * (3 - exponent))
      : BigInt(mantissa) << BigInt(8 * (exponent - 3));
  if (target <= 0n || target >= HASH_256_LIMIT) {
    throw new Error("Block compact target is outside the 256-bit range");
  }
  return target;
}

function checkedBlock(value: Block, expectedHeight?: number): Block {
  if (
    !value ||
    !Number.isSafeInteger(value.height) ||
    value.height < 0 ||
    value.height > 0xffff_ffff ||
    (expectedHeight !== undefined && value.height !== expectedHeight) ||
    typeof value.hash !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(value.hash) ||
    !Number.isSafeInteger(value.bits)
  ) {
    throw new Error(
      expectedHeight === undefined
        ? "Block provider returned malformed block data"
        : `Block provider returned height ${String(value?.height)} instead of requested height ${expectedHeight}`,
    );
  }
  const target = decodeCompactTarget(value.bits);
  if (BigInt(`0x${value.hash}`) > target) {
    throw new Error("Block hash does not meet its decoded compact target");
  }
  return {
    height: value.height,
    hash: value.hash.toLowerCase(),
    bits: value.bits,
  };
}

async function boundedFetch(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(BLOCK_REQUEST_TIMEOUT_MS),
    headers: { accept: "application/json, text/plain" },
  });
  if (!response.ok)
    throw new Error(`Bitcoin block API returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BLOCK_RESPONSE_BYTES) {
    throw new Error("Bitcoin block API response exceeds size limit");
  }
  if (!response.body) throw new Error("Bitcoin block API response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BLOCK_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Bitcoin block API response exceeds size limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function readMempoolBlock(height?: number): Promise<Block> {
  const selectedHeight =
    height ??
    Number(
      (
        await boundedFetch("https://mempool.space/api/blocks/tip/height")
      ).trim(),
    );
  if (!Number.isSafeInteger(selectedHeight) || selectedHeight < 0) {
    throw new Error("Bitcoin block API returned an invalid height");
  }
  const blockHash = (
    await boundedFetch(
      `https://mempool.space/api/block-height/${selectedHeight}`,
    )
  ).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new Error("Bitcoin block API returned an invalid block hash");
  }
  const rawBlock = await boundedFetch(
    `https://mempool.space/api/block/${blockHash}`,
  );
  let block: unknown;
  try {
    block = JSON.parse(rawBlock);
  } catch {
    throw new Error("Bitcoin block API returned malformed block details");
  }
  if (!block || typeof block !== "object") {
    throw new Error("Bitcoin block API returned malformed block details");
  }
  const details = block as Record<string, unknown>;
  if (details.id !== blockHash) {
    throw new Error(
      "Bitcoin block API hash does not match its details response",
    );
  }
  return checkedBlock(
    {
      height: Number(details.height),
      hash: blockHash,
      bits: Number(details.bits),
    },
    selectedHeight,
  );
}

async function fetchBlock(
  height: number | undefined,
  deps?: DriftDependencies,
): Promise<Block> {
  const block = deps?.readBlock
    ? await deps.readBlock(height)
    : await readMempoolBlock(height);
  return checkedBlock(block, height);
}

function bitCount(value: bigint): number {
  let remaining = value;
  let count = 0;
  while (remaining !== 0n) {
    remaining &= remaining - 1n;
    count += 1;
  }
  return count;
}

function leadingZeroBits(value: bigint, width = 256): number {
  return value === 0n ? width : width - value.toString(2).length;
}

function asCircuitField(value: bigint): string {
  if (value < 0n || value >= FIELD_MODULUS) {
    throw new Error("Circuit input is outside the BN254 scalar field");
  }
  return value.toString();
}

function computeMetrics(
  contextHash: string,
  block: Block,
  threshold: number,
  poseidon2: (inputs: bigint[]) => bigint,
) {
  const context = strictContextHalves(contextHash);
  const contextValue = (context.high << 128n) | context.low;
  const blockValue = BigInt(`0x${block.hash}`);
  const target = decodeCompactTarget(block.bits);
  const contextOnes = bitCount(contextValue);
  const blockOnes = bitCount(blockValue);
  const contextLeadingZeros = leadingZeroBits(contextValue);
  const targetLeadingZeros = leadingZeroBits(target);
  const driftUnits =
    Math.abs(contextOnes - blockOnes) +
    Math.abs(contextLeadingZeros - targetLeadingZeros);
  const thresholdUnits = Math.floor(threshold * 512);
  const isAligned = driftUnits <= thresholdUnits;
  // This is a bit-balance proxy (distance from maximal digest balance), not physical entropy.
  const thermodynamicEntropyBits = 2 * Math.min(contextOnes, 256 - contextOnes);
  const contextCommitment = poseidon2([context.low, context.high]);
  const publicSignals = [
    // Circom orders public outputs before main's public inputs in snarkjs signals.
    contextCommitment.toString(),
    asCircuitField(BigInt(`0x${block.hash.slice(32)}`)),
    asCircuitField(BigInt(`0x${block.hash.slice(0, 32)}`)),
    String(block.height),
    String(targetLeadingZeros),
    String(thresholdUnits),
    String(driftUnits),
    String(thermodynamicEntropyBits),
    isAligned ? "1" : "0",
  ];
  const witness = {
    blockLow: publicSignals[1],
    blockHigh: publicSignals[2],
    blockHeight: publicSignals[3],
    targetZeroBits: publicSignals[4],
    thresholdUnits: publicSignals[5],
    driftUnits: publicSignals[6],
    entropyBits: publicSignals[7],
    isAligned: publicSignals[8],
    contextLow: context.low.toString(),
    contextHigh: context.high.toString(),
  };
  return {
    contextValue,
    contextOnes,
    blockOnes,
    contextLeadingZeros,
    targetLeadingZeros,
    driftUnits,
    thresholdUnits,
    isAligned,
    thermodynamicEntropyBits,
    publicSignals,
    witness,
  };
}

async function verificationKey(): Promise<unknown> {
  verificationKeyPromise ??= readFile(verificationKeyPath, "utf8").then((raw) =>
    JSON.parse(raw),
  );
  return verificationKeyPromise;
}

async function verificationKeyId(): Promise<string> {
  verificationKeyIdPromise ??= readFile(verificationKeyPath).then(
    (raw) => `zk-drift-v1-${createHash("sha256").update(raw).digest("hex")}`,
  );
  return verificationKeyIdPromise;
}

async function verifyCryptographically(
  publicSignals: string[],
  proof: Groth16Proof,
): Promise<boolean> {
  return verifyGroth16OffThread(await verificationKey(), publicSignals, proof);
}

async function runProof(witness: Record<string, string>): Promise<{
  proof: Groth16Proof;
  publicSignals: string[];
}> {
  if (queuedProofs >= MAX_PROOF_QUEUE) {
    throw new Error("zk drift proof generation queue is full");
  }
  queuedProofs += 1;
  const run = proofQueueTail.then(async () =>
    (await loadSnarkjs()).groth16.fullProve(
      witness,
      wasmPath,
      zkeyPath,
      undefined,
      undefined,
      { singleThread: true },
    ),
  );
  proofQueueTail = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return (await run) as { proof: Groth16Proof; publicSignals: string[] };
  } finally {
    queuedProofs -= 1;
  }
}

function validGroth16Proof(value: unknown): value is Groth16Proof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<Groth16Proof>;
  const validCoordinate = (coordinate: unknown) =>
    typeof coordinate === "string" &&
    /^(0|[1-9][0-9]{0,76})$/.test(coordinate) &&
    BigInt(coordinate) < BASE_FIELD_MODULUS;
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

export async function generateDriftProof(
  input: {
    sessionContextHash: string;
    blockHeight?: number | string;
    entropyThreshold?: number;
  },
  deps?: DriftDependencies,
): Promise<{
  driftScore: number;
  isAligned: boolean;
  targetBlockHeight: number;
  proof: DriftProof;
  thermodynamicEntropyBits: number;
  blockHash: string;
  compactTarget: number;
}> {
  strictContextHalves(input.sessionContextHash);
  const height = parseBlockHeight(input.blockHeight);
  const threshold = parseThreshold(input.entropyThreshold);
  const block = await fetchBlock(height, deps);
  const metrics = computeMetrics(
    input.sessionContextHash,
    block,
    threshold,
    (await loadPoseidon()).poseidon2,
  );
  const generated = await runProof(metrics.witness);
  const keyId = await verificationKeyId();
  const proof: DriftProof = {
    circuit: "zk.drift.v1",
    pi_a: generated.proof.pi_a,
    pi_b: generated.proof.pi_b,
    pi_c: generated.proof.pi_c,
    publicSignals: generated.publicSignals,
    verificationKeyId: keyId,
  };
  const selfVerified = await verifyCryptographically(
    metrics.publicSignals,
    generated.proof,
  );
  if (
    !selfVerified ||
    generated.publicSignals.length !== metrics.publicSignals.length ||
    generated.publicSignals.some(
      (signal, index) => signal !== metrics.publicSignals[index],
    )
  ) {
    throw new Error("generated zk drift proof failed self-verification");
  }
  return {
    driftScore: metrics.driftUnits / 512,
    isAligned: metrics.isAligned,
    targetBlockHeight: block.height,
    proof,
    thermodynamicEntropyBits: metrics.thermodynamicEntropyBits,
    blockHash: block.hash,
    compactTarget: block.bits,
  };
}

export async function verifyDriftProof(
  input: {
    sessionContextHash: string;
    targetBlockHeight: number;
    entropyThreshold: number;
    proof: DriftProof;
    driftScore?: number;
    isAligned?: boolean;
    thermodynamicEntropyBits?: number;
    blockHash?: string;
    compactTarget?: number;
  },
  deps?: DriftDependencies,
): Promise<boolean> {
  let threshold: number;
  try {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.sessionContextHash !== "string" ||
      typeof input.targetBlockHeight !== "number" ||
      typeof input.entropyThreshold !== "number"
    )
      return false;
    strictContextHalves(input.sessionContextHash);
    if (
      !Number.isSafeInteger(input.targetBlockHeight) ||
      input.targetBlockHeight < 0 ||
      input.targetBlockHeight > 0xffff_ffff
    )
      return false;
    threshold = parseThreshold(input.entropyThreshold);
  } catch {
    return false;
  }

  const candidateProof: unknown = input.proof;
  if (!candidateProof || typeof candidateProof !== "object") return false;
  const proof = candidateProof as Partial<DriftProof>;
  if (
    proof.circuit !== "zk.drift.v1" ||
    typeof proof.verificationKeyId !== "string" ||
    !Array.isArray(proof.publicSignals) ||
    proof.publicSignals.length !== 9 ||
    !proof.publicSignals.every((signal) => typeof signal === "string") ||
    !validGroth16Proof({
      pi_a: proof.pi_a,
      pi_b: proof.pi_b,
      pi_c: proof.pi_c,
      protocol: "groth16",
      curve: "bn128",
    }) ||
    (input.driftScore !== undefined &&
      (!Number.isFinite(input.driftScore) ||
        input.driftScore < 0 ||
        input.driftScore > 1)) ||
    (input.isAligned !== undefined && typeof input.isAligned !== "boolean") ||
    (input.thermodynamicEntropyBits !== undefined &&
      (!Number.isSafeInteger(input.thermodynamicEntropyBits) ||
        input.thermodynamicEntropyBits < 0 ||
        input.thermodynamicEntropyBits > 256)) ||
    (input.blockHash !== undefined &&
      (typeof input.blockHash !== "string" ||
        !/^[0-9a-fA-F]{64}$/.test(input.blockHash))) ||
    (input.compactTarget !== undefined &&
      (!Number.isSafeInteger(input.compactTarget) ||
        input.compactTarget < 0 ||
        input.compactTarget > 0xffff_ffff))
  )
    return false;

  // Key-file, provider, and cryptographic errors are operational failures rather
  // than invalid proofs. Let callers surface them as service-unavailable errors.
  const keyId = await verificationKeyId();
  if (proof.verificationKeyId !== keyId) return false;

  const block = await fetchBlock(input.targetBlockHeight, deps);
  if (
    (input.blockHash !== undefined &&
      input.blockHash.toLowerCase() !== block.hash) ||
    (input.compactTarget !== undefined && input.compactTarget !== block.bits)
  )
    return false;
  const metrics = computeMetrics(
    input.sessionContextHash,
    block,
    threshold,
    (await loadPoseidon()).poseidon2,
  );
  if (
    (input.driftScore !== undefined &&
      input.driftScore !== metrics.driftUnits / 512) ||
    (input.isAligned !== undefined && input.isAligned !== metrics.isAligned) ||
    (input.thermodynamicEntropyBits !== undefined &&
      input.thermodynamicEntropyBits !== metrics.thermodynamicEntropyBits) ||
    proof.publicSignals.some(
      (signal, index) => signal !== metrics.publicSignals[index],
    )
  )
    return false;
  const groth16Proof: Groth16Proof = {
    pi_a: proof.pi_a!,
    pi_b: proof.pi_b!,
    pi_c: proof.pi_c!,
    protocol: "groth16",
    curve: "bn128",
  };
  return await verifyCryptographically(metrics.publicSignals, groth16Proof);
}
