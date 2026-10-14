// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Private creator-held redemption capability; never an invoice payment proof. */
export function escrowCapability(secret: string, escrowId: string): string {
  return createHmac("sha256", secret)
    .update(`stratigraphy:escrow:settlement:v1:${escrowId.toLowerCase()}`)
    .digest("hex");
}

export function verifyEscrowCapability(secret: string, escrowId: string, token: unknown): boolean {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token)
    && timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(escrowCapability(secret, escrowId), "hex"));
}
