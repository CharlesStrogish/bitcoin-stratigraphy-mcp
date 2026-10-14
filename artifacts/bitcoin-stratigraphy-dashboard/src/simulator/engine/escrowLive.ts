// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import type {
  EscrowInput, EscrowExecutionInput, EscrowContract, EscrowSettlement,
} from "@workspace/api-client-react";
export const HEX64 = /^[0-9a-f]{64}$/;

export function apiUrl(path: string): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  return `${base}/api${path}`;
}

export type L402Challenge = {
  invoice: string; macaroon: string; payment_hash: string; amount_sats: number; token?: string;
};
export type CreateBody = EscrowInput;
export type SettleBody = EscrowExecutionInput;
export type CreateResult = EscrowContract;
export type SettleResult = EscrowSettlement;

export type CallOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "challenge"; challenge: L402Challenge }
  | { kind: "error"; message: string };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Local check: SHA256(preimage) must equal the challenge payment hash. */
export async function preimageMatches(preimage: string, paymentHash: string): Promise<boolean> {
  if (!HEX64.test(preimage) || !HEX64.test(paymentHash.toLowerCase())) return false;
  return (await sha256Hex(hexToBytes(preimage))) === paymentHash.toLowerCase();
}

function parseChallenge(j: unknown): L402Challenge | null {
  const o = j as Record<string, unknown> | null;
  const macaroon = o?.macaroon ?? o?.token;
  if (!o || typeof o.invoice !== "string" || !o.invoice.startsWith("ln") || typeof macaroon !== "string"
      || !macaroon || typeof o.payment_hash !== "string" || !HEX64.test(o.payment_hash)
      || !Number.isSafeInteger(o.amount_sats) || Number(o.amount_sats) < 1) return null;
  return {
    invoice: o.invoice, macaroon, payment_hash: o.payment_hash,
    amount_sats: o.amount_sats as number, token: typeof o.token === "string" ? o.token : undefined,
  };
}

export async function callEscrow<T>(
  path: "/v1/escrow/create" | "/v1/escrow/settle",
  body: CreateBody | SettleBody,
  operatorToken: string,
  auth: { macaroon: string; preimage: string } | null,
  signal: AbortSignal,
  validate: (j: unknown) => T | null,
  timeoutMs = 20_000,
): Promise<CallOutcome<T>> {
  const c = new AbortController();
  const abort = () => c.abort();
  if (signal.aborted) c.abort();
  signal.addEventListener("abort", abort, { once: true });
  const t = setTimeout(abort, timeoutMs);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (operatorToken.trim()) headers["X-Escrow-Operator-Token"] = operatorToken.trim();
    if (auth) headers.Authorization = `L402 ${auth.macaroon}:${auth.preimage}`;
    const res = await fetch(apiUrl(path), {
      method: "POST", headers, body: JSON.stringify(body), signal: c.signal,
      credentials: "omit", cache: "no-store",
    });
    let j: unknown = null;
    try { j = await res.json(); } catch { j = null; }
    if (res.status === 402) {
      const ch = parseChallenge(j);
      return ch ? { kind: "challenge", challenge: ch } : { kind: "error", message: "Malformed 402 challenge from server" };
    }
    if (res.ok) {
      const v = validate(j);
      return v ? { kind: "ok", data: v } : { kind: "error", message: `Unexpected ${res.status} response shape` };
    }
    const msg = (j as { error?: string; message?: string } | null);
    return { kind: "error", message: `HTTP ${res.status}${msg?.error || msg?.message ? `: ${msg.error ?? msg.message}` : ""}` };
  } catch (e) {
    if (signal.aborted) throw e;
    return { kind: "error", message: c.signal.aborted ? "Request timed out" : (e as Error).message || "Network error" };
  } finally {
    clearTimeout(t);
    signal.removeEventListener("abort", abort);
  }
}

export function validateCreate(j: unknown): CreateResult | null {
  const o = j as Record<string, unknown> | null;
  return o && typeof o.escrow_id === "string" && o.status === "LOCKED" && typeof o.payment_hash === "string"
    && HEX64.test(o.payment_hash) && Number.isSafeInteger(o.amount_sats) && Number(o.amount_sats) > 0
     && Number.isSafeInteger(o.toll_fee_sats) && Number(o.toll_fee_sats) > 0
     && typeof o.settlement_capability === "string" && HEX64.test(o.settlement_capability)
     ? (j as CreateResult) : null;
}
export function validateSettle(j: unknown): SettleResult | null {
  const o = j as Record<string, unknown> | null;
  const receipt = o?.article_12_receipt as SettleResult["article_12_receipt"] | undefined;
  const payment = receipt?.lightning_settlement;
  return o && o.status === "SETTLED" && typeof o.preimage === "string" && HEX64.test(o.preimage)
    && typeof o.merkle_root === "string" && HEX64.test(o.merkle_root)
    && Array.isArray(o.audit_path) && payment && HEX64.test(payment.payment_hash)
    && Number.isSafeInteger(payment.amount_sats) && payment.amount_sats > 0
    && typeof payment.provider === "string" && payment.provider.length > 0
    && typeof payment.confirmed_at === "string" && payment.confirmed_at.length > 0
     && o.ots_calendar_standard === "OpenTimestamps / RFC 6962 SHA-256"
     && receipt.ots_calendar_standard === o.ots_calendar_standard
     && typeof o.attestation_directive === "string"
     && receipt.attestation_directive === o.attestation_directive
    ? (j as SettleResult) : null;
}
