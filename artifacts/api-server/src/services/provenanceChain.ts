import { createHash } from "node:crypto";

export const GENESIS_PREV_HASH = "0".repeat(64);

export type ProvenanceSourceRecord = {
  day: number;
  title: string;
  video_id: string;
  transcript_summary: string;
  quantitative_alpha: {
    target_multiplier: number;
    difficulty_epoch_progress: string;
    thermodynamic_signal: string;
  };
};

export type ProvenanceRecord<T extends ProvenanceSourceRecord> = T & {
  prevHash: string;
  stratumHash: string;
};

export type ProvenanceChain<T extends ProvenanceSourceRecord> = {
  records: Array<ProvenanceRecord<T>>;
  totalDepth: number;
  merkleRoot: string;
  genesisHash: string;
  headHash: string;
  verified: boolean;
};

// This is the stratum hash for the canonical, normalized day-1 source record.
// Keep it fixed: an appended source record must never redefine the chain genesis.
const IMMUTABLE_GENESIS_HASH =
  "672b0b2dd8e77d77d4a206d7bcb46860571fd09e766cf456fea845553d82d48f";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Matches stratigraphy-index.ts's canonical record tuple exactly. In particular,
 * this excludes synthetic date and height values, which depend on dataset length.
 */
function sourceFingerprint(record: ProvenanceSourceRecord): string {
  return sha256(
    JSON.stringify([
      record.day,
      record.title,
      record.video_id,
      record.transcript_summary,
      record.quantitative_alpha.target_multiplier,
      record.quantitative_alpha.difficulty_epoch_progress,
      record.quantitative_alpha.thermodynamic_signal,
    ]),
  );
}

function stratumDigest(
  index: number,
  fingerprint: string,
  prevHash: string,
): string {
  return sha256(
    JSON.stringify(["stratigraphy-stratum-v1", index, fingerprint, prevHash]),
  );
}

/**
 * Merkle order is the source order (day ascending). Stratum hashes are the
 * leaves; each parent is SHA256(JSON.stringify(["stratigraphy-merkle-node-v1",
 * leftHash, rightHash])). An unpaired right child duplicates the left child.
 * A single stratum's root is that stratum hash without an extra hashing step.
 */
function merkleRoot(stratumHashes: readonly string[]): string {
  let level = [...stratumHashes];
  while (level.length > 1) {
    const nextLevel: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      nextLevel.push(
        sha256(JSON.stringify(["stratigraphy-merkle-node-v1", left, right])),
      );
    }
    level = nextLevel;
  }
  return level[0];
}

export function buildProvenanceChain<T extends ProvenanceSourceRecord>(
  records: readonly T[],
): ProvenanceChain<T> {
  if (records.length === 0) {
    throw new Error("Cannot build a provenance chain from an empty dataset");
  }

  let previousDay = 0;
  let prevHash = GENESIS_PREV_HASH;
  const chainedRecords: Array<ProvenanceRecord<T>> = [];
  const stratumHashes: string[] = [];

  records.forEach((record, index) => {
    if (
      !Number.isSafeInteger(record.day) ||
      record.day !== previousDay + 1 ||
      typeof record.title !== "string" ||
      typeof record.video_id !== "string" ||
      typeof record.transcript_summary !== "string" ||
      !record.quantitative_alpha ||
      typeof record.quantitative_alpha.target_multiplier !== "number" ||
      !Number.isFinite(record.quantitative_alpha.target_multiplier) ||
      typeof record.quantitative_alpha.difficulty_epoch_progress !== "string" ||
      typeof record.quantitative_alpha.thermodynamic_signal !== "string"
    ) {
      throw new Error(
        `Invalid or non-sequential provenance source record at index ${index}`,
      );
    }

    const fingerprint = sourceFingerprint(record);
    const stratumHash = stratumDigest(index, fingerprint, prevHash);
    const supplied = record as T & {
      prevHash?: unknown;
      stratumHash?: unknown;
    };
    if (
      (Object.prototype.hasOwnProperty.call(record, "prevHash") &&
        supplied.prevHash !== prevHash) ||
      (Object.prototype.hasOwnProperty.call(record, "stratumHash") &&
        supplied.stratumHash !== stratumHash)
    ) {
      throw new Error(`Provenance hash mismatch at index ${index}`);
    }

    if (index === 0 && stratumHash !== IMMUTABLE_GENESIS_HASH) {
      throw new Error(
        "Canonical provenance genesis record does not match the pinned genesis hash",
      );
    }

    chainedRecords.push({ ...record, prevHash, stratumHash });
    stratumHashes.push(stratumHash);
    previousDay = record.day;
    prevHash = stratumHash;
  });

  return {
    records: chainedRecords,
    totalDepth: chainedRecords.length,
    merkleRoot: merkleRoot(stratumHashes),
    genesisHash: IMMUTABLE_GENESIS_HASH,
    headHash: prevHash,
    verified: true,
  };
}
