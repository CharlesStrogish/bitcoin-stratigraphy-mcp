// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { randomUUID } from "node:crypto";
import type { pool } from "@workspace/db";

// Additive, namespace-local bootstrap. No migrations of legacy escrow/staking.
export const CLEARING_DDL = `
CREATE TABLE IF NOT EXISTS clearing_contracts (
  escrow_id text PRIMARY KEY,
  request_digest varchar(64) NOT NULL UNIQUE,
  buyer_pubkey varchar(64) NOT NULL,
  worker_pubkey varchar(64) NOT NULL,
  task_hash varchar(64) NOT NULL,
  amount_sats bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  invoice text,
  payment_hash varchar(64) UNIQUE,
  provider text,
  macaroon text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  settlement_receipt text,
  proof_digest varchar(64)
);
ALTER TABLE clearing_contracts ADD COLUMN IF NOT EXISTS settlement_receipt text;
ALTER TABLE clearing_contracts ADD COLUMN IF NOT EXISTS proof_digest varchar(64)`;

export type ClearingContract = {
  escrow_id: string;
  request_digest: string;
  buyer_pubkey: string;
  worker_pubkey: string;
  task_hash: string;
  amount_sats: string;
  status: string;
  invoice: string | null;
  payment_hash: string | null;
  provider: string | null;
  macaroon: string | null;
  expires_at: Date | null;
  settled_at?: Date | null;
  settlement_receipt?: string | null;
  proof_digest?: string | null;
};

export class ClearingContracts {
  private ready?: Promise<unknown>;
  constructor(private readonly database: Pick<typeof pool, "query">) {}

  private async initialize() {
    this.ready ??= this.database.query(CLEARING_DDL).catch((error) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
  }

  async reserve(input: {
    request_digest: string;
    buyer_pubkey: string;
    worker_pubkey: string;
    task_hash: string;
    amount_sats: number;
  }): Promise<{ contract: ClearingContract; inserted: boolean }> {
    await this.initialize();
    const inserted = await this.database.query<ClearingContract>(
      `INSERT INTO clearing_contracts
       (escrow_id, request_digest, buyer_pubkey, worker_pubkey, task_hash, amount_sats)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (request_digest) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        input.request_digest,
        input.buyer_pubkey,
        input.worker_pubkey,
        input.task_hash,
        input.amount_sats,
      ],
    );
    const contract =
      inserted.rows[0] ??
      (
        await this.database.query<ClearingContract>(
          "SELECT * FROM clearing_contracts WHERE request_digest=$1",
          [input.request_digest],
        )
      ).rows[0];
    if (!contract) throw new Error("Clearing reservation unavailable");
    return { contract, inserted: inserted.rowCount === 1 };
  }

  async attachInvoice(
    id: string,
    invoice: {
      invoice: string;
      paymentHash: string;
      provider: string;
      macaroon: string;
      expiresAt: Date;
    },
  ): Promise<ClearingContract> {
    const result = await this.database.query<ClearingContract>(
      `UPDATE clearing_contracts SET invoice=$2,payment_hash=$3,provider=$4,
       macaroon=$5,expires_at=$6 WHERE escrow_id=$1 AND status='pending'
       AND invoice IS NULL RETURNING *`,
      [
        id,
        invoice.invoice,
        invoice.paymentHash,
        invoice.provider,
        invoice.macaroon,
        invoice.expiresAt,
      ],
    );
    if (!result.rows[0]) throw new Error("Clearing invoice reservation lost");
    return result.rows[0];
  }

  async get(id: string): Promise<ClearingContract | undefined> {
    await this.initialize();
    return (
      await this.database.query<ClearingContract>(
        "SELECT * FROM clearing_contracts WHERE escrow_id=$1",
        [id],
      )
    ).rows[0];
  }

  /** Commit the receipt and status together, once. No payout or staking writes. */
  async settleDevelopment(
    contract: ClearingContract,
    proofDigest: string,
    receipt: string,
    settledAt: Date,
  ): Promise<ClearingContract | undefined> {
    await this.initialize();
    const result = await this.database.query<ClearingContract>(
      `UPDATE clearing_contracts
       SET status='settled', settled_at=$2, settlement_receipt=$3, proof_digest=$4
       WHERE escrow_id=$1 AND status='pending'
       AND worker_pubkey=$5 AND task_hash=$6 AND payment_hash=$7
       AND provider=$8 AND amount_sats=$9 AND request_digest=$10
       AND buyer_pubkey=$11 AND invoice=$12 AND macaroon=$13 AND expires_at=$14
       RETURNING *`,
      [
        contract.escrow_id,
        settledAt,
        receipt,
        proofDigest,
        contract.worker_pubkey,
        contract.task_hash,
        contract.payment_hash,
        contract.provider,
        contract.amount_sats,
        contract.request_digest,
        contract.buyer_pubkey,
        contract.invoice,
        contract.macaroon,
        contract.expires_at,
      ],
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await this.get(contract.escrow_id);
    return existing?.status === "settled" &&
      existing.proof_digest === proofDigest &&
      existing.worker_pubkey === contract.worker_pubkey &&
      existing.settlement_receipt
      ? existing
      : undefined;
  }
}
