// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash } from "node:crypto";

export const LATEST_DATASET_DATE = "2026-09-09";
export const LATEST_DATASET_BLOCK = 920_000;
export const BLOCKS_PER_RECORDED_EPOCH = 144;
const DAY_MS = 86_400_000;

type IndexedSourceRecord = {
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

// The source has no native heights, per-record block hash, or ZK proof.
export function snapshotDate(index: number, total: number): string {
  return new Date(
    Date.parse(`${LATEST_DATASET_DATE}T00:00:00.000Z`) -
      (total - index - 1) * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
}

export function snapshotBlock(index: number, total: number): number {
  return LATEST_DATASET_BLOCK - (total - index - 1) * BLOCKS_PER_RECORDED_EPOCH;
}

export function digestRecord(
  record: IndexedSourceRecord,
  index: number,
  total: number,
) {
  const height = snapshotBlock(index, total);
  const date = snapshotDate(index, total);
  const targetMultiplier = record.quantitative_alpha.target_multiplier;
  const recordHash = createHash("sha256")
    .update(
      JSON.stringify([
        record.day,
        record.title,
        record.video_id,
        record.transcript_summary,
        targetMultiplier,
        record.quantitative_alpha.difficulty_epoch_progress,
        record.quantitative_alpha.thermodynamic_signal,
      ]),
    )
    .digest("hex");
  return { height, date, targetMultiplier, recordHash };
}
