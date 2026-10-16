// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { z } from "zod";

const sats = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)));
const otsStatus = z.enum([
  "not_anchored",
  "pending_calendar",
  "bitcoin_block_attested",
]);

// Strip everything not needed for public display, especially payment proofs,
// macaroons and the full receipt / OTS payload. These are not credential caches.
export const ledgerStatsSchema = z.object({
  verified_toll_sats: sats,
  settled_contracts: sats,
  genesis_escrow_id: z.literal("ba4f25dd-7f16-420c-9264-a16f102fd5a6"),
});

export const tollQuoteSchema = z.object({
  toll_fee_sats: sats,
  target_usd: z.number().positive(),
  btc_usd_price: z.number().positive().nullable(),
  source: z.enum(["market", "fallback"]),
  quoted_at: timestamp,
});

export const chainSchema = z.object({
  totalDepth: z.number().int().positive(),
  merkleRoot: hash,
});

export const anchorSchema = z.object({
  merkleRoot: hash,
  otsStatus,
  updatedAt: timestamp.nullable().optional(),
});

export const genesisSchema = z.object({
  settle_response: z.object({
    status: z.literal("SETTLED"),
    merkle_root: hash,
    article_12_receipt: z.object({
      escrow_id: z.literal("ba4f25dd-7f16-420c-9264-a16f102fd5a6"),
      tree_size: z.number().int().positive(),
      leaf_index: sats,
      lightning_settlement: z
        .object({ confirmed_at: timestamp })
        .nullable()
        .optional(),
    }),
  }),
});

export const volumeSchema = z.object({
  totalSats: sats,
  last24hSats: sats,
  l402Sats: sats,
  nip90Sats: sats,
});

export const settlementSchema = z
  .array(
    z.object({
      id: z.string(),
      timestamp,
      channel: z.string(),
      requestKind: z.string(),
      satsReceived: sats,
      paymentReference: z.string().nullable(),
    }),
  )
  .max(5);

export type GenesisTelemetry = z.infer<typeof genesisSchema>;
export type ChainTelemetry = z.infer<typeof chainSchema>;
export type AnchorTelemetry = z.infer<typeof anchorSchema>;
