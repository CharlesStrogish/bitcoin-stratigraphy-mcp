// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash } from "node:crypto";

export class CircuitBreakerError extends Error {
  constructor() {
    super("Maximum authorized thermodynamic spend reached.");
    this.name = "CircuitBreakerError";
  }
}

export function satsString(msats: bigint): string {
  const fraction = (msats % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${msats / 1000n}${fraction ? `.${fraction}` : ""}`;
}

/** Synchronous session reservations include fee headroom for concurrent calls. */
export class SpendCircuit {
  private readonly limit: bigint;
  private readonly reservations = new Map<string, bigint>();
  private reserved = 0n;
  private tripped = false;

  constructor(max_spend_sats = 5000) {
    if (!Number.isSafeInteger(max_spend_sats) || max_spend_sats < 0) {
      throw new Error("INVALID_MAX_SPEND_SATS");
    }
    this.limit = BigInt(max_spend_sats) * 1000n;
  }

  get remainingMsats(): bigint { return this.reserved >= this.limit ? 0n : this.limit - this.reserved; }

  assertCapacity(): void {
    if (this.tripped || this.remainingMsats <= 0n) throw new CircuitBreakerError();
  }

  reserve(hash: string, amount: bigint): { release(): void } | undefined {
    if (this.reservations.has(hash)) return undefined;
    if (this.tripped || amount > this.remainingMsats) {
      this.tripped = true;
      throw new CircuitBreakerError();
    }
    this.reservations.set(hash, amount);
    this.reserved += amount;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.reservations.delete(hash);
      this.reserved -= amount;
    } };
  }

  settle(hash: string, amount: bigint): void {
    const prior = this.reservations.get(hash);
    if (prior === undefined) return;
    this.reserved += amount - prior;
    this.reservations.set(hash, amount);
    if (this.reserved > this.limit) this.tripped = true;
  }
}

export interface PaymentEvidence {
  amountMsats: string;
  preimage: string;
  paymentHash: string;
  settledAt: string | null;
}

/** Payment evidence is NOT a signature over the payload or a Bitcoin anchor. */
export class TruthReceipt<T = unknown> {
  readonly provenance_verified: boolean;
  readonly thermodynamic_cost: string;
  readonly timestamp: string | null;
  readonly cryptographic_proof: string | null;
  readonly payment_hash: string | null;
  readonly evidence_scope: "payment_only" | "payment_not_observed";
  readonly timestamp_kind: "client_observed_settlement" | "receipt_observed" | "unknown";
  readonly payload_sha256: string;

  constructor(readonly payload: T, evidence?: PaymentEvidence | null, provenanceVerified = false) {
    this.provenance_verified = provenanceVerified;
    this.thermodynamic_cost = satsString(BigInt(evidence?.amountMsats ?? "0"));
    this.timestamp = evidence ? evidence.settledAt : new Date().toISOString();
    this.cryptographic_proof = evidence?.preimage ?? null;
    this.payment_hash = evidence?.paymentHash ?? null;
    this.evidence_scope = evidence ? "payment_only" : "payment_not_observed";
    this.timestamp_kind = evidence
      ? evidence.settledAt ? "client_observed_settlement" : "unknown"
      : "receipt_observed";
    // A local digest aids comparison, but it is not a server-signed attestation.
    this.payload_sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }
}
